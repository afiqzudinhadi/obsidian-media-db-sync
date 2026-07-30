import { describe, expect, test } from 'bun:test';
import { resolveNote } from 'packages/obsidian/src/watchlist/resolve';

const HIT = { id: 693134, title: 'Dune: Part Two', original_title: 'Dune: Part Two' };
const OTHER = { id: 1, title: 'Dune', original_title: 'Dune' };

describe('resolveNote', () => {
	test('exact title match accepted', async () => {
		const r = await resolveNote({ media_type: 'Movie' }, 'Dune: Part Two.md', async () => [HIT, OTHER]);
		expect(r).toEqual({ tmdbId: '693134', isMovie: true, matchedTitle: 'Dune: Part Two' });
	});
	test('single result accepted even if inexact', async () => {
		const r = await resolveNote({ media_type: 'Movie' }, 'Dune Part 2.md', async () => [HIT]);
		expect(r?.tmdbId).toBe('693134');
	});
	test('ambiguous → null', async () => {
		const r = await resolveNote({ media_type: 'Movie' }, 'Dune something.md', async () => [HIT, OTHER]);
		expect(r).toBeNull();
	});
	test('no media_type → movie then tv fallback', async () => {
		const calls: boolean[] = [];
		const r = await resolveNote({}, 'Loki.md', async (q, isMovie) => {
			calls.push(isMovie);
			return isMovie ? [] : [{ id: 84958, name: 'Loki', original_name: 'Loki' }];
		});
		expect(calls).toEqual([true, false]);
		expect(r).toEqual({ tmdbId: '84958', isMovie: false, matchedTitle: 'Loki' });
	});
	test('year hint passed through', async () => {
		let seenYear: string | undefined;
		await resolveNote({ media_type: 'Movie', year: '2024' }, 'Dune: Part Two.md', async (q, m, year) => {
			seenYear = year;
			return [HIT];
		});
		expect(seenYear).toBe('2024');
	});
	test('two exact matches (same title, different ids) → null (ambiguous)', async () => {
		const RH1 = { id: 1, title: 'Robin Hood', original_title: 'Robin Hood' };
		const RH2 = { id: 2, title: 'Robin Hood', original_title: 'Robin Hood' };
		const r = await resolveNote({ media_type: 'Movie' }, 'Robin Hood.md', async () => [RH1, RH2]);
		expect(r).toBeNull();
	});
	test('exact match at non-top index, unique → accepted', async () => {
		const NOPE = { id: 9, title: 'Robin Hood Begins', original_title: 'Robin Hood Begins' };
		const HIT2 = { id: 10, title: 'Robin Hood', original_title: 'Robin Hood' };
		const r = await resolveNote({ media_type: 'Movie' }, 'Robin Hood.md', async () => [NOPE, HIT2]);
		expect(r).toEqual({ tmdbId: '10', isMovie: true, matchedTitle: 'Robin Hood' });
	});
});
