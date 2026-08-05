import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManga, buildMangaFromAniList, renderManga, mangaSpec, type MangaRecord } from 'packages/obsidian/src/library/manga';
import type { SpecDeps, LibraryNoteCtx } from 'packages/obsidian/src/library/types';
import { TmdbRateLimitError } from 'packages/obsidian/src/watchlist/SyncEngine';
import jikanFixture from 'tests/fixtures/jikan-manga-csm.json';
import mangadexFixture from 'tests/fixtures/mangadex-feed.json';
import anilistFixture from 'tests/fixtures/anilist-manga-csm.json';

const JIKAN_DATA = jikanFixture.data;
const ANILIST_MEDIA = anilistFixture.data.Media;

const EMPTY_PREV: Record<string, string> = {};

function makeDeps(overrides: Partial<SpecDeps> = {}): SpecDeps & { notifyCalls: string[]; logCalls: string[] } {
	const notifyCalls: string[] = [];
	const logCalls: string[] = [];
	return {
		http: async () => ({}),
		httpText: async () => '',
		httpPostJson: async () => ({}),
		getKey: () => '',
		log: (msg: string) => {
			logCalls.push(msg);
		},
		notify: (msg: string) => {
			notifyCalls.push(msg);
		},
		notifyCalls,
		logCalls,
		...overrides,
	};
}

const RSS_214 = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Chainsaw Man Chapter 214</title><pubDate>Thu, 30 Jul 2026 12:00:00 GMT</pubDate><guid>214</guid></item>
<item><title>Chainsaw Man Chapter 213</title><pubDate>Thu, 23 Jul 2026 12:00:00 GMT</pubDate><guid>213</guid></item>
</channel></rss>`;

const RSS_NOISE_PLUS_214 = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Chainsaw Man - #1 ranked this week!</title><pubDate>Thu, 30 Jul 2026 13:00:00 GMT</pubDate><guid>noise</guid></item>
<item><title>Chainsaw Man Chapter 214</title><pubDate>Thu, 30 Jul 2026 12:00:00 GMT</pubDate><guid>214</guid></item>
</channel></rss>`;

const RSS_NUMBERLESS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Chainsaw Man - Extra Announcement</title><pubDate>Thu, 30 Jul 2026 12:00:00 GMT</pubDate><guid>a</guid></item>
</channel></rss>`;

const RSS_215 = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Chainsaw Man Chapter 215</title><pubDate>Thu, 06 Aug 2026 12:00:00 GMT</pubDate><guid>215</guid></item>
<item><title>Chainsaw Man Chapter 214</title><pubDate>Thu, 30 Jul 2026 12:00:00 GMT</pubDate><guid>214</guid></item>
</channel></rss>`;

describe('buildManga field mapping', () => {
	const r = buildManga(JIKAN_DATA, EMPTY_PREV);
	test('core fields', () => {
		expect(r.title).toBe('Chainsaw Man');
		expect(r.malId).toBe('116778');
		expect(r.status).toBe('Publishing');
		expect(r.chapters).toBeNull();
		expect(r.volumes).toBeNull();
		expect(r.authors).toEqual(['Fujimoto, Tatsuki']);
		expect(r.genre).toEqual(['Action', 'Horror', 'Sports']);
		expect(r.publishedFrom).toBe('2018-12-03');
		expect(r.publishedTo).toBeNull();
		expect(r.poster).toBe('https://cdn.myanimelist.net/images/manga/3/216464l.jpg');
		expect(r.url).toBe('https://myanimelist.net/manga/116778/Chainsaw_Man');
	});
	test('score rounds to 1dp (8.73 -> 8.7)', () => {
		expect(r.score).toBe(8.7);
	});
	test('7.854 -> 7.9', () => {
		expect(buildManga({ ...JIKAN_DATA, score: 7.854 }, EMPTY_PREV).score).toBe(7.9);
	});
	test('null score -> null', () => {
		expect(buildManga({ ...JIKAN_DATA, score: null }, EMPTY_PREV).score).toBeNull();
	});
	test('eng_name empty when title_english === title', () => {
		expect(r.engName).toBe('');
	});
	test('eng_name set when title_english differs from title', () => {
		const jp = { ...JIKAN_DATA, title: 'Chainsaw Man', title_english: 'Chainsaw Man EN Alt' };
		expect(buildManga(jp, EMPTY_PREV).engName).toBe('Chainsaw Man EN Alt');
	});
	test('status passthrough: Finished', () => {
		expect(buildManga({ ...JIKAN_DATA, status: 'Finished' }, EMPTY_PREV).status).toBe('Finished');
	});
	test('status passthrough: On Hiatus', () => {
		expect(buildManga({ ...JIKAN_DATA, status: 'On Hiatus' }, EMPTY_PREV).status).toBe('On Hiatus');
	});
});

