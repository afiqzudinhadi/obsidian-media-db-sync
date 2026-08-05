import { describe, expect, test } from 'bun:test';
import type { MediaTypeSpec } from 'packages/obsidian/src/library/types';
import { bookSpec } from 'packages/obsidian/src/library/book';
import { gameSpec } from 'packages/obsidian/src/library/game';
import { LibraryController } from 'packages/obsidian/src/library/LibraryController';
import type { LibraryEngineDeps } from 'packages/obsidian/src/library/LibraryEngine';
import { mangaSpec } from 'packages/obsidian/src/library/manga';

function fakePlugin(
	overrides: Partial<{
		mangaEnabled: boolean;
		bookEnabled: boolean;
		gameEnabled: boolean;
		comicEnabled: boolean;
		last: number;
		hours: number;
		rawgKeyId: string;
		comicvineKeyId: string;
	}> = {},
) {
	const secrets: Record<string, string> = {};
	if (overrides.rawgKeyId) secrets[overrides.rawgKeyId] = 'rawg-secret';
	if (overrides.comicvineKeyId) secrets[overrides.comicvineKeyId] = 'cv-secret';
	return {
		settings: {
			libraryMangaEnabled: overrides.mangaEnabled ?? true,
			libraryMangaFolder: 'Mangas',
			libraryBookEnabled: overrides.bookEnabled ?? true,
			libraryBookFolder: 'Books',
			libraryGameEnabled: overrides.gameEnabled ?? true,
			libraryGameFolder: 'Games',
			libraryComicEnabled: overrides.comicEnabled ?? true,
			libraryComicFolder: 'Comics',
			libraryLastSync: overrides.last ?? 0,
			watchlistSyncIntervalHours: overrides.hours ?? 24,
			RAWGAPIKeyId: overrides.rawgKeyId ?? '',
			ComicVineKeyId: overrides.comicvineKeyId ?? '',
		},
		saveSettings: async () => {},
		app: {
			secretStorage: { getSecret: (id: string) => secrets[id] ?? null },
			vault: {},
		},
	} as any;
}

describe('maybeCatchUp', () => {
	test('overdue → syncs', async () => {
		const c = new LibraryController(fakePlugin({ last: 0 }));
		let called = false;
		(c as any).syncAll = async () => {
			called = true;
		};
		await c.maybeCatchUp();
		expect(called).toBe(true);
	});

	test('recent sync → no call', async () => {
		const c = new LibraryController(fakePlugin({ last: Date.now() }));
		let called = false;
		(c as any).syncAll = async () => {
			called = true;
		};
		await c.maybeCatchUp();
		expect(called).toBe(false);
	});

	test('all types disabled → no call', async () => {
		const c = new LibraryController(fakePlugin({ mangaEnabled: false, bookEnabled: false, gameEnabled: false, comicEnabled: false, last: 0 }));
		let called = false;
		(c as any).syncAll = async () => {
			called = true;
		};
		await c.maybeCatchUp();
		expect(called).toBe(false);
	});
});

function fakeSpecDeps() {
	return { http: async () => ({}), httpText: async () => '', httpPostJson: async () => ({}), getKey: () => '', log: () => {}, notify: () => {} };
}

function deferredDeps(): { deps: LibraryEngineDeps; listNotesCalls: () => number; release: () => void } {
	let listNotesCalls = 0;
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const deps: LibraryEngineDeps = {
		listNotes: async () => {
			listNotesCalls++;
			await gate;
			return [];
		},
		readNote: async () => '',
		writeNote: async () => {},
		sleep: async () => {},
		log: () => {},
		specDeps: fakeSpecDeps(),
	};
	return { deps, listNotesCalls: () => listNotesCalls, release };
}

describe('concurrency guard', () => {
	test('overlapping syncType calls: second short-circuits while first is in flight', async () => {
		const c = new LibraryController(fakePlugin());
		const { deps, listNotesCalls, release } = deferredDeps();
		(c as any).makeDeps = () => deps;

		const first = c.syncType(mangaSpec, false);
		const second = await c.syncType(mangaSpec, false);

		expect(listNotesCalls()).toBe(1);
		expect(second.scanned).toBe(0);
		expect(second.written).toBe(0);

		release();
		const firstResult = await first;
		expect(firstResult.scanned).toBe(0);
	});

	test('syncType in flight blocks resolveType (shared guard)', async () => {
		const c = new LibraryController(fakePlugin());
		const { deps, release } = deferredDeps();
		(c as any).makeDeps = () => deps;

		const first = c.syncType(mangaSpec, false);
		const resolveResult = await c.resolveType(bookSpec);

		expect(resolveResult.resolved.length).toBe(0);
		expect(resolveResult.ambiguous.length).toBe(0);

		release();
		await first;
	});

	test('syncType in flight blocks syncAll (shared guard)', async () => {
		const c = new LibraryController(fakePlugin());
		const { deps, release } = deferredDeps();
		(c as any).makeDeps = () => deps;

		const first = c.syncType(mangaSpec, false);
		await c.syncAll(false, true); // should short-circuit, not throw

		release();
		await first;
	});

	test('flag resets after completion → next call runs normally', async () => {
		const c = new LibraryController(fakePlugin());
		let listNotesCalls = 0;
		(c as any).makeDeps = () => ({
			listNotes: async () => {
				listNotesCalls++;
				return [];
			},
			readNote: async () => '',
			writeNote: async () => {},
			sleep: async () => {},
			log: () => {},
			specDeps: fakeSpecDeps(),
		});

		await c.syncType(mangaSpec, false);
		await c.syncType(mangaSpec, false);

		expect(listNotesCalls).toBe(2);
	});
});

