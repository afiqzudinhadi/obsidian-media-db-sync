import type { LibraryNoteCtx, MediaTypeSpec, ResolveCandidate, ResolveOutcome, SpecDeps } from 'packages/obsidian/src/library/types';
import { parseFeed, latestChapter } from 'packages/obsidian/src/library/rss';
import { stripQuotes, extractMyNotes, extractCustomSections, type CustomSection } from 'packages/obsidian/src/watchlist/parse';
import { yamlList, yamlScalar, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';
import { deriveReadStatus, deriveRating, parseNumOrNull } from 'packages/obsidian/src/library/convert';
import { TmdbRateLimitError } from 'packages/obsidian/src/watchlist/SyncEngine';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const MANGADEX_BASE = 'https://api.mangadex.org';
const ANILIST_BASE = 'https://graphql.anilist.co';

// AniList field selection shared by the search + both by-id queries below. `status` comes back
// as an ALL_CAPS enum (mapped via ANILIST_STATUS_MAP); dates come back as {year,month,day}
// objects (mapped via aniListDate); description is HTML (mapped via stripAniListHtml).
const ANILIST_MEDIA_FIELDS = `
	id
	idMal
	title { romaji english }
	format
	status
	chapters
	volumes
	averageScore
	genres
	staff(perPage: 6) {
		edges { role node { name { full } } }
	}
	startDate { year month day }
	endDate { year month day }
	description(asHtml: false)
	coverImage { large }
	siteUrl
`;

const ANILIST_SEARCH_QUERY = `query ($q: String) {
	Page(perPage: 8) {
		media(search: $q, type: MANGA, format_not_in: [NOVEL]) {
			${ANILIST_MEDIA_FIELDS}
		}
	}
}`;

const ANILIST_BY_ID_QUERY = `query ($id: Int) {
	Media(id: $id, type: MANGA) {
		${ANILIST_MEDIA_FIELDS}
	}
}`;

const ANILIST_BY_IDMAL_QUERY = `query ($id: Int) {
	Media(idMal: $id, type: MANGA) {
		${ANILIST_MEDIA_FIELDS}
	}
}`;

const ANILIST_STATUS_MAP: Record<string, string> = {
	RELEASING: 'Publishing',
	FINISHED: 'Finished',
	HIATUS: 'On Hiatus',
	CANCELLED: 'Canceled',
	NOT_YET_RELEASED: 'Not Yet Published',
};

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
	anilistId: string;
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

/** `quotedOrNull` renders empty values as the literal `null` token -- strip that sentinel back
 * to '' so a prior blank rss/last_chapter_date never round-trips as a truthy value (never fetched
 * as a URL, never wins a string date comparison). */
function stripNullSentinel(s: string): string {
	return s === 'null' ? '' : s;
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
	const rss = stripNullSentinel(stripQuotes(prev['rss']));
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
		lastChapterDate: stripNullSentinel(stripQuotes(prev['last_chapter_date'])),
		chapters: jikan.chapters ?? null,
		volumes: jikan.volumes ?? null,
		status: jikan.status ?? '',
		authors: (jikan.authors ?? []).map((a: any) => a.name).filter(Boolean),
		genre: (jikan.genres ?? []).map((g: any) => g.name).filter(Boolean),
		score,
		publishedFrom: jikan.published?.from ? String(jikan.published.from).slice(0, 10) : null,
		publishedTo: jikan.published?.to ? String(jikan.published.to).slice(0, 10) : null,
		malId: jikan.mal_id != null ? String(jikan.mal_id) : '',
		anilistId: stripQuotes(prev['anilist_id']), // Jikan has no AniList concept -- carried through untouched
		mangadexId,
		rss,
		poster: jikan.images?.jpg?.large_image_url ?? null,
		url: jikan.url ?? '',
		synopsis: jikan.synopsis ?? '',
	};
}

/**
 * Pure mapper: prev frontmatter only (no API payload) -> canonical MangaRecord, for id-less
 * notes that can never be resolved (or haven't been resolved yet) but still need a canonical
 * `manga_item` shape so they aren't permanently invisible to type-filtered Bases queries.
 * User-managed fields go through the same derive helpers as buildManga/buildMangaFromAniList;
 * everything API-derived (chapters, volumes, status, authors, genre, score, dates, poster,
 * synopsis) is empty/null -- there's no source to pull it from. `title` falls back to the
 * filename (minus `.md`) when the note has no title field at all.
 */
