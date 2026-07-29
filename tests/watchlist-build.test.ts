import { describe, expect, test } from 'bun:test';
import { buildRecord } from 'packages/obsidian/src/watchlist/build';
import movieDetail from 'tests/fixtures/tmdb-movie-dune2.json';
import tvDetail from 'tests/fixtures/tmdb-tv-loki.json';

const EMPTY_PREV = { watch_status: 'Unwatched', rating: '0', rating_stars: '' };

describe('buildRecord movie', () => {
	const r = buildRecord(movieDetail, true, EMPTY_PREV);
	test('core mapping (mirrors python selftest)', () => {
		expect(r.language).toBe('English');
		expect(r.country).toBe('United States of America');
		expect(r.imdbId).toBe('tt15239678');
		expect(r.contentRating).toBe('PG-13');
		expect(r.tmdbId).toBe('693134');
		expect(r.category).toBe('Movie');
		expect(r.trailer).toContain('youtube.com');
		expect(r.year).toBe('2024');
		expect(r.director).toEqual(['Denis Villeneuve']);
		expect(r.writer).toEqual(['Jon Spaihts']);
		expect(r.producer).toEqual(['Mary Parent']);
		expect(r.imdbPage).toBe('https://www.imdb.com/title/tt15239678/');
	});
	test('movie: seasons/episodes null, vod empty', () => {
		expect(r.seasons).toBeNull();
		expect(r.episodes).toBeNull();
		expect(r.vod).toEqual([]);
	});
});

describe('buildRecord tv', () => {
	const r = buildRecord(tvDetail, false, EMPTY_PREV);
	test('tv mapping', () => {
		expect(r.mediaType).toBe('TV Series');
		expect(r.category).toBe('Series');
		expect(r.year).toBe('2021 - 2023');
		expect(r.seasons).toBe(2);
		expect(r.episodes).toBe(12);
		expect(r.vod).toEqual(['Disney+']);
		expect(r.contentRating).toBe('TV-14');
		expect(r.lastEpisode).toBe('S2, E6: Glorious Purpose');
		expect(r.upcomingEpisode).toBeNull();
		expect(r.runtime).toBeNull();
		expect(r.director).toEqual(['Michael Waldron']);
	});
	test('ongoing series year + TBA', () => {
		const ongoing = { ...tvDetail, status: 'Returning Series', last_air_date: '2026-01-01', next_episode_to_air: null };
		const r2 = buildRecord(ongoing, false, EMPTY_PREV);
		expect(r2.year).toBe('2021 -');
		expect(r2.upcomingEpisode).toBe('TBA');
	});
	test('same start/end year collapses', () => {
		const oneYear = { ...tvDetail, first_air_date: '2021-06-09', last_air_date: '2021-07-14' };
		expect(buildRecord(oneYear, false, EMPTY_PREV).year).toBe('2021');
	});
});

describe('anime derivation', () => {
	test('Animation + Japanese → Anime', () => {
		const anime = {
			...tvDetail,
			genres: [{ name: 'Animation' }, { name: 'Drama' }],
			original_language: 'ja',
			spoken_languages: [{ iso_639_1: 'ja', english_name: 'Japanese' }],
		};
		expect(buildRecord(anime, false, EMPTY_PREV).category).toBe('Anime');
	});
	test('Animation + English → not Anime', () => {
		const western = { ...tvDetail, genres: [{ name: 'Animation' }] };
		expect(buildRecord(western, false, EMPTY_PREV).category).toBe('Series');
	});
});

describe('user-field preservation', () => {
	test('prev fields carried', () => {
		const prev = { watch_status: 'Watching', rating: '4', rating_stars: '⭐️⭐️⭐️⭐️', notion_url: 'https://notion.so/x' };
		const r = buildRecord(tvDetail, false, prev);
		expect(r.watchStatus).toBe('Watching');
		expect(r.rating).toBe('4');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️⭐️');
		expect(r.notionUrl).toBe('https://notion.so/x');
	});
});

describe('watch-status rule (TV)', () => {
	test('Watched + newer episode → Unwatched', () => {
		const prev = { watch_status: 'Watched', last_air_date: '2023-10-01', rating: '5', rating_stars: '⭐️⭐️⭐️⭐️⭐️' };
		expect(buildRecord(tvDetail, false, prev).watchStatus).toBe('Unwatched');
	});
	test('Watched + same date → stays Watched', () => {
		const prev = { watch_status: 'Watched', last_air_date: '2023-11-09' };
		expect(buildRecord(tvDetail, false, prev).watchStatus).toBe('Watched');
	});
	test('movie never flips', () => {
		const prev = { watch_status: 'Watched', last_air_date: '2020-01-01' };
		expect(buildRecord(movieDetail, true, prev).watchStatus).toBe('Watched');
	});
	test('no prev last_air_date → no flip', () => {
		const prev = { watch_status: 'Watched' };
		expect(buildRecord(tvDetail, false, prev).watchStatus).toBe('Watched');
	});
});

describe('eng_name derivation', () => {
	test('non-Latin original → engName = localized title', () => {
		const jp = { ...movieDetail, title: 'A Silent Voice: The Movie', original_title: '映画 聲の形' };
		expect(buildRecord(jp, true, EMPTY_PREV).engName).toBe('A Silent Voice: The Movie');
	});
	test('same Latin title → empty', () => {
		expect(buildRecord(movieDetail, true, EMPTY_PREV).engName).toBe('');
	});
});
