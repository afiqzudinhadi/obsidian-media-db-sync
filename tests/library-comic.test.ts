import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildComic, renderComic, htmlToPlainText, comicSpec, type ComicRecord } from 'packages/obsidian/src/library/comic';
import type { SpecDeps, LibraryNoteCtx } from 'packages/obsidian/src/library/types';
import comicvineFixture from 'tests/fixtures/comicvine-volume.json';

const CV_RESULT = comicvineFixture.results;

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

function ctxFor(fm: Record<string, string>, body = '## My Notes\n\n'): LibraryNoteCtx {
	return { frontmatter: fm, body, filename: 'Absolute Batman.md' };
}

describe('htmlToPlainText', () => {
	test('strips tags, decodes entities, caps at 2 paragraphs', () => {
		const html = '<p>First &amp; foremost.</p><p>Second paragraph.</p><p>Third dropped.</p>';
		expect(htmlToPlainText(html)).toBe('First & foremost.\n\nSecond paragraph.');
	});
	test('no <p> tags -> whole string treated as one block', () => {
		expect(htmlToPlainText('<b>Bold</b> and plain text.')).toBe('Bold and plain text.');
	});
	test('decodes &lt; &gt; &quot; &#39; &nbsp;', () => {
		expect(htmlToPlainText('<p>&lt;tag&gt; &quot;quoted&quot; it&#39;s&nbsp;fine</p>')).toBe(`<tag> "quoted" it's fine`);
	});
	test('empty string -> empty string', () => {
		expect(htmlToPlainText('')).toBe('');
	});
	test('collapses internal whitespace from stripped tags', () => {
		expect(htmlToPlainText('<p>Line one<br/>Line two</p>')).toBe('Line one Line two');
	});
});

describe('buildComic field mapping', () => {
	const r = buildComic(CV_RESULT, EMPTY_PREV);
	test('core fields', () => {
		expect(r.title).toBe('Absolute Batman');
		expect(r.publisher).toBe('DC Comics');
		expect(r.issues).toBe(10);
		expect(r.startYear).toBe('2024');
		expect(r.comicvineId).toBe('195824');
		expect(r.poster).toBe('https://comicvine.gamespot.com/a/uploads/original/11/absolute-batman.jpg');
		expect(r.url).toBe('https://comicvine.gamespot.com/absolute-batman/4050-195824/');
	});
	test('people mapped from people[].name', () => {
		expect(r.people).toEqual(['Scott Snyder', 'Nick Dragotta']);
	});
	test('description HTML -> plain text, capped at 2 paragraphs', () => {
		expect(r.description).toBe(
			"Batman faces a terrifying new criminal underworld as Gotham City's elite turn against him in this bold reimagining.\n\nWritten by Scott Snyder with art by Nick Dragotta, the series reinvents Bruce Wayne's origin from the ground up.",
		);
		expect(r.description).not.toContain('two-paragraph cap');
	});
	test('no publisher -> empty string', () => {
		expect(buildComic({ ...CV_RESULT, publisher: undefined }, EMPTY_PREV).publisher).toBe('');
	});
	test('no count_of_issues -> issues null', () => {
		expect(buildComic({ ...CV_RESULT, count_of_issues: undefined }, EMPTY_PREV).issues).toBeNull();
	});
	test('no image -> poster null', () => {
		expect(buildComic({ ...CV_RESULT, image: undefined }, EMPTY_PREV).poster).toBeNull();
	});
	test('no people -> empty array', () => {
		expect(buildComic({ ...CV_RESULT, people: undefined }, EMPTY_PREV).people).toEqual([]);
	});
});

describe('buildComic user-field preservation', () => {
	test('read_status defaults to Unread', () => {
		expect(buildComic(CV_RESULT, EMPTY_PREV).readStatus).toBe('Unread');
	});
	test('read_status carried from prev', () => {
		expect(buildComic(CV_RESULT, { read_status: 'Reading' }).readStatus).toBe('Reading');
	});
	test('rating/rating_stars carried from prev', () => {
		const prev = { rating: '4', rating_stars: '⭐️⭐️⭐️⭐️' };
		const r = buildComic(CV_RESULT, prev);
		expect(r.rating).toBe('4');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️⭐️');
	});
	test('last_read_issue carried from prev', () => {
		expect(buildComic(CV_RESULT, { last_read_issue: '8' }).lastReadIssue).toBe('8');
	});
	test('latest_issue carried from prev verbatim (sync() alone updates it)', () => {
		expect(buildComic(CV_RESULT, { latest_issue: '9' }).latestIssue).toBe(9);
	});
	test('status passthrough from prev', () => {
		expect(buildComic(CV_RESULT, { status: 'Hiatus' }).status).toBe('Hiatus');
	});
	test('status defaults to Ongoing when prev has none', () => {
		expect(buildComic(CV_RESULT, EMPTY_PREV).status).toBe('Ongoing');
	});
});

