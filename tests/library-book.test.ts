import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBook, renderBook, bookSpec, type BookRecord } from 'packages/obsidian/src/library/book';
import type { SpecDeps, LibraryNoteCtx } from 'packages/obsidian/src/library/types';
import olFixture from 'tests/fixtures/openlibrary-search.json';

const OL_DOC = olFixture.docs[0];

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

describe('buildBook field mapping', () => {
	const r = buildBook(OL_DOC, EMPTY_PREV);
	test('core fields', () => {
		expect(r.title).toBe('1984');
		expect(r.olid).toBe('OL1168083W');
		expect(r.authors).toEqual(['George Orwell']);
		expect(r.year).toBe(1949);
		expect(r.pages).toBe(328);
		expect(r.poster).toBe('https://covers.openlibrary.org/b/id/12919016-L.jpg');
		expect(r.url).toBe('https://openlibrary.org/works/OL1168083W');
	});
	test('genre capped at 8 (fixture has 14 subjects)', () => {
		expect(r.genre.length).toBe(8);
		expect(r.genre).toEqual([
			'Dystopian fiction',
			'Science fiction',
			'Politics',
			'Totalitarianism',
			'Fiction',
			'Classic literature',
			'Government, resistance to',
			'Surveillance',
		]);
	});
	test('no cover_i -> poster null', () => {
		expect(buildBook({ ...OL_DOC, cover_i: undefined }, EMPTY_PREV).poster).toBeNull();
	});
	test('no first_publish_year/number_of_pages_median -> year/pages null', () => {
		const r2 = buildBook({ ...OL_DOC, first_publish_year: undefined, number_of_pages_median: undefined }, EMPTY_PREV);
		expect(r2.year).toBeNull();
		expect(r2.pages).toBeNull();
	});
});

describe('buildBook user-field preservation', () => {
	test('read_status defaults to Unread', () => {
		expect(buildBook(OL_DOC, EMPTY_PREV).readStatus).toBe('Unread');
	});
	test('read_status carried from prev', () => {
		expect(buildBook(OL_DOC, { read_status: 'Read' }).readStatus).toBe('Read');
	});
	test('rating/rating_stars carried from prev', () => {
		const prev = { rating: '5', rating_stars: '⭐️⭐️⭐️⭐️⭐️' };
		const r = buildBook(OL_DOC, prev);
		expect(r.rating).toBe('5');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️⭐️⭐️');
	});
	test('isbn preserved when prev had it', () => {
		expect(buildBook(OL_DOC, { isbn: '9780451524935' }).isbn).toBe('9780451524935');
	});
	test('isbn empty when prev had none', () => {
		expect(buildBook(OL_DOC, EMPTY_PREV).isbn).toBe('');
	});
	test('authors always fresh from doc.author_name, ignoring any prior authors', () => {
		expect(buildBook(OL_DOC, { authors: '[Someone Else]' }).authors).toEqual(['George Orwell']);
	});
});

describe('buildBook skeleton conversion', () => {
	test('read: true -> read_status Read', () => {
		expect(buildBook(OL_DOC, { read: 'true', personalRating: '' }).readStatus).toBe('Read');
	});
	test('read: false -> read_status Unread', () => {
		expect(buildBook(OL_DOC, { read: 'false', personalRating: '' }).readStatus).toBe('Unread');
	});
	test('personalRating 3 -> rating 3 + 3 stars', () => {
		const r = buildBook(OL_DOC, { read: 'false', personalRating: '3' });
		expect(r.rating).toBe('3');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️');
	});
	test('empty personalRating -> rating 0, no stars', () => {
		const r = buildBook(OL_DOC, { read: 'false', personalRating: '' });
		expect(r.rating).toBe('0');
		expect(r.ratingStars).toBe('');
	});
	test('legacy `author` used only when doc has no author_name', () => {
		const r = buildBook({ ...OL_DOC, author_name: undefined }, { author: 'George Orwell' });
		expect(r.authors).toEqual(['George Orwell']);
	});
	test('no doc author_name and no legacy author -> empty authors', () => {
		const r = buildBook({ ...OL_DOC, author_name: undefined }, EMPTY_PREV);
		expect(r.authors).toEqual([]);
	});
});