describe('buildManga user-field preservation', () => {
	test('read_status defaults to Unread', () => {
		expect(buildManga(JIKAN_DATA, EMPTY_PREV).readStatus).toBe('Unread');
	});
	test('read_status carried from prev', () => {
		const prev = { read_status: 'Reading' };
		expect(buildManga(JIKAN_DATA, prev).readStatus).toBe('Reading');
	});
	test('rating/rating_stars carried from prev', () => {
		const prev = { rating: '4', rating_stars: '⭐️⭐️⭐️⭐️' };
		const r = buildManga(JIKAN_DATA, prev);
		expect(r.rating).toBe('4');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️⭐️');
	});
	test('last_read_chapter carried from prev', () => {
		expect(buildManga(JIKAN_DATA, { last_read_chapter: '150' }).lastReadChapter).toBe('150');
	});
	test('rss carried from prev', () => {
		expect(buildManga(JIKAN_DATA, { rss: 'https://x.y/feed.xml' }).rss).toBe('https://x.y/feed.xml');
	});
	test('mangadex_id kept even when unrelated to jikan resolve', () => {
		expect(buildManga(JIKAN_DATA, { mangadex_id: 'abc-123' }).mangadexId).toBe('abc-123');
	});
	test('latest_chapter/last_chapter_date preserved verbatim (not touched by buildManga)', () => {
		const prev = { latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const r = buildManga(JIKAN_DATA, prev);
		expect(r.latestChapter).toBe(213);
		expect(r.lastChapterDate).toBe('2026-07-16');
	});
});

describe('buildManga skeleton conversion', () => {
	test('read: true -> read_status Read', () => {
		const prev = { read: 'true', personalRating: '' };
		expect(buildManga(JIKAN_DATA, prev).readStatus).toBe('Read');
	});
	test('read: false -> read_status Unread', () => {
		const prev = { read: 'false', personalRating: '' };
		expect(buildManga(JIKAN_DATA, prev).readStatus).toBe('Unread');
	});
	test('personalRating 3 -> rating 3 + 3 stars', () => {
		const prev = { read: 'false', personalRating: '3' };
		const r = buildManga(JIKAN_DATA, prev);
		expect(r.rating).toBe('3');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️');
	});
	test('empty personalRating -> rating 0, no stars', () => {
		const prev = { read: 'false', personalRating: '' };
		const r = buildManga(JIKAN_DATA, prev);
		expect(r.rating).toBe('0');
		expect(r.ratingStars).toBe('');
	});
});

describe('renderManga golden', () => {
	const RECORD: MangaRecord = {
		title: 'Chainsaw Man',
		engName: '',
		readStatus: 'Reading',
		rating: '4',
		ratingStars: '⭐️⭐️⭐️⭐️',
		lastReadChapter: '210',
		latestChapter: 213,
		lastChapterDate: '2026-07-16',
		chapters: null,
		volumes: null,
		status: 'Publishing',
		authors: ['Fujimoto, Tatsuki'],
		genre: ['Action', 'Horror', 'Sports'],
		score: 8.7,
		publishedFrom: '2018-12-03',
		publishedTo: null,
		malId: '116778',
		anilistId: '105778',
		mangadexId: 'abc-123',
		rss: 'https://example.com/csm-feed.xml',
		poster: 'https://cdn.myanimelist.net/images/manga/3/216464l.jpg',
		url: 'https://myanimelist.net/manga/116778/Chainsaw_Man',
		synopsis: 'Denji has been robbed of a normal life ever since his Chainsaw Devil, Pochita, merged with him.',
	};

	test('matches canonical manga fixture byte-for-byte', () => {
		const expected = readFileSync(join(import.meta.dir, 'fixtures', 'canonical-manga.md'), 'utf-8');
		expect(renderManga(RECORD, '')).toBe(expected);
	});

	test('custom section (Collection) placed after Links, before My Notes', () => {
		const out = renderManga(RECORD, '', [{ heading: 'Collection', content: 'Part of [[Mangas]]' }]);
		const linksIdx = out.indexOf('## Links');
		const collectionIdx = out.indexOf('## Collection');
		const myNotesIdx = out.indexOf('## My Notes');
		expect(collectionIdx).toBeGreaterThan(linksIdx);
		expect(myNotesIdx).toBeGreaterThan(collectionIdx);
		expect(out).toContain('## Collection\nPart of [[Mangas]]\n');
	});

	test('My Notes content preserved', () => {
		const out = renderManga(RECORD, 'currently reading');
		expect(out).toContain('## My Notes\n\ncurrently reading');
	});

	test('rating line present when rating set', () => {
		expect(renderManga(RECORD, '')).toContain('**Rating:** ⭐️⭐️⭐️⭐️ (4/5)');
	});

	test('rating 0 -> Rating line absent', () => {
		const r = { ...RECORD, rating: '0', ratingStars: '' };
		expect(renderManga(r, '')).not.toContain('**Rating:**');
	});

	test('no last_read_chapter -> Progress line omitted', () => {
		const r = { ...RECORD, lastReadChapter: '' };
		expect(renderManga(r, '')).not.toContain('**Progress:**');
	});

	test('Progress denominator falls back to chapters when latest_chapter null', () => {
		const r = { ...RECORD, latestChapter: null, chapters: 150 };
		expect(renderManga(r, '')).toContain('**Progress:** ch. 210 / 150');
	});

	test('Progress denominator falls back to ? when both null', () => {
		const r = { ...RECORD, latestChapter: null, chapters: null };
		expect(renderManga(r, '')).toContain('**Progress:** ch. 210 / ?');
	});
});

describe('mangaSpec.hasId', () => {
	test('mal_id set -> true', () => expect(mangaSpec.hasId({ mal_id: '116778' })).toBe(true));
	test('mal_id empty -> false', () => expect(mangaSpec.hasId({ mal_id: '' })).toBe(false));
	test('mal_id missing -> false', () => expect(mangaSpec.hasId({})).toBe(false));
});

describe('mangaSpec.isActive', () => {
	test('never enriched (no mal_id/status) -> active', () => {
		expect(mangaSpec.isActive({})).toBe(true);
	});
	test('Publishing -> active', () => {
		expect(mangaSpec.isActive({ mal_id: '1', status: 'Publishing', read_status: 'Unread' })).toBe(true);
	});
	test('On Hiatus -> active', () => {
		expect(mangaSpec.isActive({ mal_id: '1', status: 'On Hiatus', read_status: 'Unread' })).toBe(true);
	});
	test('Finished + read_status Reading -> active', () => {
		expect(mangaSpec.isActive({ mal_id: '1', status: 'Finished', read_status: 'Reading' })).toBe(true);
	});
	test('Finished + rss set -> active', () => {
		expect(mangaSpec.isActive({ mal_id: '1', status: 'Finished', read_status: 'Unread', rss: 'https://x.y/f.xml' })).toBe(true);
	});
	test('Finished + Read -> static', () => {
		expect(mangaSpec.isActive({ mal_id: '1', status: 'Finished', read_status: 'Read' })).toBe(false);
	});
	test('Finished + Unread -> static', () => {
		expect(mangaSpec.isActive({ mal_id: '1', status: 'Finished', read_status: 'Unread' })).toBe(false);
	});
	test('Finished + rss rendered as literal "null" sentinel -> not read as truthy, static (C2)', () => {
		expect(mangaSpec.isActive({ mal_id: '1', status: 'Finished', read_status: 'Read', rss: 'null' })).toBe(false);
	});
});

function ctxFor(fm: Record<string, string>, body = '## My Notes\n\n'): LibraryNoteCtx {
	return { frontmatter: fm, body, filename: 'Chainsaw Man.md' };
}

describe('mangaSpec.sync — jikan enrich', () => {
	test('no mal_id -> null (needs resolve first)', async () => {
		const deps = makeDeps();
		const result = await mangaSpec.sync(ctxFor({}), deps);
		expect(result).toBeNull();
	});

	test('jikan fetch failure -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('network down');
			},
		});
		const result = await mangaSpec.sync(ctxFor({ mal_id: '116778' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});

	test('successful enrich with no rss/mangadex_id -> latest_chapter unchanged, no flip', async () => {
		const deps = makeDeps({ http: async () => jikanFixture });
		const fm = { mal_id: '116778', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_chapter: 213');
		expect(result!.content).toContain('read_status: Read');
		expect(deps.notifyCalls).toEqual([]);
	});
});

describe('mangaSpec.sync — chapter source priority', () => {
	test('rss set -> httpText fetched, latestChapter() used, new > stored -> update + flip + notify', async () => {
		let httpTextCalledWith = '';
		const deps = makeDeps({
			http: async () => jikanFixture,
			httpText: async url => {
				httpTextCalledWith = url;
				return RSS_214;
			},
		});
		const fm = { mal_id: '116778', rss: 'https://example.com/csm-feed.xml', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(httpTextCalledWith).toBe('https://example.com/csm-feed.xml');
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('latest_chapter: 214');
		expect(result!.content).toContain('read_status: Unread');
		expect(deps.notifyCalls).toEqual(['«Chainsaw Man» ch. 214 out']);
	});

	test('rss not set, mangadex_id set -> mangadex feed endpoint used', async () => {
		let httpCalls: string[] = [];
		const deps = makeDeps({
			http: async url => {
				httpCalls.push(url);
				return url.includes('mangadex.org') ? mangadexFixture : jikanFixture;
			},
		});
		const fm = { mal_id: '116778', mangadex_id: 'abc-123', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(httpCalls.some(u => u.includes('/manga/abc-123/feed'))).toBe(true);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('latest_chapter: 214');
	});

	test('neither rss nor mangadex_id -> latest_chapter unchanged, no flip', async () => {
		const deps = makeDeps({ http: async () => jikanFixture });
		const fm = { mal_id: '116778', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_chapter: 213');
	});

	test('new chapter <= stored -> no update, no flip', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_214 });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read', latest_chapter: '214', last_chapter_date: '2026-07-30' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_chapter: 214');
		expect(deps.notifyCalls).toEqual([]);
	});

	test('numberless feed result: new date > stored last_chapter_date -> update + flip, chapter stays null', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_NUMBERLESS });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read', latest_chapter: '', last_chapter_date: '2026-07-01' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('latest_chapter: null');
		expect(result!.content).toContain('last_chapter_date: 2026-07-30');
	});

	test('numberless feed result: new date <= stored -> no update', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_NUMBERLESS });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read', latest_chapter: '', last_chapter_date: '2026-08-15' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('last_chapter_date: 2026-08-15');
	});

	test('read_status Reading -> chapter update happens but never flips', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_214 });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Reading', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('read_status: Reading');
		expect(result!.content).toContain('latest_chapter: 214');
		expect(deps.notifyCalls).toEqual([]);
	});

	test('read_status Unread -> never flipped', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_214 });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Unread', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('read_status: Unread');
	});

	test('read_status Dropped -> never flipped', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_214 });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Dropped', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('read_status: Dropped');
	});

	test('rss fetch failure -> log, proceed with mangadex fallback (no throw)', async () => {
		const deps = makeDeps({
			http: async url => (url.includes('mangadex.org') ? mangadexFixture : jikanFixture),
			httpText: async () => {
				throw new Error('rss unreachable');
			},
		});
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', mangadex_id: 'abc-123', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect(deps.logCalls.some(m => m.includes('rss'))).toBe(true);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('latest_chapter: 214');
	});

	test('rss fetch failure, no mangadex_id -> log, jikan enrich still completes, latest_chapter unchanged', async () => {
		const deps = makeDeps({
			http: async () => jikanFixture,
			httpText: async () => {
				throw new Error('rss unreachable');
			},
		});
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_chapter: 213');
		expect(result!.content).toContain('mal_id: 116778');
	});
});

