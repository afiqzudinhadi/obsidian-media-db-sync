import { stripQuotes } from 'packages/obsidian/src/watchlist/parse';

/** Shared across manga/comic: parse a stored numeric frontmatter field, tolerating 'null'/empty -> null. */
export function parseNumOrNull(raw: string | undefined): number | null {
	const s = stripQuotes(raw);
	if (!s || s === 'null') return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

/** Shared across manga/book/comic: canonical read_status, with legacy boolean `read` skeleton fallback. */
export function deriveReadStatus(prev: Record<string, string>): string {
	const canonical = stripQuotes(prev['read_status']);
	if (canonical) return canonical;
	// skeleton conversion: legacy boolean `read` field
	return stripQuotes(prev['read']) === 'true' ? 'Read' : 'Unread';
}

/** Shared across manga/book/game/comic: canonical rating + stars, with legacy numeric `personalRating` skeleton fallback. */
export function deriveRating(prev: Record<string, string>): { rating: string; ratingStars: string } {
	const canonicalRating = stripQuotes(prev['rating']);
	if (canonicalRating) return { rating: canonicalRating, ratingStars: stripQuotes(prev['rating_stars']) };
	// skeleton conversion: legacy numeric `personalRating` field -> N stars
	const legacy = Number(stripQuotes(prev['personalRating']));
	if (Number.isFinite(legacy) && legacy > 0) {
		return { rating: String(legacy), ratingStars: '⭐️'.repeat(legacy) };
	}
	return { rating: '0', ratingStars: '' };
}