describe('missing API key handling', () => {
	test('missing RAWG + Comic Vine keys + quiet sync → zero notices, logged only', async () => {
		const c = new LibraryController(fakePlugin()); // no rawgKeyId/comicvineKeyId configured
		const notices: string[] = [];
		const logs: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		const calledTypes: string[] = [];
		(c as any).makeDeps = (spec: { typeName: string }) => {
			calledTypes.push(spec.typeName);
			return {
				listNotes: async () => [],
				readNote: async () => '',
				writeNote: async () => {},
				sleep: async () => {},
				log: () => {},
				specDeps: fakeSpecDeps(),
			};
		};

		const origLog = console.log;
		console.log = (msg: string) => {
			logs.push(msg);
			origLog(msg);
		};

		try {
			await c.syncAll(false, true);
		} finally {
			console.log = origLog;
		}

		expect(calledTypes.sort()).toEqual(['book', 'comic', 'game', 'manga']);
		const keyNotices = notices.filter(m => m.includes('API key not configured'));
		expect(keyNotices.length).toBe(0);
		const keyLogs = logs.filter(m => m.includes('API key not configured'));
		expect(keyLogs.length).toBe(2);
		expect(keyLogs.some(m => m.includes('RAWG') && m.includes('game'))).toBe(true);
		expect(keyLogs.some(m => m.includes('Comic Vine') && m.includes('comic'))).toBe(true);
	});

	test('missing RAWG + Comic Vine keys + manual (non-quiet) sync → one notice each for game/comic', async () => {
		const c = new LibraryController(fakePlugin()); // no rawgKeyId/comicvineKeyId configured
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		const calledTypes: string[] = [];
		(c as any).makeDeps = (spec: { typeName: string }) => {
			calledTypes.push(spec.typeName);
			return {
				listNotes: async () => [],
				readNote: async () => '',
				writeNote: async () => {},
				sleep: async () => {},
				log: () => {},
				specDeps: fakeSpecDeps(),
			};
		};

		await c.syncAll(false, false);

		expect(calledTypes.sort()).toEqual(['book', 'comic', 'game', 'manga']);
		const keyNotices = notices.filter(m => m.includes('API key not configured'));
		expect(keyNotices.length).toBe(2);
		expect(keyNotices.some(m => m.includes('RAWG') && m.includes('game'))).toBe(true);
		expect(keyNotices.some(m => m.includes('Comic Vine') && m.includes('comic'))).toBe(true);
	});

	test('keys present → no missing-key notices', async () => {
		const c = new LibraryController(fakePlugin({ rawgKeyId: 'rid', comicvineKeyId: 'cvid' }));
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		(c as any).makeDeps = () => ({
			listNotes: async () => [],
			readNote: async () => '',
			writeNote: async () => {},
			sleep: async () => {},
			log: () => {},
			specDeps: fakeSpecDeps(),
		});

		await c.syncAll(false, true);

		expect(notices.filter(m => m.includes('API key not configured')).length).toBe(0);
	});

	test('single-type sync (game) with missing RAWG key still notifies once and runs', async () => {
		const c = new LibraryController(fakePlugin({ rawgKeyId: '' }));
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		let ran = false;
		(c as any).makeDeps = () => {
			ran = true;
			return {
				listNotes: async () => [],
				readNote: async () => '',
				writeNote: async () => {},
				sleep: async () => {},
				log: () => {},
				specDeps: fakeSpecDeps(),
			};
		};

		await c.syncType(gameSpec, false);

		expect(ran).toBe(true);
		expect(notices.filter(m => m.includes('API key not configured')).length).toBe(1);
	});
});

