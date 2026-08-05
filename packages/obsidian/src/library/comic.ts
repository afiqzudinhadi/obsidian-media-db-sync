import type { LibraryNoteCtx, MediaTypeSpec, SpecDeps } from 'packages/obsidian/src/library/types';
import { stripQuotes, extractMyNotes, extractCustomSections, type CustomSection } from 'packages/obsidian/src/watchlist/parse';
import { yamlList, yamlScalar, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';
import { deriveReadStatus, deriveRating, parseNumOrNull } from 'packages/obsidian/src/library/convert';

const COMICVINE_BASE = 'https://comicvine.gamespot.com/api';

export interface ComicRecord {
	title: string;
	readStatus: string;
	rating: string;
	ratingStars: string;
	lastReadIssue: string;
	latestIssue: number | null;
	issues: number | null;
	status: string;
	publisher: string;
	people: string[];
	startYear: string;
	comicvineId: string;
	poster: string | null;
	url: string;
	description: string;
}

/**
 * status is a manual/passthrough field -- Comic Vine's volume payload carries no reliable
 * "still publishing" signal (no last-issue date), so we deliberately do NOT invent any
 * date-based heuristic here. Whatever the note already has wins; only a never-synced note
 * (empty status) defaults to 'Ongoing'.
 */
function deriveStatus(prev: Record<string, string>): string {
	return stripQuotes(prev['status']) || 'Ongoing';
}

function decodeEntities(raw: string): string {
	return raw
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

/**
 * Comic Vine `description` -> plain text: split on <p> blocks (whole string treated as one
 * block when there are none), strip remaining tags, decode entities, collapse whitespace,
 * keep only the first 2 paragraphs.
 */
export function htmlToPlainText(html: string): string {
	if (!html) return '';
	const paraMatches = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
	const blocks = paraMatches && paraMatches.length ? paraMatches : [html];
	const paragraphs = blocks
		.map(b => decodeEntities(b.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
		.filter(Boolean);
	return paragraphs.slice(0, 2).join('\n\n');
}

/**
 * Pure mapper: Comic Vine `/volume/{id}/` payload (the unwrapped `results` object) + prev
 * frontmatter -> canonical ComicRecord. User-managed fields (read_status, rating,
 * rating_stars, last_read_issue, status) are preserved from prev (with legacy-skeleton
 * fallback); latest_issue is carried from prev as-is here -- sync() alone decides whether a
 * new last_issue.issue_number supersedes it (and whether that flips read_status). Everything
 * else is freshly derived from the Comic Vine response on every call.
 */
export function buildComic(cv: any, prev: Record<string, string>): ComicRecord {
	const title: string = cv.name ?? '';
	const { rating, ratingStars } = deriveRating(prev);
	const readStatus = deriveReadStatus(prev);
	const lastReadIssue = stripQuotes(prev['last_read_issue']);
	const comicvineId = cv.id != null ? String(cv.id) : stripQuotes(prev['comicvine_id']);

	return {
		title,
		readStatus,
		rating,
		ratingStars,
		lastReadIssue,
		latestIssue: parseNumOrNull(prev['latest_issue']),
		issues: typeof cv.count_of_issues === 'number' ? cv.count_of_issues : null,
		status: deriveStatus(prev),
		publisher: cv.publisher?.name ?? '',
		people: Array.isArray(cv.people) ? cv.people.map((p: any) => p.name).filter(Boolean) : [],
		startYear: cv.start_year != null ? String(cv.start_year) : '',
		comicvineId,
		poster: cv.image?.original_url ?? null,
		url: cv.site_detail_url ?? '',
		description: htmlToPlainText(cv.description ?? ''),
	};
}

export function renderComic(r: ComicRecord, myNotes: string, customSections: CustomSection[] = []): string {
	const fm = [
		'---',
		'type: comic_item',
		`title: ${yamlScalar(r.title)}`,
		`read_status: ${r.readStatus}`,
		`rating: ${r.rating}`,
		`rating_stars: ${r.ratingStars}`,
		`last_read_issue: ${r.lastReadIssue}`,
		`latest_issue: ${r.latestIssue ?? 'null'}`,
		`issues: ${r.issues ?? 'null'}`,
		`status: ${r.status}`,
		`publisher: ${yamlScalar(r.publisher)}`,
		`people: ${yamlList(r.people)}`,
		`start_year: ${r.startYear}`,
		`comicvine_id: ${r.comicvineId}`,
		`poster: ${quotedOrNull(r.poster)}`,
		`url: ${quotedOrNull(r.url)}`,
		'tags: [comics, comic]',
		'---',
	];

	const b: string[] = ['', `# ${r.title}`, ''];
	if (r.poster) b.push(`![poster|200](${r.poster})`, '');
	const meta = ['**Comic**', ...[r.status, r.startYear].filter(x => x)];
	b.push(meta.join(' · '), '');
	b.push(`**Read Status:** ${r.readStatus}`);
	if (r.rating !== '0' && r.rating !== '' && r.ratingStars) b.push(`**Rating:** ${r.ratingStars} (${r.rating}/5)`);
	if (r.lastReadIssue) {
		const denom = r.latestIssue ?? r.issues ?? '?';
		b.push(`**Progress:** issue ${r.lastReadIssue} / ${denom}`);
	}
	b.push('');
	if (r.description) b.push('## Synopsis', r.description, '');
	const facts: string[] = [];
	if (r.publisher) facts.push(`**Publisher:** ${r.publisher}`);
	if (r.people.length) facts.push(`**Creators:** ${r.people.join(', ')}`);
	if (facts.length) b.push(...facts, '');
	const links: string[] = [];
	if (r.url) links.push(`- [Comic Vine](${r.url})`);
	if (links.length) b.push('## Links', ...links, '');
	for (const s of customSections) b.push(`## ${s.heading}`, s.content, '');
	b.push('## My Notes', '', myNotes);
	if (myNotes) b.push('');
	return fm.join('\n') + '\n' + b.join('\n');
}

/**
 * Comic Vine returns HTTP 200 even on auth/request failures -- the real signal is the
 * envelope's `status_code` (1 = OK; anything else carries a human-readable `error`, e.g.
 * "Invalid API Key"). Left un-checked, callers see empty `results` and treat it as
 * "nothing found" instead of a real failure. `status_code` absent entirely (as in older
 * hand-built test fixtures) is treated as OK -- only an explicit non-1 code trips this.
 */
function checkEnvelope(data: any, deps: SpecDeps): boolean {
	if (data && data.status_code !== undefined && data.status_code !== 1) {
		const msg = data.error || 'Unknown error';
		deps.log(`Comic Vine error: ${msg}`);
		deps.notify(`Comic Vine: ${msg}`);
		return false;
	}
	return true;
}

async function fetchVolumeResults(query: string, key: string, deps: SpecDeps): Promise<any[] | null> {
	const qs = new URLSearchParams({ api_key: key, format: 'json', filter: `name:${query}`, limit: '10' });
	const res = await deps.http(`${COMICVINE_BASE}/volumes/?${qs.toString()}`, {});
	if (!checkEnvelope(res, deps)) return null;
	return Array.isArray(res?.results) ? res.results : [];
}

/** Top-candidate identifying info for ambiguous-resolve logging. */
function candidateSummary(r: any): string {
	const year = r.start_year != null ? String(r.start_year) : '';
	const publisher = r.publisher?.name ?? '';
	return `id=${r.id ?? ''} «${r.name ?? ''}»${year ? ` (${year})` : ''}${publisher ? ` ${publisher}` : ''}`;
}

export const comicSpec: MediaTypeSpec = {
	typeName: 'comic',
	itemType: 'comic_item',
	folderSettingKey: 'libraryComicFolder',
	enabledSettingKey: 'libraryComicEnabled',
	throttleMs: 350,

	hasId(fm: Record<string, string>): boolean {
		return !!stripQuotes(fm['comicvine_id']);
	},

	isActive(fm: Record<string, string>): boolean {
		if (!stripQuotes(fm['comicvine_id'])) return true; // never enriched -> needs first pass
		// post-resolve skeleton -- canonical render always writes status, so its absence
		// means sync() hasn't produced canonical output yet
		if (!stripQuotes(fm['status'])) return true;
		if (stripQuotes(fm['status']) === 'Ongoing') return true;
		if (stripQuotes(fm['read_status']) === 'Reading') return true;
		return false;
	},

	async resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<Record<string, string> | null> {
		const key = deps.getKey('comicvine');
		if (!key) {
			deps.log('comic resolve: no Comic Vine key configured, skipping id lookup');
			return null;
		}
		const query = stripQuotes(ctx.frontmatter['title']) || ctx.filename.replace(/\.md$/, '');
		if (!query) return null;
		try {
			const results = await fetchVolumeResults(query, key, deps);
			if (results === null) return null; // envelope error already logged/notified
			if (results.length === 0) return null;
			const q = query.toLowerCase();
			const exacts = results.filter(r => String(r.name ?? '').toLowerCase() === q);
			const pick = exacts.length === 1 ? exacts[0] : exacts.length === 0 && results.length === 1 ? results[0] : null;
			if (!pick) {
				deps.log(`ambiguous "${query}": candidates: ${results.slice(0, 3).map(candidateSummary).join('; ')}`);
				return null;
			}
			return pick.id != null ? { comicvine_id: String(pick.id) } : null;
		} catch (e) {
			deps.log(`comic resolve failed for "${query}": ${String(e)}`);
			return null;
		}
	},

	async sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null> {
		const fm = ctx.frontmatter;
		const id = stripQuotes(fm['comicvine_id']);
		if (!id) return null; // needs resolve() first

		const key = deps.getKey('comicvine');
		if (!key) {
			deps.log(`comic sync: no Comic Vine key configured, skipping comicvine_id ${id}`);
			return null;
		}

		let json: any;
		try {
			const qs = new URLSearchParams({ api_key: key, format: 'json' });
			json = await deps.http(`${COMICVINE_BASE}/volume/4050-${id}/?${qs.toString()}`, {});
		} catch (e) {
			deps.log(`comic comicvine fetch failed (comicvine_id ${id}): ${String(e)}`);
			return null;
		}

		if (!checkEnvelope(json, deps)) return null;

		const result = json?.results;
		if (!result || !result.name || (result.id != null && String(result.id) !== id)) {
			// identity-guard: never silently swap to a different volume's data; leave the note
			// untouched (id fields preserved) when the response is missing or mismatched.
			deps.log(`comic comicvine volume fetch returned no usable data for comicvine_id ${id}`);
			return null;
		}

		const record = buildComic(result, fm);
		const prevLatestIssue = parseNumOrNull(fm['latest_issue']);
		const rawIssueNumber = result.last_issue?.issue_number;
		const candidate = rawIssueNumber != null ? parseFloat(String(rawIssueNumber)) : NaN;

		let flipped = false;
		if (Number.isFinite(candidate)) {
			if (prevLatestIssue === null) {
				// seed pass: first-ever observed issue number, nothing to compare against yet --
				// record it as the baseline, never flip/notify (mirrors watchlist build.ts's
				// `prevLast &&` guard: there's no "new" issue relative to an unknown starting point)
				record.latestIssue = candidate;
			} else if (candidate > prevLatestIssue) {
				record.latestIssue = candidate;
				if (record.readStatus === 'Read') {
					record.readStatus = 'Unread';
					flipped = true;
					deps.notify(`«${record.title}» issue ${candidate} out`);
				}
			}
		}
		// non-numeric or missing last_issue.issue_number -> skip flip, keep prev latest_issue
		// (already set by buildComic above, untouched here)

		const content = renderComic(record, extractMyNotes(ctx.body), extractCustomSections(ctx.body));
		return { content, flipped };
	},
};