export function buildMangaLocal(prev: Record<string, string>, filename: string): MangaRecord {
	const title = stripQuotes(prev['title']) || filename.replace(/\.md$/, '');
	const { rating, ratingStars } = deriveRating(prev);
	const readStatus = deriveReadStatus(prev);
	const lastReadChapter = stripQuotes(prev['last_read_chapter']);
	const rss = stripNullSentinel(stripQuotes(prev['rss']));
	const mangadexId = stripQuotes(prev['mangadex_id']);
	const malId = stripQuotes(prev['mal_id']);
	const anilistId = stripQuotes(prev['anilist_id']);

	return {
		title,
		engName: '',
		readStatus,
		rating,
		ratingStars,
		lastReadChapter,
		latestChapter: parseNumOrNull(prev['latest_chapter']),
		lastChapterDate: stripNullSentinel(stripQuotes(prev['last_chapter_date'])),
		chapters: null,
		volumes: null,
		status: '',
		authors: [],
		genre: [],
		score: null,
		publishedFrom: null,
		publishedTo: null,
		malId,
		anilistId,
		mangadexId,
		rss,
		poster: null,
		url: malId ? `https://myanimelist.net/manga/${malId}` : '',
		synopsis: '',
	};
}

/** AniList `{year,month,day}` date object -> ISO `YYYY-MM-DD`, or null when any part is missing
 * (AniList leaves in-progress end dates as all-null rather than omitting the object). */
function aniListDate(d: { year?: number | null; month?: number | null; day?: number | null } | null | undefined): string | null {
	if (!d || d.year == null || d.month == null || d.day == null) return null;
	const mm = String(d.month).padStart(2, '0');
	const dd = String(d.day).padStart(2, '0');
	return `${d.year}-${mm}-${dd}`;
}

/** AniList `description(asHtml:false)` still carries a handful of literal tags (`<br>`, `<i>`,
 * etc.) and HTML entities -- strip both down to plain text for the synopsis field. */
function stripAniListHtml(html: string | null | undefined): string {
	if (!html) return '';
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/?[^>]+(>|$)/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.trim();
}

/** Story-role staff (author-equivalent) off an AniList `Media` payload -- shared by record-building
 * (`buildMangaFromAniList`) and the ambiguous-resolve picker detail (`candidateAniListDetail`). */
function aniListStoryAuthors(media: any): string[] {
	return ((media?.staff?.edges ?? []) as any[])
		.filter(e => typeof e?.role === 'string' && e.role.includes('Story'))
		.map(e => e?.node?.name?.full)
		.filter(Boolean);
}

/**
 * Pure mapper: AniList `Media` payload (the unwrapped `data.Media` object) + prev frontmatter ->
 * canonical MangaRecord. Mirrors `buildManga`'s user-field preservation contract exactly; only
 * the upstream field mapping differs. `mal_id` prefers AniList's `idMal` bridge but falls back to
 * whatever mal_id the note already carried -- AniList entries without a MAL counterpart (e.g.
 * webtoons) must not clobber a manually-set mal_id.
 */
export function buildMangaFromAniList(media: any, prev: Record<string, string>): MangaRecord {
	const romaji: string = media.title?.romaji ?? '';
	const english: string = media.title?.english ?? '';
	const engName = english && english !== romaji ? english : '';

	const { rating, ratingStars } = deriveRating(prev);
	const readStatus = deriveReadStatus(prev);
	const lastReadChapter = stripQuotes(prev['last_read_chapter']);
	const rss = stripNullSentinel(stripQuotes(prev['rss']));
	const mangadexId = stripQuotes(prev['mangadex_id']);

	const score = typeof media.averageScore === 'number' ? Math.round(media.averageScore) / 10 : null;

	const malId = media.idMal != null ? String(media.idMal) : stripQuotes(prev['mal_id']);
	const anilistId = media.id != null ? String(media.id) : stripQuotes(prev['anilist_id']);

	const authors = aniListStoryAuthors(media);

	return {
		title: romaji,
		engName,
		readStatus,
		rating,
		ratingStars,
		lastReadChapter,
		latestChapter: parseNumOrNull(prev['latest_chapter']),
		lastChapterDate: stripNullSentinel(stripQuotes(prev['last_chapter_date'])),
		chapters: media.chapters ?? null,
		volumes: media.volumes ?? null,
		status: ANILIST_STATUS_MAP[media.status as string] ?? '',
		authors,
		genre: (media.genres ?? []).filter(Boolean),
		score,
		publishedFrom: aniListDate(media.startDate),
		publishedTo: aniListDate(media.endDate),
		malId,
		anilistId,
		mangadexId,
		rss,
		poster: media.coverImage?.large ?? null,
		// existing url convention = MAL page; only fall back to AniList's own page when the note
		// (still) has no mal_id at all -- e.g. AniList-only webtoons with no MAL counterpart
		url: malId ? `https://myanimelist.net/manga/${malId}` : (media.siteUrl ?? ''),
		synopsis: stripAniListHtml(media.description),
	};
}