describe('buildComic skeleton conversion', () => {
	test('read: true -> read_status Read', () => {
		expect(buildComic(CV_RESULT, { read: 'true', personalRating: '' }).readStatus).toBe('Read');
	});
	test('read: false -> read_status Unread', () => {
		expect(buildComic(CV_RESULT, { read: 'false', personalRating: '' }).readStatus).toBe('Unread');
	});
	test('personalRating 3 -> rating 3 + 3 stars', () => {
		const r = buildComic(CV_RESULT, { read: 'false', personalRating: '3' });
		expect(r.rating).toBe('3');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️');
	});
	test('empty personalRating -> rating 0, no stars', () => {
		const r = buildComic(CV_RESULT, { read: 'false', personalRating: '' });
		expect(r.rating).toBe('0');
		expect(r.ratingStars).toBe('');
	});
});

describe('renderComic golden', () => {
	const RECORD: ComicRecord = {
		title: 'Absolute Batman',
		readStatus: 'Reading',
		rating: '4',
		ratingStars: '⭐️⭐️⭐️⭐️',
		lastReadIssue: '8',
		latestIssue: 10,
		issues: 10,
		status: 'Ongoing',
		publisher: 'DC Comics',
		people: ['Scott Snyder', 'Nick Dragotta'],
		startYear: '2024',
		comicvineId: '195824',
		poster: 'https://comicvine.gamespot.com/a/uploads/original/11/absolute-batman.jpg',
		url: 'https://comicvine.gamespot.com/absolute-batman/4050-195824/',
		description:
			"Batman faces a terrifying new criminal underworld as Gotham City's elite turn against him in this bold reimagining.\n\nWritten by Scott Snyder with art by Nick Dragotta, the series reinvents Bruce Wayne's origin from the ground up.",
	};

	test('matches canonical comic fixture byte-for-byte', () => {
		const expected = readFileSync(join(import.meta.dir, 'fixtures', 'canonical-comic.md'), 'utf-8');
		expect(renderComic(RECORD, '', [])).toBe(expected);
	});

	test('custom section (Collection) placed after Links, before My Notes', () => {
		const out = renderComic(RECORD, '', [{ heading: 'Collection', content: 'Part of [[Comics]]' }]);
		const linksIdx = out.indexOf('## Links');
		const collectionIdx = out.indexOf('## Collection');
		const myNotesIdx = out.indexOf('## My Notes');
		expect(collectionIdx).toBeGreaterThan(linksIdx);
		expect(myNotesIdx).toBeGreaterThan(collectionIdx);
		expect(out).toContain('## Collection\nPart of [[Comics]]\n');
	});

	test('My Notes content preserved', () => {
		const out = renderComic(RECORD, 'love this reboot');
		expect(out).toContain('## My Notes\n\nlove this reboot');
	});

	test('no last_read_issue -> Progress line omitted', () => {
		const r = { ...RECORD, lastReadIssue: '' };
		expect(renderComic(r, '')).not.toContain('**Progress:**');
	});

	test('Progress denominator falls back to issues when latest_issue null', () => {
		const r = { ...RECORD, latestIssue: null, issues: 12 };
		expect(renderComic(r, '')).toContain('**Progress:** issue 8 / 12');
	});

	test('Progress denominator falls back to ? when both null', () => {
		const r = { ...RECORD, latestIssue: null, issues: null };
		expect(renderComic(r, '')).toContain('**Progress:** issue 8 / ?');
	});

	test('no poster -> poster line omitted', () => {
		const r = { ...RECORD, poster: null };
		expect(renderComic(r, '')).not.toContain('![poster');
	});

	test('no description -> Synopsis section omitted', () => {
		const r = { ...RECORD, description: '' };
		expect(renderComic(r, '')).not.toContain('## Synopsis');
	});

	test('no publisher/people -> fact lines omitted entirely', () => {
		const r = { ...RECORD, publisher: '', people: [] };
		const out = renderComic(r, '');
		expect(out).not.toContain('**Publisher:**');
		expect(out).not.toContain('**Creators:**');
	});
});

