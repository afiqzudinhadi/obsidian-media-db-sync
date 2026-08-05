import type { LibraryNoteCtx, MediaTypeSpec, ResolveOutcome, SpecDeps } from 'packages/obsidian/src/library/types';
import { stripQuotes, extractMyNotes, extractCustomSections, type CustomSection } from 'packages/obsidian/src/watchlist/parse';
import { yamlList, yamlScalar, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';
import { deriveReadStatus, deriveRating } from 'packages/obsidian/src/library/convert';

const OPENLIBRARY_BASE = 'https://openlibrary.org';

export interface BookRecord {
	title: string;
	readStatus: string;
	rating: string;
	ratingStars: string;
	authors: string[];
	year: number | null;
	pages: number | null;
	genre: string[];
	olid: string;
	isbn: string;
	poster: string | null;
	url: string;
}

function deriveAuthors(doc: any, prev: Record<string, string>): string[] {
	const fresh: string[] = Array.isArray(doc.author_name) ? doc.author_name.filter(Boolean) : [];
	if (fresh.length) return fresh;
	// skeleton conversion: legacy singular `author` field, used only when Open Library gives none
	const legacy = stripQuotes(prev['author']);
	return legacy ? [legacy] : [];
}

/**
 * Pure mapper: Open Library `search.json` doc + prev frontmatter -> canonical BookRecord.
 * User-managed fields (read_status, rating, rating_stars, isbn) are preserved from prev
 * (with legacy-skeleton fallback for read_status/rating/authors); everything else is
 * freshly derived from the doc on every call.
 */
export function buildBook(doc: any, prev: Record<string, string>): BookRecord {
	const title: string = doc.title ?? stripQuotes(prev['title']) ?? '';
	const { rating, ratingStars } = deriveRating(prev);
	const readStatus = deriveReadStatus(prev);
	const authors = deriveAuthors(doc, prev);
	const genre: string[] = Array.isArray(doc.subject) ? doc.subject.filter(Boolean).slice(0, 8) : [];
	const olid = String(doc.key ?? '').replace(/^\/works\//, '') || stripQuotes(prev['olid']);

	return {
		title,
		readStatus,
		rating,
		ratingStars,
		authors,
		year: typeof doc.first_publish_year === 'number' ? doc.first_publish_year : null,
		pages: typeof doc.number_of_pages_median === 'number' ? doc.number_of_pages_median : null,
		genre,
		olid,
		isbn: stripQuotes(prev['isbn']),
		poster: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
		url: doc.key ? `${OPENLIBRARY_BASE}${doc.key}` : olid ? `${OPENLIBRARY_BASE}/works/${olid}` : '',
	};
}

/** Carries the legacy goodreads search link forward as a `## Links` entry across every re-render. */
function resolveGoodreadsLink(prev: Record<string, string>, body: string): string {
	const linksMatch = /##\s*Links\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(body ?? '');
	const fromBody = linksMatch ? /\[Goodreads\]\(([^)]+)\)/.exec(linksMatch[1]) : null;
	if (fromBody) return fromBody[1];
	// first-pass skeleton conversion: legacy plain `url` field IS the goodreads link, before
	// it gets overwritten by the canonical Open Library url
	const legacyUrl = stripQuotes(prev['url']);
	if (legacyUrl && !legacyUrl.includes('openlibrary.org')) return legacyUrl;
	return '';
}

export function renderBook(r: BookRecord, myNotes: string, customSections: CustomSection[] = [], goodreadsUrl = ''): string {
	const fm = [
		'---',
		'type: book_item',
		`title: ${yamlScalar(r.title)}`,
		`read_status: ${r.readStatus}`,
		`rating: ${r.rating}`,
		`rating_stars: ${r.ratingStars}`,
		`authors: ${yamlList(r.authors)}`,
		`year: ${r.year ?? 'null'}`,
		`pages: ${r.pages ?? 'null'}`,
		`genre: ${yamlList(r.genre)}`,
		`olid: ${r.olid}`,
		`isbn: ${r.isbn}`,
		`poster: ${quotedOrNull(r.poster)}`,
		`url: ${quotedOrNull(r.url)}`,
		'tags: [books, book]',
		'---',
	];

	const b: string[] = ['', `# ${r.title}`, ''];
	if (r.poster) b.push(`![poster|200](${r.poster})`, '');
	const meta = ['**Book**', ...[r.year !== null ? String(r.year) : '', r.pages !== null ? `${r.pages} p.` : ''].filter(x => x)];
	b.push(meta.join(' · '), '');
	b.push(`**Read Status:** ${r.readStatus}`);
	if (r.rating !== '0' && r.rating !== '' && r.ratingStars) b.push(`**Rating:** ${r.ratingStars} (${r.rating}/5)`);
	b.push('');
	if (r.authors.length) b.push(`**Authors:** ${r.authors.join(', ')}`, '');
	const links: string[] = [];
	if (r.url) links.push(`- [Open Library](${r.url})`);
	if (goodreadsUrl) links.push(`- [Goodreads](${goodreadsUrl})`);
	if (links.length) b.push('## Links', ...links, '');
	for (const s of customSections) b.push(`## ${s.heading}`, s.content, '');
	b.push('## My Notes', '', myNotes);
	if (myNotes) b.push('');
	return fm.join('\n') + '\n' + b.join('\n');
}

async function fetchDocs(query: string, deps: SpecDeps): Promise<any[]> {
	const qs = new URLSearchParams({ q: query, limit: '10' });
	const res = await deps.http(`${OPENLIBRARY_BASE}/search.json?${qs.toString()}`, {});
	return res?.docs ?? [];
}

/** Skeleton/legacy `author` (singular, stock) or canonical `authors` (bracketed list) frontmatter
 * field -> first author name, used as a query hint to disambiguate common book titles against
 * Open Library's `search.json`. Match rule is unaffected -- still checked against the OL doc's
 * `title` field only. */
function authorHint(fm: Record<string, string>): string {
	const stock = stripQuotes(fm['author']);
	const canonical = (fm['authors'] ?? '').trim().replace(/^\[|\]$/g, '');
	const raw = stock || canonical;
	if (!raw) return '';
	return stripQuotes(raw.split(',')[0].trim());
}

/** Top-candidate identifying info for ambiguous-resolve logging. */
function candidateSummary(d: any): string {
	const olid = String(d.key ?? '').replace(/^\/works\//, '');
	const year = d.first_publish_year != null ? String(d.first_publish_year) : '';
	const author = Array.isArray(d.author_name) ? d.author_name.filter(Boolean).join(', ') : '';
	return `olid=${olid} «${d.title ?? ''}»${year ? ` (${year})` : ''}${author ? ` ${author}` : ''}`;
}

/** Human-readable picker label -- same title/year/author info as candidateSummary, minus the olid prefix. */
function candidateLabel(d: any): string {
	const year = d.first_publish_year != null ? String(d.first_publish_year) : '';
	const author = Array.isArray(d.author_name) ? d.author_name.filter(Boolean).join(', ') : '';
	const meta = [author, year].filter(Boolean).join(', ');
	return meta ? `${d.title ?? ''} (${meta})` : (d.title ?? '');
}

/** Picker second line: first author · first-publish year · page count · olid -- whichever pieces the doc actually has. */
function candidateDetail(d: any): string | undefined {
	const author = Array.isArray(d.author_name) && d.author_name.length ? String(d.author_name[0]) : '';
	const year = d.first_publish_year != null ? String(d.first_publish_year) : '';
	const pages = typeof d.number_of_pages_median === 'number' ? `${d.number_of_pages_median}p` : '';
	const olid = String(d.key ?? '').replace(/^\/works\//, '');
	const parts = [author, year, pages, olid].filter(Boolean);
	return parts.length ? parts.join(' · ') : undefined;
}

export const bookSpec: MediaTypeSpec = {
	typeName: 'book',
	itemType: 'book_item',
	folderSettingKey: 'libraryBookFolder',
	enabledSettingKey: 'libraryBookEnabled',
	throttleMs: 250,

	hasId(fm: Record<string, string>): boolean {
		return !!stripQuotes(fm['olid']);
	},

	isActive(fm: Record<string, string>): boolean {
		// active until the first real enrich has actually run: missing olid (never
		// resolved) OR missing read_status (post-resolve skeleton -- canonical render
		// always writes read_status, so its absence means sync() hasn't produced
		// canonical output yet). Static once both are present; no chapter/issue sources,
		// no flips -- a full sync bypasses this check regardless.
		return !stripQuotes(fm['olid']) || !stripQuotes(fm['read_status']);
	},

	async resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<ResolveOutcome | null> {
		const title = stripQuotes(ctx.frontmatter['title']) || ctx.filename.replace(/\.md$/, '');
		if (!title) return null;
		const hint = authorHint(ctx.frontmatter);
		const searchQuery = hint ? `${title} ${hint}` : title;
		try {
			const docs = await fetchDocs(searchQuery, deps);
			if (docs.length === 0) return null;
			const q = title.toLowerCase();
			const exacts = docs.filter(d => String(d.title ?? '').toLowerCase() === q);
			const pick = exacts.length === 1 ? exacts[0] : exacts.length === 0 && docs.length === 1 ? docs[0] : null;
			if (!pick) {
				deps.log(`ambiguous "${searchQuery}": candidates: ${docs.slice(0, 3).map(candidateSummary).join('; ')}`);
				const candidates = docs
					.slice(0, 6)
					.map(d => ({ label: candidateLabel(d), detail: candidateDetail(d), patches: { olid: String(d.key ?? '').replace(/^\/works\//, '') } }))
					.filter(c => c.patches.olid);
				return candidates.length ? { candidates } : null;
			}
			const olid = String(pick.key ?? '').replace(/^\/works\//, '');
			return olid ? { patches: { olid } } : null;
		} catch (e) {
			deps.log(`book resolve failed for "${searchQuery}": ${String(e)}`);
			return null;
		}
	},

	async sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null> {
		const fm = ctx.frontmatter;
		const olid = stripQuotes(fm['olid']);
		if (!olid) return null; // needs resolve() first

		const query = stripQuotes(fm['title']) || ctx.filename.replace(/\.md$/, '');
		let docs: any[];
		try {
			docs = await fetchDocs(query, deps);
		} catch (e) {
			deps.log(`book open library fetch failed (olid ${olid}): ${String(e)}`);
			return null;
		}
		if (docs.length === 0) return null;
		const doc = docs.find(d => String(d.key ?? '') === `/works/${olid}`);
		if (!doc) {
			// stored olid no longer in the search results -- never silently swap to a
			// different work's data; leave the note untouched (id fields preserved)
			deps.log(`book open library search returned no doc matching olid ${olid} (title "${query}")`);
			return null;
		}

		const record = buildBook(doc, fm);
		const goodreadsUrl = resolveGoodreadsLink(fm, ctx.body);
		const content = renderBook(record, extractMyNotes(ctx.body), extractCustomSections(ctx.body), goodreadsUrl);
		return { content, flipped: false }; // static spec -- no automation, never flips
	},
};
