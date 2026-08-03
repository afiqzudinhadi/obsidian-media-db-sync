export interface FeedItem {
	title: string;
	date: string; // ISO (YYYY-MM-DD) or ''
	id: string;
}

const BLOCK_RE = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;

function extractTag(block: string, tag: string): string | null {
	const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const m = re.exec(block);
	return m ? m[1] : null;
}

function unwrapCdata(raw: string): string {
	const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
	return m ? m[1] : raw;
}

function decodeEntities(raw: string): string {
	return raw
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

function cleanText(raw: string | null): string {
	if (raw === null) return '';
	return decodeEntities(unwrapCdata(raw)).trim();
}

function toIsoDate(raw: string | null): string {
	if (!raw) return '';
	const d = new Date(cleanText(raw));
	if (isNaN(d.getTime())) return '';
	return d.toISOString().slice(0, 10);
}

/**
 * RSS 2.0 <item> + Atom <entry>, regex-based (no DOM libs). Entities decoded
 * (&amp; &lt; &gt; &quot; &#39;), CDATA unwrapped. Invalid/missing dates → ''.
 */
export function parseFeed(xml: string): FeedItem[] {
	const items: FeedItem[] = [];
	if (!xml) return items;

	let match: RegExpExecArray | null;
	BLOCK_RE.lastIndex = 0;
	while ((match = BLOCK_RE.exec(xml)) !== null) {
		const block = match[2];
		const title = cleanText(extractTag(block, 'title'));
		const rawDate = extractTag(block, 'pubDate') ?? extractTag(block, 'updated');
		const id = cleanText(extractTag(block, 'guid') ?? extractTag(block, 'id'));
		items.push({ title, date: toIsoDate(rawDate), id });
	}

	return items;
}

const CHAPTER_RE = /(chapter|ch\.?|#)\s*(\d+(\.\d+)?)/i;

/** /(chapter|ch\.?|#)\s*(\d+(\.\d+)?)/i → parseFloat; null when no match */
export function extractChapterNumber(title: string): number | null {
	const m = CHAPTER_RE.exec(title);
	if (!m) return null;
	return parseFloat(m[2]);
}

/**
 * Items assumed newest-first. Picks the item with the highest parseable
 * chapter number; falls back to date ordering (max ISO date) when no item
 * title yields a parseable chapter number.
 */
export function latestChapter(items: FeedItem[]): { chapter: number | null; date: string; title: string } | null {
	if (items.length === 0) return null;

	let best: FeedItem | null = null;
	let bestChapter: number | null = null;

	for (const item of items) {
		const chapter = extractChapterNumber(item.title);
		if (chapter !== null && (bestChapter === null || chapter > bestChapter)) {
			bestChapter = chapter;
			best = item;
		}
	}

	if (best) return { chapter: bestChapter, date: best.date, title: best.title };

	let latest = items[0];
	for (const item of items) {
		if (item.date && (!latest.date || item.date > latest.date)) latest = item;
	}
	return { chapter: null, date: latest.date, title: latest.title };
}