describe('comicSpec.hasId', () => {
	test('comicvine_id set -> true', () => expect(comicSpec.hasId({ comicvine_id: '195824' })).toBe(true));
	test('comicvine_id empty -> false', () => expect(comicSpec.hasId({ comicvine_id: '' })).toBe(false));
	test('comicvine_id missing -> false', () => expect(comicSpec.hasId({})).toBe(false));
});

describe('comicSpec.isActive', () => {
	test('comicvine_id empty -> active (needs first pass)', () => {
		expect(comicSpec.isActive({})).toBe(true);
	});
	test('status Ongoing -> active', () => {
		expect(comicSpec.isActive({ comicvine_id: '195824', status: 'Ongoing', read_status: 'Unread' })).toBe(true);
	});
	test('read_status Reading -> active regardless of status', () => {
		expect(comicSpec.isActive({ comicvine_id: '195824', status: 'Ended', read_status: 'Reading' })).toBe(true);
	});
	test('status Ended + read_status Read -> static', () => {
		expect(comicSpec.isActive({ comicvine_id: '195824', status: 'Ended', read_status: 'Read' })).toBe(false);
	});
	test('status Ended + read_status Unread -> static', () => {
		expect(comicSpec.isActive({ comicvine_id: '195824', status: 'Ended', read_status: 'Unread' })).toBe(false);
	});
});

describe('comicSpec.resolve', () => {
	test('no key configured -> null, logged, no network attempted', async () => {
		let httpCalled = false;
		const deps = makeDeps({
			http: async () => {
				httpCalled = true;
				return {};
			},
			getKey: () => '',
		});
		const result = await comicSpec.resolve(ctxFor({ title: 'Absolute Batman' }), deps);
		expect(result).toBeNull();
		expect(httpCalled).toBe(false);
		expect(deps.logCalls.some(m => m.toLowerCase().includes('key'))).toBe(true);
	});

	test('unique exact volume name match -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ results: [{ id: 195824, name: 'Absolute Batman' }] }),
			getKey: () => 'cvkey',
		});
		const result = await comicSpec.resolve(ctxFor({ title: 'Absolute Batman' }), deps);
		expect(result).toEqual({ comicvine_id: '195824' });
	});

	test('no exact match, sole result -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ results: [{ id: 999, name: 'Absolute Batman: Zoo Year' }] }),
			getKey: () => 'cvkey',
		});
		const result = await comicSpec.resolve(ctxFor({ title: 'Absolute Batman' }), deps);
		expect(result).toEqual({ comicvine_id: '999' });
	});

	test('ambiguous (multiple results, no exact match) -> null', async () => {
		const deps = makeDeps({
			http: async () => ({
				results: [
					{ id: 1, name: 'Batman' },
					{ id: 2, name: 'Batman Beyond' },
				],
			}),
			getKey: () => 'cvkey',
		});
		const result = await comicSpec.resolve(ctxFor({ title: 'Absolute Batman' }), deps);
		expect(result).toBeNull();
	});

	test('no results -> null', async () => {
		const deps = makeDeps({ http: async () => ({ results: [] }), getKey: () => 'cvkey' });
		const result = await comicSpec.resolve(ctxFor({ title: 'Absolute Batman' }), deps);
		expect(result).toBeNull();
	});

	test('http throws -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('down');
			},
			getKey: () => 'cvkey',
		});
		const result = await comicSpec.resolve(ctxFor({ title: 'Absolute Batman' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});

	test('no title, no filename fallback -> null (empty query guard)', async () => {
		const deps = makeDeps({ getKey: () => 'cvkey' });
		const ctx: LibraryNoteCtx = { frontmatter: {}, body: '', filename: '.md' };
		const result = await comicSpec.resolve(ctx, deps);
		expect(result).toBeNull();
	});
});