/** `Media(id|idMal: ...)` fetch -- throws (never returns a partial/null record) on GraphQL
 * errors or a missing `Media` so callers can uniformly catch-and-fallback to Jikan. */
async function fetchAniListMedia(deps: SpecDeps, query: string, variables: Record<string, unknown>): Promise<any> {
	const res = await deps.httpPostJson(ANILIST_BASE, { query, variables }, {});
	if (res?.errors?.length) throw new Error(`AniList error: ${res.errors[0]?.message ?? 'unknown'}`);
	const media = res?.data?.Media;
	if (!media) throw new Error('AniList: media not found');
	return media;
}

/** `Page.media` search -- unlike `fetchAniListMedia`, a genuine empty result set is NOT an
 * error (it's a legitimate "no matches", same as Jikan's search returning `data: []`); only
 * GraphQL/network failures throw. */
async function fetchAniListSearch(deps: SpecDeps, q: string): Promise<any[]> {
	const res = await deps.httpPostJson(ANILIST_BASE, { query: ANILIST_SEARCH_QUERY, variables: { q } }, {});
	if (res?.errors?.length) throw new Error(`AniList error: ${res.errors[0]?.message ?? 'unknown'}`);
	return res?.data?.Page?.media ?? [];
}

function aniListTitles(m: any): string[] {
	const titles = [m?.title?.romaji, m?.title?.english];
	return titles.filter(Boolean).map((t: string) => String(t).toLowerCase());
}

/** Top-candidate identifying info for ambiguous-resolve logging (AniList side). */
function candidateAniListSummary(m: any): string {
	const year = m?.startDate?.year ? String(m.startDate.year) : '';
	return `anilist_id=${m?.id ?? ''} «${m?.title?.romaji ?? ''}»${year ? ` (${year})` : ''}`;
}

/** Human-readable picker label (AniList side) -- same title/year info as candidateAniListSummary, minus the id prefix. */
function candidateAniListLabel(m: any): string {
	const title = m?.title?.romaji || m?.title?.english || '';
	const year = m?.startDate?.year ? String(m.startDate.year) : '';
	return year ? `${title} (${year})` : title;
}

/** AniList `format` enum ("ONE_SHOT") -> Title Case ("One Shot"), or '' when absent. */
function aniListFormatLabel(format: unknown): string {
	if (typeof format !== 'string' || !format) return '';
	return format
		.toLowerCase()
		.split('_')
		.filter(Boolean)
		.map(w => w[0].toUpperCase() + w.slice(1))
		.join(' ');
}

/** Picker second line (AniList side): format · status · first-two story authors · anilist:{id} --
 * whichever pieces the candidate actually has (search results are sparser than a full Media fetch). */