describe('renderBook golden', () => {
	const RECORD: BookRecord = {
		title: '1984',
		readStatus: 'Read',
		rating: '5',
		ratingStars: '⭐️⭐️⭐️⭐️⭐️',
		authors: ['George Orwell'],
		year: 1949,
		pages: 328,
		genre: ['Dystopian fiction', 'Science fiction', 'Politics', 'Totalitarianism', 'Fiction', 'Classic literature', 'Government, resistance to', 'Surveillance'],
		olid: 'OL1168083W',
		isbn: '9780451524935',
		poster: 'https://covers.openlibrary.org/b/id/12919016-L.jpg',
		url: 'https://openlibrary.org/works/OL1168083W',
	};

	test('matches canonical book fixture byte-for-byte', () => {
		const expected = readFileSync(join(import.meta.dir, 'fixtures', 'canonical-book.md'), 'utf-8');
		expect(renderBook(RECORD, '', [], 'https://www.goodreads.com/search?q=1984')).toBe(expected);
	});

	test('custom section (Collection) placed after Links, before My Notes', () => {
		const out = renderBook(RECORD, '', [{ heading: 'Collection', content: 'Part of [[Books]]' }], 'https://www.goodreads.com/search?q=1984');
		const linksIdx = out.indexOf('## Links');
		const collectionIdx = out.indexOf('## Collection');
		const myNotesIdx = out.indexOf('## My Notes');
		expect(collectionIdx).toBeGreaterThan(linksIdx);
		expect(myNotesIdx).toBeGreaterThan(collectionIdx);
		expect(out).toContain('## Collection\nPart of [[Books]]\n');
	});

	test('My Notes content preserved', () => {
		const out = renderBook(RECORD, 'reread every few years');
		expect(out).toContain('## My Notes\n\nreread every few years');
	});

	test('no goodreads url -> Links has only Open Library entry', () => {
		const out = renderBook(RECORD, '');
		expect(out).toContain('- [Open Library](https://openlibrary.org/works/OL1168083W)');
		expect(out).not.toContain('[Goodreads]');
	});

	test('no poster -> poster line omitted', () => {
		const r = { ...RECORD, poster: null };
		expect(renderBook(r, '')).not.toContain('![poster');
	});

	test('no authors -> Authors line omitted', () => {
		const r = { ...RECORD, authors: [] };
		expect(renderBook(r, '')).not.toContain('**Authors:**');
	});
});

describe('bookSpec.hasId', () => {
	test('olid set -> true', () => expect(bookSpec.hasId({ olid: 'OL1168083W' })).toBe(true));
	test('olid empty -> false', () => expect(bookSpec.hasId({ olid: '' })).toBe(false));
	test('olid missing -> false', () => expect(bookSpec.hasId({})).toBe(false));
});

describe('bookSpec.isActive', () => {
	test('olid empty -> active (needs first pass)', () => {
		expect(bookSpec.isActive({})).toBe(true);
	});
	test('olid set -> static, regardless of read_status', () => {
		expect(bookSpec.isActive({ olid: 'OL1168083W', read_status: 'Reading' })).toBe(false);
	});
	test('olid set + Read -> static', () => {
		expect(bookSpec.isActive({ olid: 'OL1168083W', read_status: 'Read' })).toBe(false);
	});
	test('olid set + Unread -> static', () => {
		expect(bookSpec.isActive({ olid: 'OL1168083W', read_status: 'Unread' })).toBe(false);
	});
});

function ctxFor(fm: Record<string, string>, body = '## My Notes\n\n'): LibraryNoteCtx {
	return { frontmatter: fm, body, filename: '1984.md' };
}