describe('mangaSpec.sync — finish-flip', () => {
	test('prev Publishing + new Finished + read_status Read -> Unread, flipped, notify', async () => {
		const deps = makeDeps({ http: async () => ({ data: { ...JIKAN_DATA, status: 'Finished' } }) });
		const fm = { mal_id: '116778', status: 'Publishing', read_status: 'Read' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('read_status: Unread');
		expect(result!.content).toContain('status: Finished');
		expect(deps.notifyCalls).toEqual(['«Chainsaw Man» finished — final chapters out']);
	});
	test('prev Publishing + new Finished + read_status Reading -> no flip, no notify', async () => {
		const deps = makeDeps({ http: async () => ({ data: { ...JIKAN_DATA, status: 'Finished' } }) });
		const fm = { mal_id: '116778', status: 'Publishing', read_status: 'Reading' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('read_status: Reading');
		expect(deps.notifyCalls).toEqual([]);
	});
	test('chapter-flip and finish-flip both eligible in same sync -> notify fires once (chapter message only, no double-fire)', async () => {
		const deps = makeDeps({
			http: async () => ({ data: { ...JIKAN_DATA, status: 'Finished' } }),
			httpText: async () => RSS_214,
		});
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', status: 'Publishing', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('read_status: Unread');
		expect(result!.content).toContain('status: Finished');
		expect(deps.notifyCalls).toEqual(['«Chainsaw Man» ch. 214 out']);
	});
});

describe('mangaSpec.sync — carry-forward: noise item does not win over real chapter', () => {
	test('feed w/ "#1 ranked" noise + real "Chapter 214", stored 213 -> latest becomes 214 (not 1), flips once', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_NOISE_PLUS_214 });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('latest_chapter: 214');
		expect(result!.content).not.toContain('latest_chapter: 1\n');
		expect(deps.notifyCalls).toEqual(['«Chainsaw Man» ch. 214 out']);
	});

	test('second run with same feed -> no flip, no diff', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_NOISE_PLUS_214 });
		const fm1 = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const first = await mangaSpec.sync(ctxFor(fm1), deps);
		expect(first!.flipped).toBe(true);

		// re-parse first run's output frontmatter as prev state for second run
		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(first!.content)!;
		const fm2: Record<string, string> = {};
		for (const line of fmMatch[1].split('\n')) {
			const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
			if (m) fm2[m[1]] = m[2];
		}

		const second = await mangaSpec.sync(ctxFor(fm2), deps);
		expect(second!.flipped).toBe(false);
		expect(second!.content).toBe(first!.content);
		expect(deps.notifyCalls.length).toBe(1); // only the first run notified
	});
});

