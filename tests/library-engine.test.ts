import { describe, expect, test } from 'bun:test';
import { libraryFolderSync, libraryFolderResolve, type LibraryEngineDeps } from 'packages/obsidian/src/library/LibraryEngine';
import { TmdbRateLimitError } from 'packages/obsidian/src/watchlist/SyncEngine';
import { extractMyNotes } from 'packages/obsidian/src/watchlist/parse';
import type { LibraryNoteCtx, MediaTypeSpec, SpecDeps } from 'packages/obsidian/src/library/types';

const FAKE_ITEM_TYPE = 'fake_item';

function renderFake(fm: Record<string, string>, myNotes: string): string {
	return `---\ntype: ${FAKE_ITEM_TYPE}\nfake_id: ${fm['fake_id'] ?? ''}\nstatus: ${fm['status'] ?? ''}\n---\n\n# Fake\n\n## My Notes\n\n${myNotes}\n`;
}

interface FakeSpecOptions {
	hasId?(fm: Record<string, string>): boolean;
	isActive?(fm: Record<string, string>): boolean;
	sync?(ctx: LibraryNoteCtx, deps: SpecDeps): ReturnType<MediaTypeSpec['sync']>;
	resolve?(ctx: LibraryNoteCtx, deps: SpecDeps): ReturnType<MediaTypeSpec['resolve']>;
	throttleMs?: number;
}

function makeFakeSpec(opts: FakeSpecOptions = {}) {
	const syncCalls: LibraryNoteCtx[] = [];
	const resolveCalls: LibraryNoteCtx[] = [];
	const spec: MediaTypeSpec = {
		typeName: 'manga',
		itemType: FAKE_ITEM_TYPE,
		folderSettingKey: 'fakeFolder',
		enabledSettingKey: 'fakeEnabled',
		throttleMs: opts.throttleMs ?? 111,
		hasId: opts.hasId ?? (fm => !!fm['fake_id']),
		isActive: opts.isActive ?? (fm => fm['status'] !== 'Done'),
		resolve: async (ctx, deps) => {
			resolveCalls.push(ctx);
			return opts.resolve ? await opts.resolve(ctx, deps) : null;
		},
		sync: async (ctx, deps) => {
			syncCalls.push(ctx);
			if (opts.sync) return await opts.sync(ctx, deps);
			return { content: renderFake(ctx.frontmatter, extractMyNotes(ctx.body)), flipped: false };
		},
	};
	return { spec, syncCalls, resolveCalls };
}

const ACTIVE_NOTE = `---
type: fake_item
fake_id: 42
status: Active
---

# Raw Input

## My Notes

keep me
`;

const DONE_NOTE = ACTIVE_NOTE.replace('status: Active', 'status: Done');
const NO_ID_NOTE = ACTIVE_NOTE.replace('fake_id: 42', 'fake_id: ');

function makeDeps(notes: { path: string; content: string }[], specDeps: Partial<SpecDeps> = {}): { deps: LibraryEngineDeps; writes: { path: string; content: string }[]; slept: number[]; contents: Map<string, string> } {
	const contents = new Map(notes.map(n => [n.path, n.content]));
	const writes: { path: string; content: string }[] = [];
	const slept: number[] = [];
	const deps: LibraryEngineDeps = {
		listNotes: async () => notes.map(n => ({ path: n.path })),
		readNote: async path => contents.get(path)!,
		writeNote: async (path, content) => {
			writes.push({ path, content });
		},
		sleep: async ms => {
			slept.push(ms);
		},
		log: () => {},
		specDeps: {
			http: async () => ({}),
			httpText: async () => '',
			getKey: () => '',
			log: () => {},
			notify: () => {},
			...specDeps,
		},
	};
	return { deps, writes, slept, contents };
}

