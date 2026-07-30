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
	test('quoted notion_url from raw frontmatter capture → quotes stripped', () => {
		const prev = { notion_url: '"https://www.notion.so/x"' };
		const r = buildRecord(tvDetail, false, prev);
		expect(r.notionUrl).toBe('https://www.notion.so/x');
	});
	test('null-sentinel notion_url still normalizes to empty', () => {
		const prev = { notion_url: 'null' };
		const r = buildRecord(tvDetail, false, prev);
		expect(r.notionUrl).toBe('');
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

describe('TV crew preservation', () => {
	test('TV + prev crew present → prev wins over created_by', () => {
		const prev = {
			director: '"Aaron Moorhead, Justin Benson"',
			writer: 'Eric Martin',
			producer: '"Rachel Alter, Tommy Turtle"',
		};
		const r = buildRecord(tvDetail, false, prev);
		expect(r.director).toEqual(['Aaron Moorhead', 'Justin Benson']);
		expect(r.writer).toEqual(['Eric Martin']);
		expect(r.producer).toEqual(['Rachel Alter', 'Tommy Turtle']);
	});
	test('TV + empty prev crew → falls back to created_by', () => {
		const r = buildRecord(tvDetail, false, EMPTY_PREV);
		expect(r.director).toEqual(['Michael Waldron']);
		expect(r.writer).toEqual(['Michael Waldron']);
		expect(r.producer).toEqual([]);
	});
	test('Movie + prev crew present → prev ignored, TMDB credits win', () => {
		const prev = { director: 'Someone Else' };
		const r = buildRecord(movieDetail, true, prev);
		expect(r.director).toEqual(['Denis Villeneuve']);
	});
});

describe('TV country derivation', () => {
	test('prefers production_countries full name over raw origin_country code', () => {
		const r = buildRecord(tvDetail, false, EMPTY_PREV);
		expect(r.country).toBe('United States of America');
	});
	test('no production_countries → falls back to raw origin_country code', () => {
		const { production_countries, ...noProdCountries } = tvDetail as any;
		const r = buildRecord(noProdCountries, false, EMPTY_PREV);
		expect(r.country).toBe('US');
	});
	test('TV no production_countries, prev full country name → preserves prev', () => {
		const { production_countries, ...noProdCountries } = tvDetail as any;
		const prev = { country: 'United States of America' };
		const r = buildRecord(noProdCountries, false, prev);
		expect(r.country).toBe('United States of America');
	});
	test('TV no production_countries, prev bare ISO code → uses origin_country fallback', () => {
		const { production_countries, ...noProdCountries } = tvDetail as any;
		const prev = { country: 'US' };
		const r = buildRecord(noProdCountries, false, prev);
		expect(r.country).toBe('US');
	});
	test('TV production_countries present, prev differs → uses production_countries name', () => {
		const prev = { country: 'Canada' };
		const r = buildRecord(tvDetail, false, prev);
		expect(r.country).toBe('United States of America');
	});
});

describe('tmdb_rating rounding', () => {
	test('6.537 → 6.5', () => {
		expect(buildRecord({ ...tvDetail, vote_average: 6.537 }, false, EMPTY_PREV).tmdbRating).toBe(6.5);
	});
	test('7.854 → 7.9', () => {
		expect(buildRecord({ ...tvDetail, vote_average: 7.854 }, false, EMPTY_PREV).tmdbRating).toBe(7.9);
	});
	test('8.2 → 8.2 (unaffected)', () => {
		expect(buildRecord(tvDetail, false, EMPTY_PREV).tmdbRating).toBe(8.2);
	});
	test('null → null', () => {
		expect(buildRecord({ ...tvDetail, vote_average: null }, false, EMPTY_PREV).tmdbRating).toBeNull();
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