describe('mangaSpec.sync — rss/last_chapter_date null-sentinel guard (C2)', () => {
	test('rss stored as literal "null" string (already-broken note) -> not fetched, treated as empty', async () => {
		let httpTextCalledWith: string | null = null;
		const deps = makeDeps({
			http: async () => jikanFixture,
			httpText: async (url: string) => {
				httpTextCalledWith = url;
				return '';
			},
		});
		const fm = { mal_id: '116778', rss: 'null', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(httpTextCalledWith).toBeNull();
		expect(result!.content).toContain('rss: null');
		expect(result!.flipped).toBe(false);
	});

	test('render(parse(render)) idempotent w/ empty rss -- second sync byte-stable, never fetches "null"', async () => {
		const httpTextCalls: string[] = [];
		const deps = makeDeps({
			http: async () => jikanFixture,
			httpText: async (url: string) => {
				httpTextCalls.push(url);
				return '';
			},
		});
		const fm1 = { mal_id: '116778', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const first = await mangaSpec.sync(ctxFor(fm1), deps);
		expect(first!.content).toContain('rss: null');

		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(first!.content)!;
		const fm2: Record<string, string> = {};
		for (const line of fmMatch[1].split('\n')) {
			const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
			if (m) fm2[m[1]] = m[2];
		}
		expect(fm2['rss']).toBe('null'); // confirms the sentinel round-trips through parse as raw input

		const second = await mangaSpec.sync(ctxFor(fm2), deps);
		expect(second!.content).toBe(first!.content);
		expect(httpTextCalls).toEqual([]); // rss never truthy after sanitizing -> httpText never called, let alone with 'null'
	});

	test('last_chapter_date stored as literal "null" -- date-mode comparison not poisoned, treated as seed', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_NUMBERLESS });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read', latest_chapter: '', last_chapter_date: 'null' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false); // sanitized to '' -> seed pass, never flips
		expect(result!.content).toContain('last_chapter_date: 2026-07-30');
		expect(deps.notifyCalls).toEqual([]);
	});
});