describe('libraryFolderSync: tiering', () => {
	test('hasId false -> skippedNoId, sync not called', async () => {
		const { spec, syncCalls } = makeFakeSpec();
		const { deps } = makeDeps([{ path: 'A.md', content: NO_ID_NOTE }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.skippedNoId).toBe(1);
		expect(syncCalls.length).toBe(0);
	});

	test('inactive + no full -> skippedStatic, sync not called', async () => {
		const { spec, syncCalls } = makeFakeSpec();
		const { deps } = makeDeps([{ path: 'A.md', content: DONE_NOTE }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.skippedStatic).toBe(1);
		expect(syncCalls.length).toBe(0);
	});

	test('full:true overrides inactive tiering -> sync called', async () => {
		const { spec, syncCalls } = makeFakeSpec();
		const { deps } = makeDeps([{ path: 'A.md', content: DONE_NOTE }]);
		const report = await libraryFolderSync(spec, deps, { full: true });
		expect(report.skippedStatic).toBe(0);
		expect(syncCalls.length).toBe(1);
	});
});

describe('libraryFolderSync: diff-on-write + dryRun', () => {
	test('diff-on-write: second pass on rendered output writes nothing', async () => {
		const { spec } = makeFakeSpec();
		const { deps, writes } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		await libraryFolderSync(spec, deps, {});
		expect(writes.length).toBe(1);
		const rendered = writes[0].content;

		const second = makeDeps([{ path: 'A.md', content: rendered }]);
		const report2 = await libraryFolderSync(spec, second.deps, {});
		expect(second.writes.length).toBe(0);
		expect(report2.written).toBe(0);
	});

	test('dryRun: no writeNote call, but written count reflects what would change', async () => {
		const { spec } = makeFakeSpec();
		const { deps, writes } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		const report = await libraryFolderSync(spec, deps, { dryRun: true });
		expect(writes.length).toBe(0);
		expect(report.written).toBe(1);
	});

	test('My Notes preserved through rewrite', async () => {
		const { spec } = makeFakeSpec();
		const { deps, writes } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		await libraryFolderSync(spec, deps, {});
		expect(writes[0].content).toContain('keep me');
	});
});

describe('libraryFolderSync: flip bookkeeping', () => {
	test('spec.sync flipped:true -> report.flipped includes path', async () => {
		const { spec } = makeFakeSpec({
			sync: async ctx => ({ content: renderFake(ctx.frontmatter, extractMyNotes(ctx.body)), flipped: true }),
		});
		const { deps } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.flipped).toEqual(['A.md']);
	});

	test('spec.sync flipped:false -> report.flipped stays empty', async () => {
		const { spec } = makeFakeSpec();
		const { deps } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.flipped).toEqual([]);
	});
});

describe('libraryFolderSync: skippedNoData (null sync result)', () => {
	test('spec.sync returns null -> skippedNoData++, no write, no throw', async () => {
		const { spec } = makeFakeSpec({ sync: async () => null });
		const { deps, writes } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.skippedNoData).toBe(1);
		expect(report.synced).toBe(0);
		expect(writes.length).toBe(0);
		expect(report.errors.length).toBe(0);
	});
});

describe('libraryFolderSync: 429 retry', () => {
	test('spec.sync throws TmdbRateLimitError once -> sleep(retryAfterMs) then retry succeeds', async () => {
		let calls = 0;
		const { spec } = makeFakeSpec({
			sync: async ctx => {
				calls++;
				if (calls === 1) {
					const e = new TmdbRateLimitError('429');
					e.retryAfterMs = 1500;
					throw e;
				}
				return { content: renderFake(ctx.frontmatter, extractMyNotes(ctx.body)), flipped: false };
			},
		});
		const { deps, slept } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(calls).toBe(2);
		expect(slept).toContain(1500);
		expect(report.errors.length).toBe(0);
	});
});

describe('libraryFolderSync: error isolation', () => {
	test('one note errors, others still processed and counted', async () => {
		let n = 0;
		const { spec } = makeFakeSpec({
			sync: async ctx => {
				n++;
				if (n === 1) throw new Error('boom');
				return { content: renderFake(ctx.frontmatter, extractMyNotes(ctx.body)), flipped: false };
			},
		});
		const { deps } = makeDeps([
			{ path: 'Bad.md', content: ACTIVE_NOTE },
			{ path: 'Good.md', content: ACTIVE_NOTE },
		]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.errors.length).toBe(1);
		expect(report.errors[0].path).toBe('Bad.md');
		expect(report.synced).toBe(1);
		expect(report.scanned).toBe(2);
	});
});