describe('syncAll error isolation (I5)', () => {
	test('first spec throws (e.g. missing vault folder) -> remaining specs still synced, lastSync updated', async () => {
		const c = new LibraryController(fakePlugin());
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		const calledTypes: string[] = [];
		(c as any).makeDeps = (spec: { typeName: string }) => {
			calledTypes.push(spec.typeName);
			if (spec.typeName === 'manga') {
				return {
					listNotes: async () => {
						throw new Error('Library folder not found: Mangas');
					},
					readNote: async () => '',
					writeNote: async () => {},
					sleep: async () => {},
					log: () => {},
					specDeps: fakeSpecDeps(),
				};
			}
			return {
				listNotes: async () => [],
				readNote: async () => '',
				writeNote: async () => {},
				sleep: async () => {},
				log: () => {},
				specDeps: fakeSpecDeps(),
			};
		};

		const before = (c as any).plugin.settings.libraryLastSync;
		await c.syncAll(false, false);

		// manga (first in LIBRARY_TYPES) threw, but book/game/comic still got their turn
		expect(calledTypes.sort()).toEqual(['book', 'comic', 'game', 'manga']);
		expect(notices.some(m => m.includes('Library sync failed for manga'))).toBe(true);
		expect((c as any).plugin.settings.libraryLastSync).toBeGreaterThan(before);
	});

	test('quiet sync: per-type failure logged only, no Notice', async () => {
		const c = new LibraryController(fakePlugin());
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (msg: string) => {
			logs.push(msg);
		};
		(c as any).makeDeps = (spec: { typeName: string }) => ({
			listNotes: async () => {
				if (spec.typeName === 'book') throw new Error('boom');
				return [];
			},
			readNote: async () => '',
			writeNote: async () => {},
			sleep: async () => {},
			log: () => {},
			specDeps: fakeSpecDeps(),
		});

		try {
			await c.syncAll(false, true);
		} finally {
			console.log = origLog;
		}

		expect(notices.some(m => m.includes('Library sync failed for book'))).toBe(false);
		expect(logs.some(m => m.includes('Library sync failed for book'))).toBe(true);
	});
});

describe('dry-run notify suppression (minor)', () => {
	test('makeSpecDeps(dryRun=true) -> notify logs instead of raising a Notice', () => {
		const c = new LibraryController(fakePlugin());
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (msg: string) => {
			logs.push(msg);
		};
		try {
			const specDeps = (c as any).makeSpecDeps(true);
			specDeps.notify('«Test Manga» ch. 5 out');
		} finally {
			console.log = origLog;
		}
		expect(notices).toEqual([]);
		expect(logs.some(m => m.includes('«Test Manga» ch. 5 out'))).toBe(true);
	});

	test('makeSpecDeps(dryRun=false) -> notify raises a Notice normally', () => {
		const c = new LibraryController(fakePlugin());
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		const specDeps = (c as any).makeSpecDeps(false);
		specDeps.notify('«Test Manga» ch. 5 out');
		expect(notices).toEqual(['«Test Manga» ch. 5 out']);
	});

	test('dry-run manga flip scenario end-to-end: syncType(dryRun=true) -> no Notice, log entry present', async () => {
		const c = new LibraryController(fakePlugin());
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (msg: string) => {
			logs.push(msg);
		};

		const flipSpec = {
			typeName: 'manga' as const,
			itemType: 'manga_item',
			folderSettingKey: 'libraryMangaFolder',
			enabledSettingKey: 'libraryMangaEnabled',
			throttleMs: 0,
			hasId: () => true,
			isActive: () => true,
			resolve: async () => null,
			sync: async (_ctx: unknown, deps: { notify: (msg: string) => void }) => {
				deps.notify('«Test Manga» ch. 5 out');
				return { content: 'updated content', flipped: true };
			},
		};

		(c as any).makeDeps = (spec: unknown, dryRun: boolean) => ({
			listNotes: async () => [{ path: 'Mangas/Test Manga.md' }],
			readNote: async () => 'orig content',
			writeNote: async () => {},
			sleep: async () => {},
			log: () => {},
			specDeps: (c as any).makeSpecDeps(dryRun),
		});

		try {
			await c.syncType(flipSpec as any, false, true); // dryRun = true
		} finally {
			console.log = origLog;
		}

		// the run-summary Notice (dry-run or not) is unrelated existing behavior and still fires;
		// what must NOT happen is the spec's flip-notify reaching a real Notice
		expect(notices.some(m => m.includes('«Test Manga» ch. 5 out'))).toBe(false);
		expect(logs.some(m => m.includes('«Test Manga» ch. 5 out'))).toBe(true);
	});
});

describe('sync summary transparency', () => {
	test('scanned + no-data counts surface in summary notice, not hidden behind a silent-looking 0/0', async () => {
		const c = new LibraryController(fakePlugin());
		const notices: string[] = [];
		(c as any).notify = (msg: string) => notices.push(msg);
		(c as any).makeDeps = () => ({
			listNotes: async () => [{ path: 'Mangas/Test.md' }],
			readNote: async () => 'content',
			writeNote: async () => {},
			sleep: async () => {},
			log: () => {},
			specDeps: fakeSpecDeps(),
		});

		// simulates e.g. a Comic Vine error-envelope: fetch "succeeds" (no throw) but spec.sync
		// has no usable data -> counted as skippedNoData rather than a written/errors change
		const noDataSpec: MediaTypeSpec = {
			typeName: 'manga',
			itemType: 'manga_item',
			folderSettingKey: 'libraryMangaFolder',
			enabledSettingKey: 'libraryMangaEnabled',
			throttleMs: 0,
			hasId: () => true,
			isActive: () => true,
			resolve: async () => null,
			sync: async () => null,
		};

		const report = await c.syncType(noDataSpec, false);

		expect(report.scanned).toBe(1);
		expect(report.skippedNoData).toBe(1);
		expect(notices.length).toBe(1);
		expect(notices[0]).toContain('1 scanned');
		expect(notices[0]).toContain('0 ok');
		expect(notices[0]).toContain('1 no-data (see console)');
	});
});
