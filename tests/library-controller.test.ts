import { describe, expect, test } from 'bun:test';
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
	return { http: async () => ({}), httpText: async () => '', getKey: () => '', log: () => {}, notify: () => {} };
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
	test('missing RAWG + Comic Vine keys → one notice each for game/comic, manga/book unaffected', async () => {
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

		await c.syncAll(false, true);

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