describe('mangaSpec.sync — seed pass (I3): no stored baseline never flips even when Read', () => {
	test('Read manga, no stored latest_chapter, rss reports chapter 214 -> seeds latest_chapter, read_status stays Read, no notify', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_214 });
		const fm = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_chapter: 214');
		expect(result!.content).toContain('read_status: Read');
		expect(deps.notifyCalls).toEqual([]);
	});

	test('seed pass then a later sync with a higher chapter -> flip + notify only on the second sync', async () => {
		const deps = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_214 });
		const fm1 = { mal_id: '116778', rss: 'https://x.y/f.xml', read_status: 'Read' };
		const first = await mangaSpec.sync(ctxFor(fm1), deps);
		expect(first!.flipped).toBe(false);
		expect(first!.content).toContain('latest_chapter: 214');
		expect(deps.notifyCalls).toEqual([]);

		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(first!.content)!;
		const fm2: Record<string, string> = {};
		for (const line of fmMatch[1].split('\n')) {
			const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
			if (m) fm2[m[1]] = m[2];
		}

		const deps2 = makeDeps({ http: async () => jikanFixture, httpText: async () => RSS_215 });
		const second = await mangaSpec.sync(ctxFor(fm2), deps2);
		expect(second!.flipped).toBe(true);
		expect(second!.content).toContain('latest_chapter: 215');
		expect(second!.content).toContain('read_status: Unread');
		expect(deps2.notifyCalls).toEqual(['«Chainsaw Man» ch. 215 out']);
	});
});

describe('mangaSpec.resolve', () => {
	test('unique exact title match -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [{ mal_id: 116778, title: 'Chainsaw Man', title_english: 'Chainsaw Man' }] }),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778' } });
	});
	test('no exact match, sole result -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [{ mal_id: 999, title: 'Some Other Title', title_english: '' }] }),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '999' } });
	});
	test('ambiguous (multiple results, no exact match) -> null', async () => {
		const deps = makeDeps({
			http: async () => ({
				data: [
					{ mal_id: 1, title: 'Foo' },
					{ mal_id: 2, title: 'Bar' },
				],
			}),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toBeNull();
	});
	test('ambiguous -> logs top candidates with mal_id + title', async () => {
		const deps = makeDeps({
			http: async () => ({
				data: [
					{ mal_id: 1, title: 'Foo' },
					{ mal_id: 2, title: 'Bar' },
				],
			}),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.some(m => m.includes('ambiguous') && m.includes('mal_id=1') && m.includes('Foo') && m.includes('mal_id=2') && m.includes('Bar'))).toBe(true);
	});
	test('no results -> null', async () => {
		const deps = makeDeps({ http: async () => ({ data: [] }) });
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toBeNull();
	});
	test('http throws -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('down');
			},
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});
});

describe('mangaSpec.resolve — best-effort MangaDex id resolve (I4)', () => {
	const jikanMatch = { data: [{ mal_id: 116778, title: 'Chainsaw Man', title_english: 'Chainsaw Man' }] };

	test('mal_id resolved, no mangadex_id in fm -> mangadex title search attempted, exact en-title match patches both ids', async () => {
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('mangadex.org')) return { data: [{ id: 'a1b2c3d4-uuid', attributes: { title: { en: 'Chainsaw Man' }, altTitles: [{ ja: 'チェンソーマン' }] } }] };
				return jikanMatch;
			},
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778', mangadex_id: 'a1b2c3d4-uuid' } });
	});

	test('mangadex search no exact match, sole result -> accepted (unique-exact fallback rule)', async () => {
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('mangadex.org')) return { data: [{ id: 'uuid-solo', attributes: { title: { en: 'Chainsaw Man: The Movie' } } }] };
				return jikanMatch;
			},
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778', mangadex_id: 'uuid-solo' } });
	});

	test('mangadex search ambiguous (multiple results, no exact match) -> mal_id patched only', async () => {
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('mangadex.org'))
					return {
						data: [
							{ id: 'uuid-1', attributes: { title: { en: 'Something Else' } } },
							{ id: 'uuid-2', attributes: { title: { en: 'Another Title' } } },
						],
					};
				return jikanMatch;
			},
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778' } });
	});

	test('mangadex search throws -> log, mal_id patched only (best-effort, no overall failure)', async () => {
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('mangadex.org')) throw new Error('mangadex down');
				return jikanMatch;
			},
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778' } });
		expect(deps.logCalls.some(m => m.toLowerCase().includes('mangadex'))).toBe(true);
	});

	test('mangadex_id already present in fm -> mangadex search skipped entirely', async () => {
		let mangadexCalled = false;
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('mangadex.org')) mangadexCalled = true;
				return jikanMatch;
			},
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man', mangadex_id: 'existing-uuid' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778' } });
		expect(mangadexCalled).toBe(false);
	});
});