function candidateAniListDetail(m: any): string | undefined {
	const format = aniListFormatLabel(m?.format);
	const status = ANILIST_STATUS_MAP[m?.status as string] ?? '';
	const authors = aniListStoryAuthors(m).slice(0, 2).join(', ');
	const id = m?.id != null ? `anilist:${m.id}` : '';
	const parts = [format, status, authors, id].filter(Boolean);
	return parts.length ? parts.join(' · ') : undefined;
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
		`anilist_id: ${r.anilistId}`,
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
	const rss = stripNullSentinel(stripQuotes(fm['rss']));
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

/** Top-candidate identifying info for ambiguous-resolve logging. */
function candidateSummary(r: any): string {
	const year = r.published?.from ? String(r.published.from).slice(0, 4) : '';
	return `mal_id=${r.mal_id ?? ''} «${r.title ?? ''}»${year ? ` (${year})` : ''}`;
}

async function resolveMalId(query: string, deps: SpecDeps): Promise<string | null> {
	const qs = new URLSearchParams({ q: query, limit: '10' });
	const res = await deps.http(`${JIKAN_BASE}/manga?${qs.toString()}`, {});
	const results: any[] = res?.data ?? [];
	if (results.length === 0) return null;
	const q = query.toLowerCase();
	const exacts = results.filter(r => resultTitles(r).includes(q));
	const pick = exacts.length === 1 ? exacts[0] : exacts.length === 0 && results.length === 1 ? results[0] : null;
	if (!pick) {
		deps.log(`ambiguous "${query}": candidates: ${results.slice(0, 3).map(candidateSummary).join('; ')}`);
	}
	return pick ? String(pick.mal_id) : null;
}

/** MangaDex `attributes.title` is a lang->string object; `attributes.altTitles` an array of the
 * same shape -- collect every string value across both for the unique-exact title match. */
function mangaDexTitles(r: any): string[] {
	const titleObj: Record<string, string> = r?.attributes?.title ?? {};
	const altTitleObjs: Record<string, string>[] = r?.attributes?.altTitles ?? [];
	const titles = [...Object.values(titleObj), ...altTitleObjs.flatMap(o => Object.values(o))];
	return titles.filter(Boolean).map((t: string) => String(t).toLowerCase());
}

/** Best-effort MangaDex id resolve, run only when the note has no mangadex_id yet. Failure of any
 * kind (network error, no match, ambiguous match) is non-fatal to the overall resolve() -- it's
 * logged and simply skipped, leaving the mal_id patch (if any) as the only result. */
async function resolveMangadexId(query: string, deps: SpecDeps): Promise<string | null> {
	try {
		const qs = new URLSearchParams({ title: query, limit: '10' });
		const res = await deps.http(`${MANGADEX_BASE}/manga?${qs.toString()}`, {});
		const results: any[] = res?.data ?? [];
		if (results.length === 0) return null;
		const q = query.toLowerCase();
		const exacts = results.filter(r => mangaDexTitles(r).includes(q));
		const pick = exacts.length === 1 ? exacts[0] : exacts.length === 0 && results.length === 1 ? results[0] : null;
		return pick?.id ? String(pick.id) : null;
	} catch (e) {
		deps.log(`manga mangadex resolve failed for "${query}": ${String(e)}`);
		return null;
	}
}

export const mangaSpec: MediaTypeSpec = {
	typeName: 'manga',
	itemType: 'manga_item',
	folderSettingKey: 'libraryMangaFolder',
	enabledSettingKey: 'libraryMangaEnabled',
	throttleMs: 700, // AniList's keyless rate limit is 90 req/min

	hasId(fm: Record<string, string>): boolean {
		return !!stripQuotes(fm['mal_id']) || !!stripQuotes(fm['anilist_id']);
	},

	isActive(fm: Record<string, string>): boolean {
		const malId = stripQuotes(fm['mal_id']);
		const anilistId = stripQuotes(fm['anilist_id']);
		const status = stripQuotes(fm['status']);
		if ((!malId && !anilistId) || !status) return true; // never enriched -> needs first pass
		if (status === 'Publishing' || status === 'On Hiatus') return true;
		if (stripQuotes(fm['read_status']) === 'Reading') return true;
		if (stripNullSentinel(stripQuotes(fm['rss']))) return true;
		return false; // Finished + Read/Unread/Dropped -> static
	},

	// AniList-primary: search AniList first (Page search, unique-exact vs romaji+english). A
	// unique hit patches anilist_id (+ mal_id via idMal, when AniList has a MAL bridge for it).
	// AniList miss/ambiguous/throw all fall back to the existing Jikan title-search resolve.
	// When BOTH AniList and Jikan fail to land a unique match, an AniList-ambiguous result set
	// (2+ exacts, or 0-exact-multi) is offered back to the caller as candidates for the user to
	// pick from, instead of a bare null -- Jikan-only ambiguity (AniList had 0/1 results) still
	// returns null unchanged, since AniList carries the richer id bridge worth surfacing.
	// TmdbRateLimitError is never treated as a fallback trigger -- it propagates so the engine's
	// withRateLimitRetry wrapper (around the whole resolve() call) retries instead of masking a
	// transient 429 as an AniList miss.
	async resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<ResolveOutcome | null> {
		const query = stripQuotes(ctx.frontmatter['title']) || ctx.filename.replace(/\.md$/, '');
		if (!query) return null;

		let anilistResults: any[] = [];
		try {
			anilistResults = await fetchAniListSearch(deps, query);
		} catch (e) {
			if (e instanceof TmdbRateLimitError) throw e;
			deps.log(`manga anilist resolve failed for "${query}": ${String(e)}`);
			anilistResults = [];
		}

		const q = query.toLowerCase();
		const exactAni = anilistResults.filter(m => aniListTitles(m).includes(q));
		const pickAni = exactAni.length === 1 ? exactAni[0] : exactAni.length === 0 && anilistResults.length === 1 ? anilistResults[0] : null;

		if (pickAni) {
			const patch: Record<string, string> = { anilist_id: String(pickAni.id) };
			if (pickAni.idMal != null) patch.mal_id = String(pickAni.idMal);
			if (!stripQuotes(ctx.frontmatter['mangadex_id'])) {
				const mangadexId = await resolveMangadexId(query, deps);
				if (mangadexId) patch.mangadex_id = mangadexId;
			}
			return { patches: patch };
		}

		let anilistCandidates: ResolveCandidate[] = [];
		if (anilistResults.length > 1) {
			deps.log(`ambiguous "${query}": candidates: ${anilistResults.slice(0, 3).map(candidateAniListSummary).join('; ')}`);
			anilistCandidates = anilistResults.slice(0, 6).map(m => {
				const patch: Record<string, string> = { anilist_id: String(m.id) };
				if (m.idMal != null) patch.mal_id = String(m.idMal);
				return { label: candidateAniListLabel(m), detail: candidateAniListDetail(m), patches: patch };
			});
		}

		// Jikan fallback (unchanged behavior)
		let malId: string | null;
		try {
			malId = await resolveMalId(query, deps);
		} catch (e) {
			if (e instanceof TmdbRateLimitError) throw e;
			deps.log(`manga resolve failed for "${query}": ${String(e)}`);
			return anilistCandidates.length ? { candidates: anilistCandidates } : null;
		}
		if (!malId) return anilistCandidates.length ? { candidates: anilistCandidates } : null;

		const patch: Record<string, string> = { mal_id: malId };
		// best-effort: only attempt when the note doesn't already carry a mangadex_id
		if (!stripQuotes(ctx.frontmatter['mangadex_id'])) {
			const mangadexId = await resolveMangadexId(query, deps);
			if (mangadexId) patch.mangadex_id = mangadexId;
		}
		return { patches: patch };
	},

	// AniList-primary: anilist_id present -> fetch by id; else mal_id -> fetch by idMal bridge.
	// AniList throwing (network error, GraphQL error, not-found) falls back to the existing Jikan
	// full-record fetch when a mal_id is available; with no mal_id there's no fallback path, so
	// the sync is skipped (skippedNoData upstream). TmdbRateLimitError propagates uncaught (same
	// retry-not-fallback reasoning as resolve() above).
	async sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null> {
		const fm = ctx.frontmatter;
		const malId = stripQuotes(fm['mal_id']);
		const anilistId = stripQuotes(fm['anilist_id']);
		if (!malId && !anilistId) return null; // needs resolve() first

		let record: MangaRecord;
		try {
			const media = anilistId
				? await fetchAniListMedia(deps, ANILIST_BY_ID_QUERY, { id: Number(anilistId) })
				: await fetchAniListMedia(deps, ANILIST_BY_IDMAL_QUERY, { id: Number(malId) });
			record = buildMangaFromAniList(media, fm);
		} catch (e) {
			if (e instanceof TmdbRateLimitError) throw e;
			deps.log(`manga anilist fetch failed (${anilistId ? `anilist_id ${anilistId}` : `mal_id ${malId}`}): ${String(e)}`);
			if (!malId) return null; // no mal_id -> no Jikan fallback possible

			let jikanData: any;
			try {
				const res = await deps.http(`${JIKAN_BASE}/manga/${malId}/full`, {});
				jikanData = res?.data;
			} catch (e2) {
				if (e2 instanceof TmdbRateLimitError) throw e2;
				deps.log(`manga jikan fetch failed (mal_id ${malId}): ${String(e2)}`);
				return null;
			}
			if (!jikanData) return null;
			record = buildManga(jikanData, fm);
		}

		const prevStatus = stripQuotes(fm['status']);
		const prevLatestChapter = parseNumOrNull(fm['latest_chapter']);
		const prevLastChapterDate = stripNullSentinel(stripQuotes(fm['last_chapter_date']));

		let flipped = false;
		const newInfo = await resolveChapterUpdate(fm, deps);
		if (newInfo) {
			const chapterMode = newInfo.chapter !== null;
			const prevPresent = chapterMode ? prevLatestChapter !== null : !!prevLastChapterDate;
			const isUpdate = chapterMode
				? prevLatestChapter === null || newInfo.chapter! > prevLatestChapter
				: !prevLastChapterDate || (!!newInfo.date && newInfo.date > prevLastChapterDate);
			if (isUpdate) {
				record.latestChapter = newInfo.chapter;
				if (newInfo.date) record.lastChapterDate = newInfo.date;
				// seed pass (no prior stored baseline) -- record it as the new baseline, never
				// flip/notify: mirrors watchlist build.ts's `prevLast &&` guard, there's no "new"
				// chapter relative to an unknown starting point
				if (prevPresent && record.readStatus === 'Read') {
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

	convertLocal(ctx: LibraryNoteCtx): string {
		const record = buildMangaLocal(ctx.frontmatter, ctx.filename);
		return renderManga(record, extractMyNotes(ctx.body), extractCustomSections(ctx.body));
	},
};
