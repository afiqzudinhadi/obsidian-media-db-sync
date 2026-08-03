import { describe, expect, test } from 'bun:test';
import { extractChapterNumber, latestChapter, parseFeed } from 'packages/obsidian/src/library/rss';

const rssSample = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Chainsaw Man Updates</title>
<item>
<title>Chainsaw Man Chapter 214</title>
<pubDate>Thu, 30 Jul 2026 12:00:00 GMT</pubDate>
<guid>https://example.com/csm-214</guid>
</item>
<item>
<title>Chainsaw Man Chapter 213.5</title>
<pubDate>Thu, 23 Jul 2026 12:00:00 GMT</pubDate>
<guid>https://example.com/csm-213-5</guid>
</item>
<item>
<title>Chainsaw Man Chapter 213</title>
<pubDate>Thu, 16 Jul 2026 12:00:00 GMT</pubDate>
<guid>https://example.com/csm-213</guid>
</item>
</channel>
</rss>`;

const atomSample = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Some Manga Feed</title>
<entry>
<title>Ch. 12 — name</title>
<updated>2026-08-01T09:30:00Z</updated>
<id>https://example.com/entry/12</id>
</entry>
</feed>`;

const cdataSample = `<rss version="2.0"><channel><item>
<title><![CDATA[One Piece Chapter 1120]]></title>
<pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate>
<guid>id-cdata</guid>
</item></channel></rss>`;

const entitySample = `<rss version="2.0"><channel><item>
<title>Attack &amp; Titan &#39;Special&#39; Chapter 5</title>
<pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate>
<guid>id-entity</guid>
</item></channel></rss>`;

const numberlessSample = `<rss version="2.0"><channel>
<item>
<title>Chainsaw Man - Extra Announcement</title>
<pubDate>Thu, 30 Jul 2026 12:00:00 GMT</pubDate>
<guid>a</guid>
</item>
<item>
<title>Chainsaw Man - Fan Art Contest</title>
<pubDate>Thu, 16 Jul 2026 12:00:00 GMT</pubDate>
<guid>b</guid>
</item>
</channel></rss>`;

describe('parseFeed', () => {
	test('RSS 2.0 — 3 items, title/date/id mapped, newest first as-authored', () => {
		const items = parseFeed(rssSample);
		expect(items).toEqual([
			{ title: 'Chainsaw Man Chapter 214', date: '2026-07-30', id: 'https://example.com/csm-214' },
			{ title: 'Chainsaw Man Chapter 213.5', date: '2026-07-23', id: 'https://example.com/csm-213-5' },
			{ title: 'Chainsaw Man Chapter 213', date: '2026-07-16', id: 'https://example.com/csm-213' },
		]);
	});

	test('Atom — entry title/updated/id mapped', () => {
		const items = parseFeed(atomSample);
		expect(items).toEqual([{ title: 'Ch. 12 — name', date: '2026-08-01', id: 'https://example.com/entry/12' }]);
	});

	test('CDATA title unwrapped', () => {
		const items = parseFeed(cdataSample);
		expect(items[0].title).toBe('One Piece Chapter 1120');
	});

	test('entity-encoded title decoded', () => {
		const items = parseFeed(entitySample);
		expect(items[0].title).toBe(`Attack & Titan 'Special' Chapter 5`);
	});

	test('empty xml → []', () => {
		expect(parseFeed('')).toEqual([]);
	});

	test('garbage xml → []', () => {
		expect(parseFeed('not xml at all, just some random text')).toEqual([]);
	});
});

describe('extractChapterNumber', () => {
	test('"Chapter 214" → 214', () => {
		expect(extractChapterNumber('Chapter 214')).toBe(214);
	});
	test('"ch.213.5" → 213.5', () => {
		expect(extractChapterNumber('ch.213.5')).toBe(213.5);
	});
	test('"#77" → 77', () => {
		expect(extractChapterNumber('#77')).toBe(77);
	});
	test('"Episode 5" → null', () => {
		expect(extractChapterNumber('Episode 5')).toBeNull();
	});
	test('"Vol. 3 Chapter 21" → 21', () => {
		expect(extractChapterNumber('Vol. 3 Chapter 21')).toBe(21);
	});
	test('numberless title → null', () => {
		expect(extractChapterNumber('Chainsaw Man - Extra Announcement')).toBeNull();
	});
});

describe('latestChapter', () => {
	test('empty items → null', () => {
		expect(latestChapter([])).toBeNull();
	});

	test('RSS sample → highest chapter (214) wins', () => {
		const result = latestChapter(parseFeed(rssSample));
		expect(result).toEqual({ chapter: 214, date: '2026-07-30', title: 'Chainsaw Man Chapter 214' });
	});

	test('Atom sample → single entry chapter 12', () => {
		const result = latestChapter(parseFeed(atomSample));
		expect(result).toEqual({ chapter: 12, date: '2026-08-01', title: 'Ch. 12 — name' });
	});

	test('numberless titles → date-based fallback, chapter null', () => {
		const result = latestChapter(parseFeed(numberlessSample));
		expect(result).toEqual({ chapter: null, date: '2026-07-30', title: 'Chainsaw Man - Extra Announcement' });
	});
});