describe('buildMangaFromAniList field mapping', () => {
	const r = buildMangaFromAniList(ANILIST_MEDIA, EMPTY_PREV);

	test('core fields', () => {
		expect(r.title).toBe('Chainsaw Man');
		expect(r.anilistId).toBe('105778');
		expect(r.malId).toBe('116778'); // from idMal bridge
		expect(r.status).toBe('Publishing'); // RELEASING -> Publishing
		expect(r.chapters).toBeNull();
		expect(r.volumes).toBeNull();
		expect(r.genre).toEqual(['Action', 'Comedy', 'Horror', 'Supernatural']);
		expect(r.poster).toBe('https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx105778-JCftt5T5vNAY.jpg');
		expect(r.url).toBe('https://myanimelist.net/manga/116778'); // MAL convention, mal_id present
	});

	test('authors: only staff roles containing "Story" -> excludes Letterer', () => {
		expect(r.authors).toEqual(['Tatsuki Fujimoto']);
	});

	test('score: averageScore 85 -> 8.5', () => {
		expect(r.score).toBe(8.5);
	});
	test('averageScore 73 -> 7.3', () => {
		expect(buildMangaFromAniList({ ...ANILIST_MEDIA, averageScore: 73 }, EMPTY_PREV).score).toBe(7.3);
	});
	test('non-number averageScore -> null', () => {
		expect(buildMangaFromAniList({ ...ANILIST_MEDIA, averageScore: null }, EMPTY_PREV).score).toBeNull();
	});

	test('dates: startDate full -> ISO padded', () => {
		expect(r.publishedFrom).toBe('2018-12-03');
	});
	test('dates: endDate all-null parts -> null', () => {
		expect(r.publishedTo).toBeNull();
	});
	test('dates: partial date (missing day) -> null, not a malformed ISO string', () => {
		const media = { ...ANILIST_MEDIA, startDate: { year: 2018, month: 12, day: null } };
		expect(buildMangaFromAniList(media, EMPTY_PREV).publishedFrom).toBeNull();
	});

	test('description: <br> -> newline, <i> stripped, trimmed', () => {
		expect(r.synopsis).toBe('Denji has been robbed of a normal life ever since his Chainsaw Devil, Pochita, merged with him.\nNow he hunts devils for a living.');
	});

	test('eng_name empty when title.english === title.romaji', () => {
		expect(r.engName).toBe('');
	});
	test('eng_name set when title.english differs from title.romaji', () => {
		const media = { ...ANILIST_MEDIA, title: { romaji: 'Chainsaw Man', english: 'Chainsaw Man EN Alt' } };
		expect(buildMangaFromAniList(media, EMPTY_PREV).engName).toBe('Chainsaw Man EN Alt');
	});

	test('status map: exhaustive', () => {
		const map: Record<string, string> = {
			RELEASING: 'Publishing',
			FINISHED: 'Finished',
			HIATUS: 'On Hiatus',
			CANCELLED: 'Canceled',
			NOT_YET_RELEASED: 'Not Yet Published',
		};
		for (const [anilist, expected] of Object.entries(map)) {
			expect(buildMangaFromAniList({ ...ANILIST_MEDIA, status: anilist }, EMPTY_PREV).status).toBe(expected);
		}
	});

	test('idMal null -> mal_id falls back to prev (preserves existing mal_id, does not clobber)', () => {
		const media = { ...ANILIST_MEDIA, idMal: null };
		const result = buildMangaFromAniList(media, { mal_id: '999' });
		expect(result.malId).toBe('999');
		expect(result.url).toBe('https://myanimelist.net/manga/999');
	});
	test('idMal null + no prev mal_id -> mal_id empty, url falls back to AniList siteUrl', () => {
		const media = { ...ANILIST_MEDIA, idMal: null };
		const result = buildMangaFromAniList(media, EMPTY_PREV);
		expect(result.malId).toBe('');
		expect(result.url).toBe('https://anilist.co/manga/105778');
	});

	test('user-field preservation: read_status/rating/last_read_chapter/rss/mangadex_id carried from prev (shared with buildManga)', () => {
		const prev = {
			read_status: 'Reading',
			rating: '4',
			rating_stars: '⭐️⭐️⭐️⭐️',
			last_read_chapter: '150',
			rss: 'https://x.y/feed.xml',
			mangadex_id: 'abc-123',
			latest_chapter: '213',
			last_chapter_date: '2026-07-16',
		};
		const result = buildMangaFromAniList(ANILIST_MEDIA, prev);
		expect(result.readStatus).toBe('Reading');
		expect(result.rating).toBe('4');
		expect(result.ratingStars).toBe('⭐️⭐️⭐️⭐️');
		expect(result.lastReadChapter).toBe('150');
		expect(result.rss).toBe('https://x.y/feed.xml');
		expect(result.mangadexId).toBe('abc-123');
		expect(result.latestChapter).toBe(213);
		expect(result.lastChapterDate).toBe('2026-07-16');
	});
});

describe('mangaSpec.hasId / isActive — anilist_id counts as an id too', () => {
	test('hasId: anilist_id set, no mal_id -> true', () => {
		expect(mangaSpec.hasId({ anilist_id: '105778' })).toBe(true);
	});
	test('isActive: never enriched (neither id) -> active', () => {
		expect(mangaSpec.isActive({})).toBe(true);
	});
	test('isActive: anilist_id only, Publishing -> active', () => {
		expect(mangaSpec.isActive({ anilist_id: '1', status: 'Publishing', read_status: 'Unread' })).toBe(true);
	});
	test('isActive: anilist_id only, Finished + Read -> static', () => {
		expect(mangaSpec.isActive({ anilist_id: '1', status: 'Finished', read_status: 'Read' })).toBe(false);
	});
});

