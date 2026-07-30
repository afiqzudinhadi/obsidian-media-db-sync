import { describe, expect, test } from 'bun:test';
import { renderNote } from 'packages/obsidian/src/watchlist/render';
import type { WatchlistRecord } from 'packages/obsidian/src/watchlist/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOKI: WatchlistRecord = {
	title: 'Loki', engName: '', mediaType: 'TV Series', category: 'Series',
	watchStatus: 'Watched', rating: '5', ratingStars: '⭐️⭐️⭐️⭐️⭐️',
	year: '2021 - 2023', runtime: null, seasons: 2, episodes: 12, vod: ['Disney+'],
	genre: ['Drama', 'Sci-Fi & Fantasy'], status: 'Ended',
	language: 'English', country: 'United States of America',
	director: ['Aaron Moorhead', 'Justin Benson'], writer: ['Eric Martin'],
	producer: ['Rachel Alter', 'Tommy Turtle'], contentRating: 'TV-14',
	tmdbRating: 8.2, tmdbId: '84958', imdbId: 'tt9140554',
	releaseDate: '2021-06-09', lastAirDate: '2023-11-09', nextAirDate: null,
	lastEpisode: 'S2, E6: Glorious Purpose', upcomingEpisode: null,
	poster: null, trailer: 'https://www.youtube.com/watch?v=nW948Va-l10',
	homepage: 'https://www.disneyplus.com/series/wp/6pARMvILBGzF',
	imdbPage: 'https://www.imdb.com/title/tt9140554/',
	notionUrl: 'https://www.notion.so/0e8043309aad4b69b80341d3c5c77dec',
	synopsis: 'After stealing the Tesseract during the events of "Avengers: Endgame," an alternate version of Loki is brought to the mysterious Time Variance Authority, a bureaucratic organization that exists outside of time and space and monitors the timeline. They give Loki a choice: face being erased from existence due to being a "time variant" or help fix the timeline and stop a greater threat.',
	cast: 'Tom Hiddleston, Sophia Di Martino, Wunmi Mosaku, Eugene Cordero, Ke Huy Quan, Owen Wilson',
};

describe('renderNote golden', () => {
	test('matches canonical series fixture byte-for-byte', () => {
		const expected = readFileSync(join(import.meta.dir, 'fixtures', 'canonical-series.md'), 'utf-8');
		expect(renderNote(LOKI, '')).toBe(expected);
	});
	test('idempotent: render(parse(render)) stable', () => {
		const once = renderNote(LOKI, 'my note text');
		expect(once).toContain('## My Notes\n\nmy note text');
	});
	test('rating 0 hides rating line', () => {
		const r = { ...LOKI, rating: '0', ratingStars: '' };
		expect(renderNote(r, '')).not.toContain('**Rating:**');
	});
});