describe('bookSpec.sync — open library enrich', () => {
	test('no olid -> null (needs resolve first)', async () => {
		const deps = makeDeps();
		const result = await bookSpec.sync(ctxFor({}), deps);
		expect(result).toBeNull();
	});

	test('open library fetch failure -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('network down');
			},
		});
		const result = await bookSpec.sync(ctxFor({ olid: 'OL1168083W', title: '1984' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});

	test('doc not found for olid, no results at all -> null', async () => {
		const deps = makeDeps({ http: async () => ({ docs: [] }) });
		const result = await bookSpec.sync(ctxFor({ olid: 'OL1168083W', title: '1984' }), deps);
		expect(result).toBeNull();
	});

	test('successful enrich -> canonical fm + flipped always false', async () => {
		const deps = makeDeps({ http: async () => olFixture });
		const fm = { olid: 'OL1168083W', title: '1984', read_status: 'Read', rating: '5', rating_stars: '⭐️⭐️⭐️⭐️⭐️' };
		const result = await bookSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('type: book_item');
		expect(result!.content).toContain('olid: OL1168083W');
		expect(result!.content).toContain('authors: [George Orwell]');
		expect(result!.content).toContain('year: 1949');
		expect(result!.content).toContain('pages: 328');
	});

	test('isbn preserved through sync when prev had it', async () => {
		const deps = makeDeps({ http: async () => olFixture });
		const fm = { olid: 'OL1168083W', title: '1984', isbn: '9780451524935' };
		const result = await bookSpec.sync(ctxFor(fm), deps);
		expect(result!.content).toContain('isbn: 9780451524935');
	});

	test('first-pass skeleton conversion: legacy author/read/personalRating/goodreads url -> canonical + Links entry, Collection section preserved', async () => {
		const deps = makeDeps({ http: async () => olFixture });
		const fm = {
			olid: 'OL1168083W',
			title: '1984',
			author: 'George Orwell',
			read: 'false',
			personalRating: '',
			url: 'https://www.goodreads.com/search?q=1984',
		};
		const body = '## Collection\n\nPart of [[Books]]\n\n## My Notes\n\n';
		const result = await bookSpec.sync(ctxFor(fm, body), deps);
		expect(result!.content).toContain('read_status: Unread');
		expect(result!.content).toContain('authors: [George Orwell]');
		expect(result!.content).toContain('- [Open Library](https://openlibrary.org/works/OL1168083W)');
		expect(result!.content).toContain('- [Goodreads](https://www.goodreads.com/search?q=1984)');
		expect(result!.content).toContain('## Collection\n\nPart of [[Books]]\n');
	});

	test('goodreads link carried forward from already-converted body, ignoring canonical fm url', async () => {
		const deps = makeDeps({ http: async () => olFixture });
		const fm = { olid: 'OL1168083W', title: '1984', url: 'https://openlibrary.org/works/OL1168083W' };
		const body = '## Links\n- [Open Library](https://openlibrary.org/works/OL1168083W)\n- [Goodreads](https://www.goodreads.com/search?q=1984)\n\n## My Notes\n\n';
		const result = await bookSpec.sync(ctxFor(fm, body), deps);
		expect(result!.content).toContain('- [Goodreads](https://www.goodreads.com/search?q=1984)');
	});

	test('no goodreads link anywhere -> Links has only Open Library entry', async () => {
		const deps = makeDeps({ http: async () => olFixture });
		const fm = { olid: 'OL1168083W', title: '1984' };
		const result = await bookSpec.sync(ctxFor(fm), deps);
		expect(result!.content).toContain('- [Open Library](https://openlibrary.org/works/OL1168083W)');
		expect(result!.content).not.toContain('[Goodreads]');
	});

	test('My Notes content preserved through sync', async () => {
		const deps = makeDeps({ http: async () => olFixture });
		const fm = { olid: 'OL1168083W', title: '1984' };
		const result = await bookSpec.sync(ctxFor(fm, '## My Notes\n\nreread every few years'), deps);
		expect(result!.content).toContain('## My Notes\n\nreread every few years');
	});
});

describe('bookSpec.resolve', () => {
	test('unique exact title match -> accepted', async () => {
		const deps = makeDeps({ http: async () => olFixture });
		const result = await bookSpec.resolve(ctxFor({ title: '1984' }, ''), deps);
		expect(result).toEqual({ olid: 'OL1168083W' });
	});
	test('no exact match, sole result -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ docs: [{ key: '/works/OL999W', title: 'Some Other Title' }] }),
		});
		const result = await bookSpec.resolve(ctxFor({ title: '1984' }, ''), deps);
		expect(result).toEqual({ olid: 'OL999W' });
	});
	test('ambiguous (multiple results, no exact match) -> null', async () => {
		const deps = makeDeps({
			http: async () => ({
				docs: [
					{ key: '/works/OL1W', title: 'Foo' },
					{ key: '/works/OL2W', title: 'Bar' },
				],
			}),
		});
		const result = await bookSpec.resolve(ctxFor({ title: '1984' }, ''), deps);
		expect(result).toBeNull();
	});
	test('no results -> null', async () => {
		const deps = makeDeps({ http: async () => ({ docs: [] }) });
		const result = await bookSpec.resolve(ctxFor({ title: '1984' }, ''), deps);
		expect(result).toBeNull();
	});
	test('http throws -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('down');
			},
		});
		const result = await bookSpec.resolve(ctxFor({ title: '1984' }, ''), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});
});