describe('mangaSpec.resolve — AniList primary', () => {
	function anilistPage(media: any[]) {
		return { data: { Page: { media } } };
	}

	test('unique exact romaji match -> patches anilist_id + mal_id (idMal bridge)', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [] }), // jikan/mangadex: no exact match -> mangadex_id left unset
			httpPostJson: async () => anilistPage([{ id: 105778, idMal: 116778, title: { romaji: 'Chainsaw Man', english: 'Chainsaw Man' } }]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778', anilist_id: '105778' } });
	});

	test('unique exact match via english title only (case-insensitive) -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [] }),
			httpPostJson: async () => anilistPage([{ id: 105778, idMal: 116778, title: { romaji: 'チェンソーマン', english: 'Chainsaw Man' } }]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778', anilist_id: '105778' } });
	});

	test('no exact match, sole AniList result -> accepted (unique-exact fallback rule)', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [] }),
			httpPostJson: async () => anilistPage([{ id: 999, idMal: 888, title: { romaji: 'Some Other Title', english: '' } }]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '888', anilist_id: '999' } });
	});

	test('AniList hit, idMal null (no MAL bridge) -> patch has anilist_id only', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [] }),
			httpPostJson: async () => anilistPage([{ id: 105778, idMal: null, title: { romaji: 'Chainsaw Man', english: 'Chainsaw Man' } }]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { anilist_id: '105778' } });
	});

	test('AniList ambiguous (multiple, no exact) -> falls back to Jikan search, logs anilist candidates', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [{ mal_id: 116778, title: 'Chainsaw Man', title_english: 'Chainsaw Man' }] }),
			httpPostJson: async () =>
				anilistPage([
					{ id: 1, idMal: 1, title: { romaji: 'Foo', english: '' }, startDate: { year: 2020 } },
					{ id: 2, idMal: 2, title: { romaji: 'Bar', english: '' }, startDate: { year: 2021 } },
				]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778' } });
		expect(deps.logCalls.some(m => m.includes('ambiguous') && m.includes('anilist_id=1') && m.includes('Foo') && m.includes('anilist_id=2') && m.includes('Bar'))).toBe(true);
	});

	test('AniList ambiguous AND Jikan also fails to land a unique match -> AniList candidates returned (top 6, label + full patches)', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [] }), // jikan: no results either -> resolveMalId returns null
			httpPostJson: async () =>
				anilistPage([
					{ id: 1, idMal: 11, title: { romaji: 'Foo', english: '' }, startDate: { year: 2020 } },
					{ id: 2, idMal: 22, title: { romaji: 'Bar', english: '' }, startDate: { year: 2021 } },
				]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({
			candidates: [
				{ label: 'Foo (2020)', detail: 'anilist:1', patches: { anilist_id: '1', mal_id: '11' } },
				{ label: 'Bar (2021)', detail: 'anilist:2', patches: { anilist_id: '2', mal_id: '22' } },
			],
		});
	});

	test('AniList ambiguous candidate detail: format · status · first-two story authors · anilist:{id}', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [] }),
			httpPostJson: async () =>
				anilistPage([
					{
						id: 1,
						idMal: 11,
						title: { romaji: 'Foo', english: '' },
						startDate: { year: 2020 },
						format: 'ONE_SHOT',
						status: 'RELEASING',
						staff: {
							edges: [
								{ role: 'Story & Art', node: { name: { full: 'Author One' } } },
								{ role: 'Story', node: { name: { full: 'Author Two' } } },
								{ role: 'Story', node: { name: { full: 'Author Three' } } }, // 3rd Story credit -- dropped, detail caps at 2
								{ role: 'Illustration', node: { name: { full: 'Illustrator Only' } } }, // non-Story role -- excluded
							],
						},
					},
					{ id: 2, idMal: 22, title: { romaji: 'Bar', english: '' }, startDate: { year: 2021 } }, // sparse -- only id survives
				]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({
			candidates: [
				{
					label: 'Foo (2020)',
					detail: 'One Shot · Publishing · Author One, Author Two · anilist:1',
					patches: { anilist_id: '1', mal_id: '11' },
				},
				{ label: 'Bar (2021)', detail: 'anilist:2', patches: { anilist_id: '2', mal_id: '22' } },
			],
		});
	});

	test('AniList miss (empty results) -> falls straight to Jikan, no ambiguous log from AniList side', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [{ mal_id: 116778, title: 'Chainsaw Man', title_english: 'Chainsaw Man' }] }),
			httpPostJson: async () => anilistPage([]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778' } });
		expect(deps.logCalls.some(m => m.includes('anilist_id='))).toBe(false);
	});

	test('AniList search throws generic error -> log, falls back to Jikan (no overall failure)', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [{ mal_id: 116778, title: 'Chainsaw Man', title_english: 'Chainsaw Man' }] }),
			httpPostJson: async () => {
				throw new Error('anilist down');
			},
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778' } });
		expect(deps.logCalls.some(m => m.toLowerCase().includes('anilist'))).toBe(true);
	});

	test('AniList search throws TmdbRateLimitError -> propagates, no Jikan fallback attempted', async () => {
		let jikanCalled = false;
		const deps = makeDeps({
			http: async () => {
				jikanCalled = true;
				return { data: [] };
			},
			httpPostJson: async () => {
				throw new TmdbRateLimitError('429');
			},
		});
		await expect(mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps)).rejects.toBeInstanceOf(TmdbRateLimitError);
		expect(jikanCalled).toBe(false);
	});

	test('AniList hit, no mangadex_id in fm -> mangadex resolve still attempted (best-effort, unchanged)', async () => {
		const deps = makeDeps({
			http: async (url: string) => (url.includes('mangadex.org') ? { data: [{ id: 'a1b2c3d4-uuid', attributes: { title: { en: 'Chainsaw Man' } } }] } : { data: [] }),
			httpPostJson: async () => anilistPage([{ id: 105778, idMal: 116778, title: { romaji: 'Chainsaw Man', english: 'Chainsaw Man' } }]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778', anilist_id: '105778', mangadex_id: 'a1b2c3d4-uuid' } });
	});

	test('mangadex_id already present -> mangadex search skipped, even on an AniList hit', async () => {
		let mangadexCalled = false;
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('mangadex.org')) mangadexCalled = true;
				return { data: [] };
			},
			httpPostJson: async () => anilistPage([{ id: 105778, idMal: 116778, title: { romaji: 'Chainsaw Man', english: 'Chainsaw Man' } }]),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man', mangadex_id: 'existing-uuid' }, ''), deps);
		expect(result).toEqual({ patches: { mal_id: '116778', anilist_id: '105778' } });
		expect(mangadexCalled).toBe(false);
	});

	test('search query includes format_not_in: [NOVEL] to exclude light novels', async () => {
		let capturedQuery = '';
		const deps = makeDeps({
			http: async () => ({ data: [] }),
			httpPostJson: async (url: string, body: any) => {
				capturedQuery = body.query;
				return anilistPage([{ id: 105778, idMal: 116778, title: { romaji: 'Overlord', english: 'Overlord' } }]);
			},
		});
		await mangaSpec.resolve(ctxFor({ title: 'Overlord' }, ''), deps);
		expect(capturedQuery).toContain('format_not_in: [NOVEL]');
	});
});