describe('comicSpec.sync — no id / no key', () => {
	test('no comicvine_id -> null (needs resolve first)', async () => {
		const deps = makeDeps({ getKey: () => 'cvkey' });
		const result = await comicSpec.sync(ctxFor({}), deps);
		expect(result).toBeNull();
	});

	test('comicvine_id set, no key -> log, return null', async () => {
		const deps = makeDeps({ getKey: () => '' });
		const result = await comicSpec.sync(ctxFor({ comicvine_id: '195824' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.some(m => m.toLowerCase().includes('key'))).toBe(true);
	});
});

describe('comicSpec.sync — comicvine enrich', () => {
	test('fetch throws -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('network down');
			},
			getKey: () => 'cvkey',
		});
		const result = await comicSpec.sync(ctxFor({ comicvine_id: '195824' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});

	test('empty/malformed results -> identity-guard: log, return null, no write', async () => {
		const deps = makeDeps({ http: async () => ({ results: {} }), getKey: () => 'cvkey' });
		const result = await comicSpec.sync(ctxFor({ comicvine_id: '195824' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.some(m => m.includes('195824'))).toBe(true);
	});

	test('response id mismatch -> identity-guard: log, return null, no write', async () => {
		const deps = makeDeps({ http: async () => ({ results: { ...CV_RESULT, id: 999999 } }), getKey: () => 'cvkey' });
		const result = await comicSpec.sync(ctxFor({ comicvine_id: '195824' }), deps);
		expect(result).toBeNull();
	});

	test('successful enrich, no flip -> canonical fm rendered', async () => {
		const deps = makeDeps({ http: async () => comicvineFixture, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Reading', latest_issue: '10' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result).not.toBeNull();
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('type: comic_item');
		expect(result!.content).toContain('comicvine_id: 195824');
		expect(result!.content).toContain('publisher: DC Comics');
		expect(result!.content).toContain('issues: 10');
		expect(deps.notifyCalls).toEqual([]);
	});

	test('fetches from GET /volume/4050-{id}/ with api_key + format=json', async () => {
		let calledUrl = '';
		const deps = makeDeps({
			http: async (url: string) => {
				calledUrl = url;
				return comicvineFixture;
			},
			getKey: () => 'cvkey',
		});
		await comicSpec.sync(ctxFor({ comicvine_id: '195824' }), deps);
		expect(calledUrl).toContain('/volume/4050-195824/');
		expect(calledUrl).toContain('api_key=cvkey');
		expect(calledUrl).toContain('format=json');
	});
});

describe('comicSpec.sync — issue flip', () => {
	test('read_status Read + numeric last_issue > stored latest_issue -> Unread, flipped, notify', async () => {
		const deps = makeDeps({ http: async () => comicvineFixture, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Read', latest_issue: '9' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('read_status: Unread');
		expect(result!.content).toContain('latest_issue: 10');
		expect(deps.notifyCalls).toEqual(['«Absolute Batman» issue 10 out']);
	});

	test('decimal issue_number ("10.5") -> parseFloat compare, flip', async () => {
		const cv = { results: { ...CV_RESULT, last_issue: { issue_number: '10.5', name: 'Annual' } } };
		const deps = makeDeps({ http: async () => cv, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Read', latest_issue: '10' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(true);
		expect(result!.content).toContain('latest_issue: 10.5');
		expect(deps.notifyCalls).toEqual(['«Absolute Batman» issue 10.5 out']);
	});

	test('new issue <= stored -> no update, no flip', async () => {
		const deps = makeDeps({ http: async () => comicvineFixture, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Read', latest_issue: '10' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_issue: 10');
		expect(deps.notifyCalls).toEqual([]);
	});

	test('non-numeric issue_number -> skip flip, keep prev latest_issue', async () => {
		const cv = { results: { ...CV_RESULT, last_issue: { issue_number: 'Annual', name: 'Special' } } };
		const deps = makeDeps({ http: async () => cv, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Read', latest_issue: '9' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_issue: 9');
		expect(deps.notifyCalls).toEqual([]);
	});

	test('missing last_issue entirely -> skip flip, keep prev latest_issue', async () => {
		const cv = { results: { ...CV_RESULT, last_issue: undefined } };
		const deps = makeDeps({ http: async () => cv, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Read', latest_issue: '9' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_issue: 9');
	});

	test('read_status Reading -> latest_issue updates but never flips', async () => {
		const deps = makeDeps({ http: async () => comicvineFixture, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Reading', latest_issue: '9' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('read_status: Reading');
		expect(result!.content).toContain('latest_issue: 10');
		expect(deps.notifyCalls).toEqual([]);
	});

	test('read_status Unread -> never flipped', async () => {
		const deps = makeDeps({ http: async () => comicvineFixture, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Unread', latest_issue: '9' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('read_status: Unread');
	});

	test('no prev latest_issue -> first-pass update, no flip unless Read', async () => {
		const deps = makeDeps({ http: async () => comicvineFixture, getKey: () => 'cvkey' });
		const fm = { comicvine_id: '195824', read_status: 'Unread' };
		const result = await comicSpec.sync(ctxFor(fm), deps);
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('latest_issue: 10');
	});
});
