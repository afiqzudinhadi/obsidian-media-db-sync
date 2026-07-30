import { describe, expect, test } from 'bun:test';
import { WatchlistController, shouldNotifySync } from 'packages/obsidian/src/watchlist/WatchlistController';
import type { SyncDeps } from 'packages/obsidian/src/watchlist/SyncEngine';

function fakePlugin(overrides: Partial<{ enabled: boolean; last: number; hours: number }> = {}) {
	return {
		settings: {
			watchlistEnabled: overrides.enabled ?? true,
			watchlistLastSync: overrides.last ?? 0,
			watchlistSyncIntervalHours: overrides.hours ?? 24,
			watchlistFolder: 'Watchlist',
			TMDBKeyId: 'kid',
		},
		saveSettings: async () => {},
		app: {},
	} as any;
}

describe('maybeCatchUp', () => {
	test('overdue → syncs', async () => {
		const c = new WatchlistController(fakePlugin({ last: 0 }));
		let called = false;
		(c as any).syncNow = async () => { called = true; return {} as any; };
		await c.maybeCatchUp();
		expect(called).toBe(true);
	});
	test('recent sync → no call', async () => {
		const c = new WatchlistController(fakePlugin({ last: Date.now() }));
		let called = false;
		(c as any).syncNow = async () => { called = true; return {} as any; };
		await c.maybeCatchUp();
		expect(called).toBe(false);
	});
	test('disabled → no call', async () => {
		const c = new WatchlistController(fakePlugin({ enabled: false, last: 0 }));
		let called = false;
		(c as any).syncNow = async () => { called = true; return {} as any; };
		await c.maybeCatchUp();
		expect(called).toBe(false);
	});
});

function deferredDeps(): { deps: SyncDeps; listNotesCalls: () => number; release: () => void } {
	let listNotesCalls = 0;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const deps: SyncDeps = {
		listNotes: async () => { listNotesCalls++; await gate; return []; },
		readNote: async () => '',
		writeNote: async () => {},
		fetchDetail: async () => ({}),
		sleep: async () => {},
		log: () => {},
	};
	return { deps, listNotesCalls: () => listNotesCalls, release };
}

describe('concurrency guard', () => {
	test('overlapping syncNow calls: second short-circuits while first is in flight', async () => {
		const c = new WatchlistController(fakePlugin());
		const { deps, listNotesCalls, release } = deferredDeps();
		(c as any).getKey = () => 'fake-key';
		(c as any).makeDeps = () => deps;

		const first = c.syncNow(false);
		const second = await c.syncNow(false);

		expect(listNotesCalls()).toBe(1);
		expect(second.scanned).toBe(0);
		expect(second.written).toBe(0);

		release();
		const firstResult = await first;
		expect(firstResult.scanned).toBe(0);
	});

	test('syncNow in flight blocks resolveMissingIds (shared guard)', async () => {
		const c = new WatchlistController(fakePlugin());
		const { deps, release } = deferredDeps();
		(c as any).getKey = () => 'fake-key';
		(c as any).makeDeps = () => deps;

		const first = c.syncNow(false);
		const resolveResult = await c.resolveMissingIds();

		expect(resolveResult.scanned).toBe(0);
		expect(resolveResult.resolved).toBe(0);

		release();
		await first;
	});

	test('flag resets after completion → next call runs normally', async () => {
		const c = new WatchlistController(fakePlugin());
		(c as any).getKey = () => 'fake-key';
		let listNotesCalls = 0;
		(c as any).makeDeps = () => ({
			listNotes: async () => { listNotesCalls++; return []; },
			readNote: async () => '',
			writeNote: async () => {},
			fetchDetail: async () => ({}),
			sleep: async () => {},
			log: () => {},
		});

		await c.syncNow(false);
		await c.syncNow(false);

		expect(listNotesCalls).toBe(2);
	});
});

describe('shouldNotifySync', () => {
	test('non-quiet → always notifies', () => expect(shouldNotifySync(false, 0, 0)).toBe(true));
	test('quiet + no changes + no errors → suppressed', () => expect(shouldNotifySync(true, 0, 0)).toBe(false));
	test('quiet + written>0 → notifies', () => expect(shouldNotifySync(true, 3, 0)).toBe(true));
	test('quiet + errors>0 → notifies', () => expect(shouldNotifySync(true, 0, 2)).toBe(true));
});