describe('mangaSpec.sync — AniList primary enrich', () => {
	test('anilist_id present -> fetches Media(id:...), builds AniList record', async () => {
		let captured: any = null;
		const deps = makeDeps({
			httpPostJson: async (url: string, body: unknown) => {
				captured = body;
				return anilistFixture;
			},
		});
		const fm = { anilist_id: '105778', read_status: 'Unread' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect(result!.content).toContain('title: Chainsaw Man');
		expect(result!.content).toContain('anilist_id: 105778');
		expect(result!.content).toContain('mal_id: 116778');
		expect(result!.content).toContain('status: Publishing');
		expect(result!.content).toContain('score: 8.5');
		expect((captured as any).query).toContain('Media');
		expect((captured as any).query).toContain('MANGA');
		expect((captured as any).variables).toEqual({ id: 105778 });
	});

	test('mal_id present, no anilist_id -> fetches Media(idMal:...), backfills anilist_id', async () => {
		let captured: any = null;
		const deps = makeDeps({
			httpPostJson: async (url: string, body: unknown) => {
				captured = body;
				return anilistFixture;
			},
		});
		const fm = { mal_id: '116778', read_status: 'Unread' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect((captured as any).query).toContain('idMal');
		expect((captured as any).variables).toEqual({ id: 116778 });
		expect(result!.content).toContain('anilist_id: 105778');
	});

	test('AniList throw (generic error), mal_id present -> Jikan fallback, prior anilist_id preserved verbatim', async () => {
		const deps = makeDeps({
			httpPostJson: async () => {
				throw new Error('anilist down');
			},
			http: async () => jikanFixture,
		});
		const fm = { anilist_id: '999999', mal_id: '116778', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect(result!.content).toContain('anilist_id: 999999');
		expect(result!.content).toContain('mal_id: 116778');
		expect(result!.content).toContain('latest_chapter: 213');
		expect(deps.logCalls.some(m => m.toLowerCase().includes('anilist'))).toBe(true);
	});

	test('AniList throw, no mal_id available -> no Jikan fallback possible, returns null', async () => {
		let jikanCalled = false;
		const deps = makeDeps({
			httpPostJson: async () => {
				throw new Error('anilist deleted entry');
			},
			http: async () => {
				jikanCalled = true;
				return jikanFixture;
			},
		});
		const result = await mangaSpec.sync(ctxFor({ anilist_id: '105778' }), deps);
		expect(result).toBeNull();
		expect(jikanCalled).toBe(false);
		expect(deps.logCalls.some(m => m.toLowerCase().includes('anilist'))).toBe(true);
	});

	test('AniList throws TmdbRateLimitError -> propagates uncaught, no Jikan fallback attempted', async () => {
		let jikanCalled = false;
		const deps = makeDeps({
			httpPostJson: async () => {
				throw new TmdbRateLimitError('429');
			},
			http: async () => {
				jikanCalled = true;
				return jikanFixture;
			},
		});
		await expect(mangaSpec.sync(ctxFor({ mal_id: '116778' }), deps)).rejects.toBeInstanceOf(TmdbRateLimitError);
		expect(jikanCalled).toBe(false);
	});

	test('chapter cascade (rss) still works on top of an AniList-built record', async () => {
		const deps = makeDeps({
			httpPostJson: async () => anilistFixture,
			httpText: async () => RSS_214,
		});
		const fm = { anilist_id: '105778', rss: 'https://example.com/csm-feed.xml', read_status: 'Read', latest_chapter: '213', last_chapter_date: '2026-07-16' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('latest_chapter: 214');
		expect(result!.content).toContain('read_status: Unread');
		expect(deps.notifyCalls).toEqual(['«Chainsaw Man» ch. 214 out']);
	});
});