describe('libraryFolderSync: fresh-read mid-sync', () => {
	test('content edited mid-sync is re-read fresh, not clobbered by early snapshot', async () => {
		const { spec } = makeFakeSpec();
		const { deps, writes, contents } = makeDeps([
			{ path: 'A.md', content: ACTIVE_NOTE },
			{ path: 'B.md', content: ACTIVE_NOTE },
		]);
		let calls = 0;
		const originalRead = deps.readNote;
		deps.readNote = async path => {
			calls++;
			if (calls === 1) {
				contents.set('B.md', ACTIVE_NOTE.replace('keep me', 'edited during sync'));
			}
			return originalRead(path);
		};
		await libraryFolderSync(spec, deps, {});
		const bWrite = writes.find(w => w.path === 'B.md');
		expect(bWrite?.content).toContain('edited during sync');
		expect(bWrite?.content).not.toContain('keep me');
	});
});

describe('libraryFolderSync: skip rules (underscore / non-entry / stock skeleton)', () => {
	test('`_`-prefixed note skipped entirely, no counters bumped besides scanned', async () => {
		const { spec, syncCalls } = makeFakeSpec();
		const { deps } = makeDeps([{ path: '_Dashboard.md', content: '# dash' }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.scanned).toBe(1);
		expect(report.skippedNoId).toBe(0);
		expect(report.skippedStatic).toBe(0);
		expect(report.skippedNoData).toBe(0);
		expect(report.errors.length).toBe(0);
		expect(syncCalls.length).toBe(0);
	});

	test('type: folder_index (non-entry, non-stock) skipped entirely', async () => {
		const { spec, syncCalls } = makeFakeSpec();
		const note = `---\ntype: folder_index\n---\n\n# Index\n`;
		const { deps } = makeDeps([{ path: 'Index.md', content: note }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(report.scanned).toBe(1);
		expect(report.skippedNoId).toBe(0);
		expect(report.skippedStatic).toBe(0);
		expect(syncCalls.length).toBe(0);
	});

	test('stock skeleton type (e.g. `type: book`) NOT skipped -> reaches hasId/sync gate', async () => {
		const { spec, syncCalls } = makeFakeSpec();
		const note = `---\ntype: book\nfake_id: 42\nstatus: Active\n---\n\nbody\n`;
		const { deps } = makeDeps([{ path: 'Skeleton.md', content: note }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(syncCalls.length).toBe(1);
		expect(report.synced).toBe(1);
	});

	test('stock skeleton without id yet still reaches hasId gate (skippedNoId, not silent skip)', async () => {
		const { spec, syncCalls } = makeFakeSpec();
		const note = `---\ntype: game\nstatus: Active\n---\n\nbody\n`;
		const { deps } = makeDeps([{ path: 'Skeleton.md', content: note }]);
		const report = await libraryFolderSync(spec, deps, {});
		expect(syncCalls.length).toBe(0);
		expect(report.skippedNoId).toBe(1);
	});
});

describe('libraryFolderSync: throttle-after-success', () => {
	test('sleeps spec.throttleMs after a processed note', async () => {
		const { spec } = makeFakeSpec({ throttleMs: 777 });
		const { deps, slept } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		await libraryFolderSync(spec, deps, {});
		expect(slept).toContain(777);
	});

	test('does not sleep for skippedStatic notes', async () => {
		const { spec } = makeFakeSpec({ throttleMs: 777 });
		const { deps, slept } = makeDeps([{ path: 'A.md', content: DONE_NOTE }]);
		await libraryFolderSync(spec, deps, {});
		expect(slept).not.toContain(777);
	});

	test('does not sleep for `_`-prefixed skipped notes', async () => {
		const { spec } = makeFakeSpec({ throttleMs: 777 });
		const { deps, slept } = makeDeps([{ path: '_Dashboard.md', content: '# dash' }]);
		await libraryFolderSync(spec, deps, {});
		expect(slept).not.toContain(777);
	});
});

describe('libraryFolderResolve', () => {
	test('missing id -> spec.resolve patches written via patchFrontmatter', async () => {
		const { spec } = makeFakeSpec({ resolve: async () => ({ fake_id: '99' }) });
		const { deps, writes } = makeDeps([{ path: 'A.md', content: NO_ID_NOTE }]);
		const report = await libraryFolderResolve(spec, deps, {});
		expect(report.resolved).toEqual(['A.md']);
		expect(report.ambiguous).toEqual([]);
		expect(writes.length).toBe(1);
		expect(writes[0].content).toContain('fake_id: 99');
		expect(writes[0].content).toContain('type: fake_item');
	});

	test('ambiguous: spec.resolve returns null -> report.ambiguous, no write', async () => {
		const { spec } = makeFakeSpec({ resolve: async () => null });
		const { deps, writes } = makeDeps([{ path: 'A.md', content: NO_ID_NOTE }]);
		const report = await libraryFolderResolve(spec, deps, {});
		expect(report.ambiguous).toEqual(['A.md']);
		expect(report.resolved).toEqual([]);
		expect(writes.length).toBe(0);
	});

	test('hasId already true -> resolve() not called, note excluded from both lists', async () => {
		const { spec, resolveCalls } = makeFakeSpec({ resolve: async () => ({ fake_id: '99' }) });
		const { deps } = makeDeps([{ path: 'A.md', content: ACTIVE_NOTE }]);
		const report = await libraryFolderResolve(spec, deps, {});
		expect(resolveCalls.length).toBe(0);
		expect(report.resolved).toEqual([]);
		expect(report.ambiguous).toEqual([]);
	});

	test('dryRun: resolved counted but no writeNote call', async () => {
		const { spec } = makeFakeSpec({ resolve: async () => ({ fake_id: '99' }) });
		const { deps, writes } = makeDeps([{ path: 'A.md', content: NO_ID_NOTE }]);
		const report = await libraryFolderResolve(spec, deps, { dryRun: true });
		expect(report.resolved).toEqual(['A.md']);
		expect(writes.length).toBe(0);
	});

	test('error isolation: one note throws, other still resolved', async () => {
		let n = 0;
		const { spec } = makeFakeSpec({
			resolve: async () => {
				n++;
				if (n === 1) throw new Error('boom');
				return { fake_id: '99' };
			},
		});
		const { deps } = makeDeps([
			{ path: 'Bad.md', content: NO_ID_NOTE },
			{ path: 'Good.md', content: NO_ID_NOTE },
		]);
		const report = await libraryFolderResolve(spec, deps, {});
		expect(report.errors.length).toBe(1);
		expect(report.errors[0].path).toBe('Bad.md');
		expect(report.resolved).toEqual(['Good.md']);
	});

	test('`_`-prefixed / non-entry notes excluded from resolve pass', async () => {
		const { spec, resolveCalls } = makeFakeSpec({ resolve: async () => ({ fake_id: '99' }) });
		const note = `---\ntype: folder_index\n---\n\n# Index\n`;
		const { deps } = makeDeps([{ path: 'Index.md', content: note }]);
		const report = await libraryFolderResolve(spec, deps, {});
		expect(resolveCalls.length).toBe(0);
		expect(report.resolved).toEqual([]);
		expect(report.ambiguous).toEqual([]);
	});

	test('429 retry: spec.resolve throws TmdbRateLimitError once then succeeds', async () => {
		let calls = 0;
		const { spec } = makeFakeSpec({
			resolve: async () => {
				calls++;
				if (calls === 1) {
					const e = new TmdbRateLimitError('429');
					e.retryAfterMs = 1200;
					throw e;
				}
				return { fake_id: '99' };
			},
		});
		const { deps, slept } = makeDeps([{ path: 'A.md', content: NO_ID_NOTE }]);
		const report = await libraryFolderResolve(spec, deps, {});
		expect(calls).toBe(2);
		expect(slept).toContain(1200);
		expect(report.resolved).toEqual(['A.md']);
	});
});
