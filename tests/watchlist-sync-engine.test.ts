import { describe, expect, test } from 'bun:test';
import { syncFolder, isActive, TmdbRateLimitError, withRateLimitRetry, type SyncDeps } from 'packages/obsidian/src/watchlist/SyncEngine';
import tvDetail from 'tests/fixtures/tmdb-tv-loki.json';

const ENDED_NOTE = `---
type: watchlist_item
media_type: TV Series
watch_status: Watched
rating: 5
rating_stars: ⭐️⭐️⭐️⭐️⭐️
status: Ended
tmdb_id: 84958
last_air_date: 2023-11-09
---

# Loki

## My Notes

keep me
`;

const AIRING_NOTE = ENDED_NOTE.replace('status: Ended', 'status: Returning Series').replace('last_air_date: 2023-11-09', 'last_air_date: 2023-10-01');

const NOTE_WITH_COLLECTION = ENDED_NOTE.replace('## My Notes', '## Collection\nPart of [[Movies]]\n\n## My Notes');

const NOTE_WITH_TWO_CUSTOM_SECTIONS = ENDED_NOTE.replace(
	'## My Notes',
	'## Collection\nPart of [[Movies]]\n\n## Rewatch Log\n- 2024-01-01\n- 2025-02-02\n\n## My Notes',
);

function makeDeps(notes: { path: string; content: string }[], detail: any = tvDetail) {
	const contents = new Map(notes.map(n => [n.path, n.content]));
	const writes: { path: string; content: string }[] = [];
	const fetches: string[] = [];
	const deps: SyncDeps = {
		listNotes: async () => notes.map(n => ({ path: n.path })),
		readNote: async path => contents.get(path)!,
		writeNote: async (path, content) => { writes.push({ path, content }); },
		fetchDetail: async (id) => { fetches.push(id); return detail; },
		sleep: async () => {},
		log: () => {},
	};
	return { deps, writes, fetches, contents };
}

describe('withRateLimitRetry', () => {
	test('429 → sleep(retryAfterMs) then retry once, returns result', async () => {
		const slept: number[] = [];
		let calls = 0;
		const fn = async () => {
			calls++;
			if (calls === 1) {
				const e = new TmdbRateLimitError('429');
				e.retryAfterMs = 1500;
				throw e;
			}
			return 'ok';
		};
		const result = await withRateLimitRetry(fn, async ms => { slept.push(ms); });
		expect(slept).toEqual([1500]);
		expect(calls).toBe(2);
		expect(result).toBe('ok');
	});
	test('non-429 error → no retry, throws immediately', async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			throw new Error('boom');
		};
		await expect(withRateLimitRetry(fn, async () => {})).rejects.toThrow('boom');
		expect(calls).toBe(1);
	});
	test('429 twice → second failure propagates (retry only once)', async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			const e = new TmdbRateLimitError('429');
			e.retryAfterMs = 500;
			throw e;
		};
		await expect(withRateLimitRetry(fn, async () => {})).rejects.toBeInstanceOf(TmdbRateLimitError);
		expect(calls).toBe(2);
	});
});

describe('isActive tiering', () => {
	test('Returning Series → active', () => expect(isActive({ status: 'Returning Series' })).toBe(true));
	test('Watching → active regardless of status', () => expect(isActive({ status: 'Ended', watch_status: 'Watching' })).toBe(true));
	test('next_air_date set → active', () => expect(isActive({ status: 'Ended', next_air_date: '2026-08-01' })).toBe(true));
	test('Ended → static', () => expect(isActive({ status: 'Ended', next_air_date: 'null' })).toBe(false));
	test('Released movie → static', () => expect(isActive({ status: 'Released' })).toBe(false));
	test('missing status → active (needs first enrich)', () => expect(isActive({})).toBe(true));
});

