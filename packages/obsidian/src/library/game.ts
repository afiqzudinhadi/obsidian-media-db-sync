import type { LibraryNoteCtx, MediaTypeSpec, SpecDeps } from 'packages/obsidian/src/library/types';
import { stripQuotes, extractMyNotes, extractCustomSections, type CustomSection } from 'packages/obsidian/src/watchlist/parse';
import { yamlList, yamlScalar, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';
import { deriveRating } from 'packages/obsidian/src/library/convert';

const STEAM_STORE_BASE = 'https://store.steampowered.com';
const RAWG_BASE = 'https://api.rawg.io/api';

const STEAM_MONTHS: Record<string, string> = {
	jan: '01',
	feb: '02',
	mar: '03',
	apr: '04',
	may: '05',
	jun: '06',
	jul: '07',
	aug: '08',
	sep: '09',
	oct: '10',
	nov: '11',
	dec: '12',
};

/** Steam release_date.date ("2 Mar, 2018") -> ISO "YYYY-MM-DD" via month-name lookup, no Date()/locale. */
export function parseSteamDate(raw: string): string {
	const m = /^(\d{1,2})\s+([A-Za-z]{3,})\s*,\s*(\d{4})$/.exec((raw ?? '').trim());
	if (!m) return '';
	const month = STEAM_MONTHS[m[2].slice(0, 3).toLowerCase()];
	if (!month) return '';
	return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

export interface GameRecord {
	title: string;
	playStatus: string;
	rating: string;
	ratingStars: string;
	developer: string[];
	publisher: string[];
	platforms: string[];
	genre: string[];
	releaseDate: string; // ISO or ''
	metacritic: number | null;
	steamAppid: string;
	rawgId: string;
	poster: string | null;
	url: string;
	description: string;
}

function derivePlayStatus(prev: Record<string, string>): string {
	const canonical = stripQuotes(prev['play_status']);
	if (canonical) return canonical;
	// skeleton conversion: legacy boolean `played` field
	return stripQuotes(prev['played']) === 'true' ? 'Played' : 'Unplayed';
}

/**
 * Pure mapper: enrich-source payload (Steam appdetails `data` object, or RAWG game-detail
 * object) + prev frontmatter -> canonical GameRecord. User-managed fields (play_status,
 * rating, rating_stars) are preserved from prev (with legacy-skeleton fallback); id fields
 * are preserved once set on either side, never dropped by the other source's enrich pass.
 * Steam never reports a usable platform list here, so Steam-sourced records default to ['PC'].
 */
export function buildGame(source: 'steam' | 'rawg', data: any, prev: Record<string, string>): GameRecord {
	const { rating, ratingStars } = deriveRating(prev);
	const playStatus = derivePlayStatus(prev);
	const prevSteamAppid = stripQuotes(prev['steam_appid']);
	const prevRawgId = stripQuotes(prev['rawg_id']);

	if (source === 'steam') {
		const steamAppid = data.steam_appid != null ? String(data.steam_appid) : prevSteamAppid;
		return {
			title: data.name ?? '',
			playStatus,
			rating,
			ratingStars,
			developer: Array.isArray(data.developers) ? data.developers.filter(Boolean) : [],
			publisher: Array.isArray(data.publishers) ? data.publishers.filter(Boolean) : [],
			platforms: ['PC'],
			genre: Array.isArray(data.genres) ? data.genres.map((g: any) => g.description).filter(Boolean) : [],
			releaseDate: parseSteamDate(data.release_date?.date ?? ''),
			metacritic: typeof data.metacritic?.score === 'number' ? data.metacritic.score : null,
			steamAppid,
			rawgId: prevRawgId, // enrich-by-steam never touches an existing rawg_id
			poster: data.header_image ?? null,
			url: `${STEAM_STORE_BASE}/app/${steamAppid}`,
			description: data.short_description ?? '',
		};
	}

	// rawg
	const rawgId = data.id != null ? String(data.id) : prevRawgId;
	const prevUrl = stripQuotes(prev['url']);
	return {
		title: data.name ?? '',
		playStatus,
		rating,
		ratingStars,
		developer: Array.isArray(data.developers) ? data.developers.map((d: any) => d.name).filter(Boolean) : [],
		publisher: Array.isArray(data.publishers) ? data.publishers.map((p: any) => p.name).filter(Boolean) : [],
		platforms: Array.isArray(data.platforms) ? data.platforms.map((p: any) => p.platform?.name).filter(Boolean) : [],
		genre: Array.isArray(data.genres) ? data.genres.map((g: any) => g.name).filter(Boolean) : [],
		releaseDate: typeof data.released === 'string' ? data.released.slice(0, 10) : '',
		metacritic: typeof data.metacritic === 'number' ? data.metacritic : null,
		steamAppid: prevSteamAppid, // enrich-by-rawg never touches an existing steam_appid
		rawgId,
		poster: data.background_image ?? null,
		// RAWG's documented detail payload carries no site url/slug we can trust; keep whatever
		// the note already had (usually the Steam store page from the vault skeleton), else fall
		// back to an id-based RAWG link rather than inventing anything.
		url: prevUrl || (rawgId ? `https://rawg.io/games/${rawgId}` : ''),
		description: data.description_raw ?? '',
	};
}

export function renderGame(r: GameRecord, myNotes: string, customSections: CustomSection[] = []): string {
	const fm = [
		'---',
		'type: game_item',
		`title: ${yamlScalar(r.title)}`,
		`play_status: ${r.playStatus}`,
		`rating: ${r.rating}`,
		`rating_stars: ${r.ratingStars}`,
		`developer: ${yamlList(r.developer)}`,
		`publisher: ${yamlList(r.publisher)}`,
		`platforms: ${yamlList(r.platforms)}`,
		`genre: ${yamlList(r.genre)}`,
		`release_date: ${r.releaseDate ? r.releaseDate : 'null'}`,
		`metacritic: ${r.metacritic ?? 'null'}`,
		`steam_appid: ${r.steamAppid}`,
		`rawg_id: ${r.rawgId}`,
		`poster: ${quotedOrNull(r.poster)}`,
		`url: ${quotedOrNull(r.url)}`,
		'tags: [games, game]',
		'---',
	];

	const b: string[] = ['', `# ${r.title}`, ''];
	if (r.poster) b.push(`![poster|200](${r.poster})`, '');
	const meta = ['**Game**', ...[r.releaseDate, r.metacritic !== null ? `Metacritic ${r.metacritic}` : ''].filter(x => x)];
	b.push(meta.join(' · '), '');
	b.push(`**Play Status:** ${r.playStatus}`);
	if (r.rating !== '0' && r.rating !== '' && r.ratingStars) b.push(`**Rating:** ${r.ratingStars} (${r.rating}/5)`);
	b.push('');
	if (r.description) b.push('## Synopsis', r.description, '');
	const facts: string[] = [];
	if (r.developer.length) facts.push(`**Developer:** ${r.developer.join(', ')}`);
	if (r.publisher.length) facts.push(`**Publisher:** ${r.publisher.join(', ')}`);
	if (r.platforms.length) facts.push(`**Platforms:** ${r.platforms.join(', ')}`);
	if (facts.length) b.push(...facts, '');
	const links: string[] = [];
	if (r.steamAppid) links.push(`- [Steam](${STEAM_STORE_BASE}/app/${r.steamAppid}/)`);
	if (r.rawgId && r.url) links.push(`- [RAWG](${r.url})`);
	if (links.length) b.push('## Links', ...links, '');
	for (const s of customSections) b.push(`## ${s.heading}`, s.content, '');
	b.push('## My Notes', '', myNotes);
	if (myNotes) b.push('');
	return fm.join('\n') + '\n' + b.join('\n');
}

function pickUniqueExact<T>(items: T[], query: string, titleOf: (t: T) => string): T | null {
	if (!items || items.length === 0) return null;
	const q = query.toLowerCase();
	const exacts = items.filter(it => titleOf(it).toLowerCase() === q);
	if (exacts.length === 1) return exacts[0];
	if (exacts.length === 0 && items.length === 1) return items[0];
	return null;
}

/** Top-candidate identifying info for ambiguous-resolve logging. */
function candidateSummary(label: string, id: unknown, name: string, year?: string): string {
	return `${label}=${id ?? ''} «${name}»${year ? ` (${year})` : ''}`;
}

async function fetchSteamSearch(query: string, deps: SpecDeps): Promise<any[]> {
	const qs = new URLSearchParams({ term: query, cc: 'us', l: 'en' });
	const res = await deps.http(`${STEAM_STORE_BASE}/api/storesearch/?${qs.toString()}`, {});
	return Array.isArray(res?.items) ? res.items : [];
}

async function fetchRawgSearch(query: string, key: string, deps: SpecDeps): Promise<any[]> {
	const qs = new URLSearchParams({ key, search: query, page_size: '10' });
	const res = await deps.http(`${RAWG_BASE}/games?${qs.toString()}`, {});
	return Array.isArray(res?.results) ? res.results : [];
}

export const gameSpec: MediaTypeSpec = {
	typeName: 'game',
	itemType: 'game_item',
	folderSettingKey: 'libraryGameFolder',
	enabledSettingKey: 'libraryGameEnabled',
	throttleMs: 250,

	hasId(fm: Record<string, string>): boolean {
		return !!stripQuotes(fm['steam_appid']) || !!stripQuotes(fm['rawg_id']);
	},

	isActive(fm: Record<string, string>): boolean {
		// active until the first real enrich has actually run: both ids empty (never
		// resolved) OR missing play_status (post-resolve skeleton -- canonical render
		// always writes play_status, so its absence means sync() hasn't produced canonical
		// output yet). Static once an id + play_status are present; no chapter/issue-style
		// automation exists for games -- a full sync bypasses this check regardless.
		return (!stripQuotes(fm['steam_appid']) && !stripQuotes(fm['rawg_id'])) || !stripQuotes(fm['play_status']);
	},

	async resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<Record<string, string> | null> {
		// fastest, no-network path: 28/31 real game notes already carry a Steam store url
		const url = stripQuotes(ctx.frontmatter['url']);
		const urlMatch = /store\.steampowered\.com\/app\/(\d+)/.exec(url);
		if (urlMatch) return { steam_appid: urlMatch[1] };

		const query = stripQuotes(ctx.frontmatter['title']) || ctx.filename.replace(/\.md$/, '');
		if (!query) return null;

		try {
			const items = await fetchSteamSearch(query, deps);
			const pick = pickUniqueExact(items, query, (it: any) => String(it.name ?? ''));
			if (pick) return { steam_appid: String(pick.id) };
			if (items.length > 0) {
				deps.log(`ambiguous "${query}": candidates: ${items.slice(0, 3).map((it: any) => candidateSummary('appid', it.id, it.name ?? '')).join('; ')}`);
			}
		} catch (e) {
			deps.log(`game steam storesearch failed for "${query}": ${String(e)}`);
		}

		const key = deps.getKey('rawg');
		if (!key) {
			deps.log(`game resolve: no RAWG key configured, skipping RAWG fallback for "${query}"`);
			return null;
		}
		try {
			const results = await fetchRawgSearch(query, key, deps);
			const pick = pickUniqueExact(results, query, (it: any) => String(it.name ?? ''));
			if (pick) return { rawg_id: String(pick.id) };
			if (results.length > 0) {
				const year = (it: any) => (typeof it.released === 'string' ? it.released.slice(0, 4) : '');
				deps.log(`ambiguous "${query}": candidates: ${results.slice(0, 3).map((it: any) => candidateSummary('rawg_id', it.id, it.name ?? '', year(it))).join('; ')}`);
			}
		} catch (e) {
			deps.log(`game rawg search failed for "${query}": ${String(e)}`);
		}
		return null;
	},

	async sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null> {
		const fm = ctx.frontmatter;
		const steamAppid = stripQuotes(fm['steam_appid']);
		const rawgId = stripQuotes(fm['rawg_id']);
		if (!steamAppid && !rawgId) return null; // needs resolve() first

		if (steamAppid) {
			let json: any;
			try {
				json = await deps.http(`${STEAM_STORE_BASE}/api/appdetails?appids=${steamAppid}&cc=us&l=en`, {});
			} catch (e) {
				deps.log(`game steam appdetails fetch failed (appid ${steamAppid}): ${String(e)}`);
				return null;
			}
			const entry = json?.[steamAppid];
			if (entry?.success && entry.data) {
				const record = buildGame('steam', entry.data, fm);
				const content = renderGame(record, extractMyNotes(ctx.body), extractCustomSections(ctx.body));
				return { content, flipped: false };
			}
			// Steam de-listed/invalid appid: identity-guard -- never silently swap to a
			// different game; only fall through to RAWG when we have an id + key, else stop.
			deps.log(`game steam appdetails returned success:false for appid ${steamAppid}`);
			if (!rawgId) return null;
		}

		if (rawgId) {
			const key = deps.getKey('rawg');
			if (!key) {
				deps.log(`game rawg enrich skipped (no key configured) for rawg_id ${rawgId}`);
				return null;
			}
			let data: any;
			try {
				data = await deps.http(`${RAWG_BASE}/games/${rawgId}?key=${key}`, {});
			} catch (e) {
				deps.log(`game rawg detail fetch failed (rawg_id ${rawgId}): ${String(e)}`);
				return null;
			}
			if (!data || !data.name || (data.id != null && String(data.id) !== rawgId)) {
				deps.log(`game rawg detail returned no usable data for rawg_id ${rawgId}`);
				return null;
			}
			const record = buildGame('rawg', data, fm);
			const content = renderGame(record, extractMyNotes(ctx.body), extractCustomSections(ctx.body));
			return { content, flipped: false };
		}

		return null; // steam_appid set, success:false, no rawg fallback available
	},
};
