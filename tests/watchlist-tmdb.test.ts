import { describe, expect, test } from 'bun:test';
import { fetchDetail, searchTitle } from 'packages/obsidian/src/watchlist/tmdb';

function capture(): { calls: { url: string; headers: Record<string, string> }[]; http: any } {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	return {
		calls,
		http: async (url: string, headers: Record<string, string>) => {
			calls.push({ url, headers });
			return { results: [] };
		},
	};
}

describe('fetchDetail', () => {
	test('v4 token → Bearer header, no api_key param', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'eyJhbGciOi.fake.jwt', '693134', true);
		expect(calls[0].headers['Authorization']).toBe('Bearer eyJhbGciOi.fake.jwt');
		expect(calls[0].url).not.toContain('api_key');
	});
	test('v3 key → api_key param, no auth header', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'abc123', '693134', true);
		expect(calls[0].url).toContain('api_key=abc123');
		expect(calls[0].headers['Authorization']).toBeUndefined();
	});
	test('movie url + append', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'k', '693134', true);
		expect(calls[0].url).toContain('/3/movie/693134');
		expect(calls[0].url).toContain('append_to_response=credits%2Cexternal_ids%2Crelease_dates%2Cvideos');
		expect(calls[0].url).toContain('language=en-US');
	});
	test('tv url + append', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'k', '84958', false);
		expect(calls[0].url).toContain('/3/tv/84958');
		expect(calls[0].url).toContain('append_to_response=aggregate_credits%2Cexternal_ids%2Ccontent_ratings%2Cvideos');
	});
});

describe('searchTitle', () => {
	test('movie search url + year', async () => {
		const { calls, http } = capture();
		await searchTitle(http, 'k', 'Dune Part Two', true, '2024');
		expect(calls[0].url).toContain('/3/search/movie');
		expect(calls[0].url).toContain('query=Dune+Part+Two');
		expect(calls[0].url).toContain('primary_release_year=2024');
	});
	test('tv search url', async () => {
		const { calls, http } = capture();
		await searchTitle(http, 'k', 'Loki', false, '2021');
		expect(calls[0].url).toContain('/3/search/tv');
		expect(calls[0].url).toContain('first_air_date_year=2021');
	});
});
