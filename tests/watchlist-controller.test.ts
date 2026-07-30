import { describe, expect, test } from 'bun:test';
import { WatchlistController } from 'packages/obsidian/src/watchlist/WatchlistController';

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
