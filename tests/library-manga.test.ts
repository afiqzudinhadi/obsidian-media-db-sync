import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManga, renderManga, mangaSpec, type MangaRecord } from 'packages/obsidian/src/library/manga';
import type { SpecDeps, LibraryNoteCtx } from 'packages/obsidian/src/library/types';
import jikanFixture from 'tests/fixtures/jikan-manga-csm.json';
import mangadexFixture from 'tests/fixtures/mangadex-feed.json';

const JIKAN_DATA = jikanFixture.data;

const EMPTY_PREV: Record<string, string> = {};

function makeDeps(overrides: Partial<SpecDeps> = {}): SpecDeps & { notifyCalls: string[]; logCalls: string[] } {
	const notifyCalls: string[] = [];
	const logCalls: string[] = [];
	return {
		http: async () => ({}),
		httpText: async () => '',
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
	test('prev Publishing + new Finished + read_status Read -> Unread, flipped', async () => {
		const deps = makeDeps({ http: async () => ({ data: { ...JIKAN_DATA, status: 'Finished' } }) });
		const fm = { mal_id: '116778', status: 'Publishing', read_status: 'Read' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('read_status: Unread');
		expect(result!.content).toContain('status: Finished');
	});
	test('prev Publishing + new Finished + read_status Reading -> no flip', async () => {
		const deps = makeDeps({ http: async () => ({ data: { ...JIKAN_DATA, status: 'Finished' } }) });
		const fm = { mal_id: '116778', status: 'Publishing', read_status: 'Reading' };
		const result = await mangaSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('read_status: Reading');
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

describe('mangaSpec.resolve', () => {
	test('unique exact title match -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [{ mal_id: 116778, title: 'Chainsaw Man', title_english: 'Chainsaw Man' }] }),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ mal_id: '116778' });
	});
	test('no exact match, sole result -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ data: [{ mal_id: 999, title: 'Some Other Title', title_english: '' }] }),
		});
		const result = await mangaSpec.resolve(ctxFor({ title: 'Chainsaw Man' }, ''), deps);
		expect(result).toEqual({ mal_id: '999' });
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