describe('syncFolder', () => {
	test('default run skips static notes', async () => {
		const { deps, fetches } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		const report = await syncFolder(deps);
		expect(fetches.length).toBe(0);
		expect(report.skippedStatic).toBe(1);
	});
	test('full run processes static notes', async () => {
		const { deps, fetches } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		await syncFolder(deps, { full: true });
		expect(fetches).toEqual(['84958']);
	});
	test('diff-on-write: second pass on rendered output writes nothing', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		await syncFolder(deps, { full: true });
		const rendered = writes[0].content;
		const second = makeDeps([{ path: 'Loki.md', content: rendered }]);
		const report = await syncFolder(second.deps, { full: true });
		expect(second.writes.length).toBe(0);
		expect(report.written).toBe(0);
	});
	test('watch rule flips through full pipeline', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: AIRING_NOTE }]);
		const report = await syncFolder(deps);
		expect(writes.length).toBe(1);
		expect(writes[0].content).toContain('watch_status: Unwatched');
		expect(report.flipped).toEqual(['Loki.md']);
	});
	test('My Notes preserved through rewrite', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: AIRING_NOTE }]);
		await syncFolder(deps);
		expect(writes[0].content).toContain('keep me');
	});
	test('no tmdb ref → skipped, counted', async () => {
		const { deps, fetches } = makeDeps([{ path: '_Dashboard.md', content: '# dash' }]);
		const report = await syncFolder(deps, { full: true });
		expect(fetches.length).toBe(0);
		expect(report.skippedNoId).toBe(1);
	});
	test('dryRun: no writes, report counts', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: AIRING_NOTE }]);
		const report = await syncFolder(deps, { dryRun: true });
		expect(writes.length).toBe(0);
		expect(report.written).toBe(1); // counts what WOULD be written
	});
	test('429 → sleep(retryAfter) then retry succeeds', async () => {
		let calls = 0;
		const slept: number[] = [];
		const deps: SyncDeps = {
			listNotes: async () => [{ path: 'Loki.md' }],
			readNote: async () => AIRING_NOTE,
			writeNote: async () => {},
			fetchDetail: async () => {
				calls++;
				if (calls === 1) { const e = new TmdbRateLimitError('429'); e.retryAfterMs = 1500; throw e; }
				return tvDetail;
			},
			sleep: async ms => { slept.push(ms); },
			log: () => {},
		};
		const report = await syncFolder(deps);
		expect(calls).toBe(2);
		expect(slept).toContain(1500);
		expect(report.errors.length).toBe(0);
	});
	test('fetch error recorded, other notes continue', async () => {
		const { deps } = makeDeps([
			{ path: 'Bad.md', content: AIRING_NOTE },
			{ path: 'Good.md', content: AIRING_NOTE },
		]);
		let n = 0;
		deps.fetchDetail = async () => { n++; if (n === 1) throw new Error('boom'); return tvDetail; };
		const report = await syncFolder(deps);
		expect(report.errors.length).toBe(1);
		expect(report.errors[0].path).toBe('Bad.md');
		expect(report.synced).toBe(1);
	});
	test('custom section round-trips through rewrite, positioned after Links and before My Notes', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: NOTE_WITH_COLLECTION }]);
		await syncFolder(deps, { full: true });
		const out = writes[0].content;
		expect(out).toContain('## Collection\nPart of [[Movies]]\n');
		const linksIdx = out.indexOf('## Links');
		const collectionIdx = out.indexOf('## Collection');
		const myNotesIdx = out.indexOf('## My Notes');
		expect(collectionIdx).toBeGreaterThan(linksIdx);
		expect(myNotesIdx).toBeGreaterThan(collectionIdx);
	});
	test('two custom sections keep relative order through rewrite', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: NOTE_WITH_TWO_CUSTOM_SECTIONS }]);
		await syncFolder(deps, { full: true });
		const out = writes[0].content;
		expect(out.indexOf('## Collection')).toBeLessThan(out.indexOf('## Rewatch Log'));
		expect(out.indexOf('## Rewatch Log')).toBeLessThan(out.indexOf('## My Notes'));
	});
	test('idempotence: custom section stable across two sync passes (render→parse→extract→render byte-identical)', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: NOTE_WITH_COLLECTION }]);
		await syncFolder(deps, { full: true });
		const rendered = writes[0].content;
		const second = makeDeps([{ path: 'Loki.md', content: rendered }]);
		const report = await syncFolder(second.deps, { full: true });
		expect(second.writes.length).toBe(0);
		expect(report.written).toBe(0);
	});
	test('golden: note with no custom sections unaffected by custom-section plumbing', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		await syncFolder(deps, { full: true });
		expect(writes[0].content).not.toContain('## Collection');
	});
	test('stale-read guard: content edited mid-sync is re-read fresh, not clobbered by early snapshot', async () => {
		const { deps, writes, contents } = makeDeps([
			{ path: 'A.md', content: AIRING_NOTE },
			{ path: 'B.md', content: AIRING_NOTE },
		]);
		const originalFetch = deps.fetchDetail;
		let calls = 0;
		deps.fetchDetail = async (id, isMovie) => {
			calls++;
			if (calls === 1) {
				// simulate the user editing B.md's "My Notes" while A.md is still mid-sync,
				// i.e. after listNotes() ran but before B.md is actually processed.
				contents.set('B.md', AIRING_NOTE.replace('keep me', 'edited during sync'));
			}
			return originalFetch(id, isMovie);
		};
		await syncFolder(deps);
		const bWrite = writes.find(w => w.path === 'B.md');
		expect(bWrite?.content).toContain('edited during sync');
		expect(bWrite?.content).not.toContain('keep me');
	});
});
