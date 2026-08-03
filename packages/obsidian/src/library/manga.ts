import type { LibraryNoteCtx, MediaTypeSpec, SpecDeps } from 'packages/obsidian/src/library/types';
import { parseFeed, latestChapter } from 'packages/obsidian/src/library/rss';
import { stripQuotes, extractMyNotes, extractCustomSections, type CustomSection } from 'packages/obsidian/src/watchlist/parse';
import { yamlList, yamlScalar, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';
import { deriveReadStatus, deriveRating, parseNumOrNull } from 'packages/obsidian/src/library/convert';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const MANGADEX_BASE = 'https://api.mangadex.org';

export interface MangaRecord {
	title: string;
	engName: string;
	readStatus: string;
	rating: string;
	ratingStars: string;
	lastReadChapter: string;
	latestChapter: number | null;
	lastChapterDate: string;
	chapters: number | null;
	volumes: number | null;
	status: string;
	authors: string[];
	genre: string[];
	score: number | null;
	publishedFrom: string | null;
	publishedTo: string | null;
	malId: string;
	mangadexId: string;
	rss: string;
	poster: string | null;
	url: string;
	synopsis: string;
}

interface ChapterUpdate {
	chapter: number | null;
	date: string;
}

/**
 * Pure mapper: Jikan `/manga/{id}/full` payload (the unwrapped `data` object) + prev
 * frontmatter -> canonical MangaRecord. User-managed fields (read_status, rating,
 * rating_stars, last_read_chapter, rss, mangadex_id, latest_chapter, last_chapter_date)
 * are preserved from prev (with legacy-skeleton fallback); everything else is freshly
 * derived from the Jikan response on every call.
 */
export function buildManga(jikan: any, prev: Record<string, string>): MangaRecord {
	const title: string = jikan.title ?? '';
	const titleEnglish: string = jikan.title_english ?? '';
	const engName = titleEnglish && titleEnglish !== title ? titleEnglish : '';

	const { rating, ratingStars } = deriveRating(prev);
	const readStatus = deriveReadStatus(prev);
	const lastReadChapter = stripQuotes(prev['last_read_chapter']);
	const rss = stripQuotes(prev['rss']);
	const mangadexId = stripQuotes(prev['mangadex_id']);

	const score = typeof jikan.score === 'number' ? Math.round(jikan.score * 10) / 10 : null;

	return {
		title,
		engName,
		readStatus,
		rating,
		ratingStars,
		lastReadChapter,
		latestChapter: parseNumOrNull(prev['latest_chapter']),
		lastChapterDate: stripQuotes(prev['last_chapter_date']),
		chapters: jikan.chapters ?? null,
		volumes: jikan.volumes ?? null,
		status: jikan.status ?? '',
		authors: (jikan.authors ?? []).map((a: any) => a.name).filter(Boolean),
		genre: (jikan.genres ?? []).map((g: any) => g.name).filter(Boolean),
		score,
		publishedFrom: jikan.published?.from ? String(jikan.published.from).slice(0, 10) : null,
		publishedTo: jikan.published?.to ? String(jikan.published.to).slice(0, 10) : null,
		malId: jikan.mal_id != null ? String(jikan.mal_id) : '',
		mangadexId,
		rss,
		poster: jikan.images?.jpg?.large_image_url ?? null,
		url: jikan.url ?? '',
		synopsis: jikan.synopsis ?? '',
	};
}

export function renderManga(r: MangaRecord, myNotes: string, customSections: CustomSection[] = []): string {
	const fm = [
		'---',
		'type: manga_item',
		`title: ${yamlScalar(r.title)}`,
		`eng_name: ${yamlScalar(r.engName)}`,
		`read_status: ${r.readStatus}`,
		`rating: ${r.rating}`,
		`rating_stars: ${r.ratingStars}`,
		`last_read_chapter: ${r.lastReadChapter}`,
		`latest_chapter: ${r.latestChapter ?? 'null'}`,
		`last_chapter_date: ${r.lastChapterDate ? r.lastChapterDate : 'null'}`,
		`chapters: ${r.chapters ?? 'null'}`,
		`volumes: ${r.volumes ?? 'null'}`,
		`status: ${r.status}`,
		`authors: ${yamlList(r.authors)}`,
		`genre: ${yamlList(r.genre)}`,
		`score: ${r.score ?? 'null'}`,
		`published_from: ${r.publishedFrom ? r.publishedFrom : 'null'}`,
		`published_to: ${r.publishedTo ? r.publishedTo : 'null'}`,
		`mal_id: ${r.malId}`,
		`mangadex_id: ${r.mangadexId}`,
		`rss: ${quotedOrNull(r.rss)}`,
		`poster: ${quotedOrNull(r.poster)}`,
		`url: ${quotedOrNull(r.url)}`,
		'tags: [mangas, manga]',
		'---',
	];

	const b: string[] = ['', `# ${r.title}`];
	if (r.engName) b.push(`*${r.engName}*`);
	b.push('');
	if (r.poster) b.push(`![poster|200](${r.poster})`, '');
	const meta = ['**Manga**', ...[r.status, r.score !== null ? String(r.score) : ''].filter(x => x)];
	b.push(meta.join(' · '), '');
	b.push(`**Read Status:** ${r.readStatus}`);
	if (r.rating !== '0' && r.rating !== '' && r.ratingStars) b.push(`**Rating:** ${r.ratingStars} (${r.rating}/5)`);
	if (r.lastReadChapter) {
		const denom = r.latestChapter ?? r.chapters ?? '?';
		b.push(`**Progress:** ch. ${r.lastReadChapter} / ${denom}`);
	}
	b.push('');
	if (r.synopsis) b.push('## Synopsis', r.synopsis, '');
	if (r.authors.length) b.push(`**Authors:** ${r.authors.join(', ')}`, '');
	const links: string[] = [];
	if (r.url) links.push(`- [MAL page](${r.url})`);
	if (r.rss) links.push(`- [RSS feed](${r.rss})`);
	if (links.length) b.push('## Links', ...links, '');
	for (const s of customSections) b.push(`## ${s.heading}`, s.content, '');
	b.push('## My Notes', '', myNotes);
	if (myNotes) b.push('');
	return fm.join('\n') + '\n' + b.join('\n');
}

/** Chapter source cascade: rss (if set) -> mangadex_id (if set) -> null (leave unchanged). */
async function resolveChapterUpdate(fm: Record<string, string>, deps: SpecDeps): Promise<ChapterUpdate | null> {
	const rss = stripQuotes(fm['rss']);
	if (rss) {
		try {
			const xml = await deps.httpText(rss, {});
			const latest = latestChapter(parseFeed(xml));
			if (latest) return { chapter: latest.chapter, date: latest.date };
		} catch (e) {
			deps.log(`manga rss fetch failed (${rss}): ${String(e)}`);
		}
	}

	const mangadexId = stripQuotes(fm['mangadex_id']);
	if (mangadexId) {
		try {
			const url = `${MANGADEX_BASE}/manga/${mangadexId}/feed?order[readableAt]=desc&limit=1&translatedLanguage[]=en`;
			const json = await deps.http(url, {});
			const attrs = json?.data?.[0]?.attributes;
			if (attrs) {
				const chapter = attrs.chapter ? parseFloat(attrs.chapter) : null;
				const date = typeof attrs.readableAt === 'string' ? attrs.readableAt.slice(0, 10) : '';
				return { chapter: Number.isFinite(chapter as number) ? chapter : null, date };
			}
		} catch (e) {
			deps.log(`manga mangadex fetch failed (${mangadexId}): ${String(e)}`);
		}
	}

	return null;
}

function resultTitles(r: any): string[] {
	const titles = [r.title, r.title_english, ...(r.titles ?? []).map((t: any) => t.title)];
	return titles.filter(Boolean).map((t: string) => String(t).toLowerCase());
}

async function resolveMalId(query: string, deps: SpecDeps): Promise<string | null> {
	const qs = new URLSearchParams({ q: query, limit: '10' });
	const res = await deps.http(`${JIKAN_BASE}/manga?${qs.toString()}`, {});
	const results: any[] = res?.data ?? [];
	if (results.length === 0) return null;
	const q = query.toLowerCase();
	const exacts = results.filter(r => resultTitles(r).includes(q));
	const pick = exacts.length === 1 ? exacts[0] : exacts.length === 0 && results.length === 1 ? results[0] : null;
	return pick ? String(pick.mal_id) : null;
}

export const mangaSpec: MediaTypeSpec = {
	typeName: 'manga',
	itemType: 'manga_item',
	folderSettingKey: 'libraryMangaFolder',
	enabledSettingKey: 'libraryMangaEnabled',
	throttleMs: 350,

	hasId(fm: Record<string, string>): boolean {
		return !!stripQuotes(fm['mal_id']);
	},

	isActive(fm: Record<string, string>): boolean {
		const malId = stripQuotes(fm['mal_id']);
		const status = stripQuotes(fm['status']);
		if (!malId || !status) return true; // never enriched -> needs first pass
		if (status === 'Publishing' || status === 'On Hiatus') return true;
		if (stripQuotes(fm['read_status']) === 'Reading') return true;
		if (stripQuotes(fm['rss'])) return true;
		return false; // Finished + Read/Unread/Dropped -> static
	},

	async resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<Record<string, string> | null> {
		const query = stripQuotes(ctx.frontmatter['title']) || ctx.filename.replace(/\.md$/, '');
		if (!query) return null;
		try {
			const malId = await resolveMalId(query, deps);
			return malId ? { mal_id: malId } : null;
		} catch (e) {
			deps.log(`manga resolve failed for "${query}": ${String(e)}`);
			return null;
		}
	},

	async sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null> {
		const fm = ctx.frontmatter;
		const malId = stripQuotes(fm['mal_id']);
		if (!malId) return null; // needs resolve() first

		let jikanData: any;
		try {
			const res = await deps.http(`${JIKAN_BASE}/manga/${malId}/full`, {});
			jikanData = res?.data;
		} catch (e) {
			deps.log(`manga jikan fetch failed (mal_id ${malId}): ${String(e)}`);
			return null;
		}
		if (!jikanData) return null;

		const record = buildManga(jikanData, fm);
		const prevStatus = stripQuotes(fm['status']);
		const prevLatestChapter = parseNumOrNull(fm['latest_chapter']);
		const prevLastChapterDate = stripQuotes(fm['last_chapter_date']);

		let flipped = false;
		const newInfo = await resolveChapterUpdate(fm, deps);
		if (newInfo) {
			const isUpdate = newInfo.chapter !== null ? prevLatestChapter === null || newInfo.chapter > prevLatestChapter : !!newInfo.date && newInfo.date > prevLastChapterDate;
			if (isUpdate) {
				record.latestChapter = newInfo.chapter;
				if (newInfo.date) record.lastChapterDate = newInfo.date;
				if (record.readStatus === 'Read') {
					record.readStatus = 'Unread';
					flipped = true;
					deps.notify(`«${record.title}» ch. ${newInfo.chapter ?? '?'} out`);
				}
			}
		}

		// finish-flip: series completed while user had marked it Read
		if (prevStatus === 'Publishing' && record.status === 'Finished' && record.readStatus === 'Read') {
			record.readStatus = 'Unread';
			flipped = true;
			deps.notify(`«${record.title}» finished — final chapters out`);
		}

		const content = renderManga(record, extractMyNotes(ctx.body), extractCustomSections(ctx.body));
		return { content, flipped };
	},
};
