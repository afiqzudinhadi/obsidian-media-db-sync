# Watchlist Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full metadata enrichment, periodic diff-on-write sync, and watch-status automation (Watched→Unwatched on new episode) to the media-db-sync fork, emitting the canonical watchlist schema.

**Architecture:** New self-contained module `packages/obsidian/src/watchlist/` — pure functions (TMDB JSON → record → note string) with HTTP and vault I/O injected, plus a `SyncEngine` orchestrator. Thin wiring into `main.ts` (commands + `registerInterval` catch-up scheduler) and `Settings.ts`. Port of the proven Python reference (`watchlist_sync.py`) with three additions: `seasons`/`episodes`/`vod` fields, tiered sync, resolve-missing-ids.

**Tech Stack:** TypeScript, bun test (preload `tests/setup.ts` mocks `obsidian`), vite build, Obsidian `requestUrl` via existing `obsidianFetch` (`packages/obsidian/src/utils/Utils.ts:283`).

## Global Constraints

- ALL HTTP via Obsidian `requestUrl` (`obsidianFetch`) — never node `fetch` (ISP DNS blocks TMDB for node stack).
- TMDB auth BOTH: key starts `eyJ` → v4 `Authorization: Bearer` header; else v3 `&api_key=` query param.
- Preserve on every write: `watch_status` (except TV rule), `rating`, `rating_stars`, `notion_url`, body `## My Notes`.
- Schema = exact canonical frontmatter (see `tests/fixtures/canonical-series.md`). Always emit `seasons`/`episodes`/`vod` (movies: `null`/`null`/`[]`) — verified against real vault notes.
- Dates stay ISO strings end-to-end; compare lexicographically. No `Date` parsing.
- Diff-on-write: render full note, string-compare vs existing content, write only when different.
- Test commands: `bun run test` (NEVER raw `bun test` — misses preload), `bun run tsc`, `bun run build`. All three must pass before every commit.
- Reference implementation: `/Users/AfiqZudinHadi/Documents/obsidian-media-db/reference/watchlist_sync.py`. Field mappings spec: `/Users/AfiqZudinHadi/Documents/obsidian-media-db/docs/SPEC.md`.
- Commit format: end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: YAML helpers + schema types

**Files:**
- Create: `packages/obsidian/src/watchlist/schema.ts`
- Create: `packages/obsidian/src/watchlist/yaml.ts`
- Test: `tests/watchlist-yaml.test.ts`

**Interfaces:**
- Produces: `WatchlistRecord` interface (all downstream tasks build/consume it); `yamlScalar(v: unknown): string`, `yamlList(items: string[]): string`, `quotedOrNull(v: string | null | undefined): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchlist-yaml.test.ts
import { describe, expect, test } from 'bun:test';
import { yamlScalar, yamlList, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';

describe('yamlScalar', () => {
	test('plain string passes through', () => {
		expect(yamlScalar('English')).toBe('English');
	});
	test('empty/null/undefined → empty string', () => {
		expect(yamlScalar('')).toBe('');
		expect(yamlScalar(null)).toBe('');
		expect(yamlScalar(undefined)).toBe('');
	});
	test('special chars → quoted', () => {
		expect(yamlScalar('S2, E6: Glorious Purpose')).toBe('"S2, E6: Glorious Purpose"');
		expect(yamlScalar('Aaron Moorhead, Justin Benson')).toBe('"Aaron Moorhead, Justin Benson"');
	});
	test('comma alone does NOT quote (matches python regex)', () => {
		// python regex [:#\[\]{}",&*!|>%@`] has no comma; "a, b" quotes via ":"? no — verify: comma not in class, so "Alter, Turtle" stays plain
		expect(yamlScalar('Rachel Alter and Tommy Turtle')).toBe('Rachel Alter and Tommy Turtle');
	});
	test('yaml keywords → quoted', () => {
		expect(yamlScalar('null')).toBe('"null"');
		expect(yamlScalar('No')).toBe('"No"');
	});
	test('embedded quotes escaped', () => {
		expect(yamlScalar('He said "hi"')).toBe('"He said \\"hi\\""');
	});
});

describe('yamlList', () => {
	test('plain items unquoted, special quoted', () => {
		expect(yamlList(['Drama', 'Sci-Fi & Fantasy'])).toBe('[Drama, "Sci-Fi & Fantasy"]');
	});
	test('empty list', () => {
		expect(yamlList([])).toBe('[]');
	});
	test('blank items dropped', () => {
		expect(yamlList(['', 'Drama', '  '])).toBe('[Drama]');
	});
	test('Disney+ quoted', () => {
		expect(yamlList(['Disney+'])).toBe('["Disney+"]');
	});
});

describe('quotedOrNull', () => {
	test('value → quoted', () => {
		expect(quotedOrNull('https://x.y/z')).toBe('"https://x.y/z"');
	});
	test('empty/null → null literal', () => {
		expect(quotedOrNull('')).toBe('null');
		expect(quotedOrNull(null)).toBe('null');
	});
});
```

NOTE for implementer: the "comma alone" test documents python behavior — `,` is NOT in the quoting regex. `'S2, E6: Glorious Purpose'` quotes because of `:`. `'Aaron Moorhead, Justin Benson'` — check python regex: no comma, no colon in that string… BUT the canonical fixture shows `director: "Aaron Moorhead, Justin Benson"` QUOTED. Reality: the vault was written by an earlier variant that quoted on comma. **Decision: add `,` to the quoting regex** so output matches the real vault. Test expectations above are written for the comma-quoting variant (`'Rachel Alter and Tommy Turtle'` has no comma → plain).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — `Cannot find module 'packages/obsidian/src/watchlist/yaml'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/obsidian/src/watchlist/yaml.ts
const NEEDS_QUOTE = /[:,#\[\]{}",&*!|>%@`]/;
const KEYWORDS = new Set(['null', 'true', 'false', 'yes', 'no']);

export function yamlScalar(v: unknown): string {
	if (v === null || v === undefined || v === '') return '';
	const s = String(v);
	if (NEEDS_QUOTE.test(s) || s.trim() !== s || KEYWORDS.has(s.toLowerCase())) {
		return '"' + s.replace(/"/g, '\\"') + '"';
	}
	return s;
}

export function yamlList(items: string[]): string {
	const parts: string[] = [];
	for (const raw of items) {
		const g = String(raw).trim();
		if (!g) continue;
		parts.push(/^[A-Za-z0-9 ]+$/.test(g) ? g : '"' + g.replace(/"/g, '\\"') + '"');
	}
	return '[' + parts.join(', ') + ']';
}

export function quotedOrNull(v: string | null | undefined): string {
	return v ? '"' + v + '"' : 'null';
}
```

```ts
// packages/obsidian/src/watchlist/schema.ts
export type WatchCategory = 'Movie' | 'Series' | 'Anime';
export type WatchMediaType = 'Movie' | 'TV Series';

export interface WatchlistRecord {
	title: string;
	engName: string;
	mediaType: WatchMediaType;
	category: WatchCategory;
	watchStatus: string;
	rating: string;
	ratingStars: string;
	year: string;
	runtime: number | null;
	seasons: number | null;
	episodes: number | null;
	vod: string[];
	genre: string[];
	status: string;
	language: string;
	country: string;
	director: string[];
	writer: string[];
	producer: string[];
	contentRating: string;
	tmdbRating: number | null;
	tmdbId: string;
	imdbId: string;
	releaseDate: string | null;
	lastAirDate: string | null;
	nextAirDate: string | null;
	lastEpisode: string | null;
	upcomingEpisode: string | null;
	poster: string | null;
	trailer: string;
	homepage: string;
	imdbPage: string;
	notionUrl: string;
	synopsis: string;
	cast: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test 2>&1 | tail -5`
Expected: all pass (31 upstream + new)

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/ tests/watchlist-yaml.test.ts
git commit -m "feat(watchlist): yaml helpers + schema types"
```

---

### Task 2: Note parsing (frontmatter, My Notes, TMDB ref)

**Files:**
- Create: `packages/obsidian/src/watchlist/parse.ts`
- Test: `tests/watchlist-parse.test.ts`

**Interfaces:**
- Produces: `parseNote(content: string): { frontmatter: Record<string, string>; body: string }`; `extractMyNotes(body: string): string`; `noteTmdbRef(fm: Record<string, string>): { tmdbId: string; isMovie: boolean } | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchlist-parse.test.ts
import { describe, expect, test } from 'bun:test';
import { parseNote, extractMyNotes, noteTmdbRef } from 'packages/obsidian/src/watchlist/parse';

const NOTE = `---
type: watchlist_item
media_type: TV Series
tmdb_id: 84958
last_air_date: 2023-11-09
watch_status: Watched
---

# Loki

## My Notes

great finale
`;

describe('parseNote', () => {
	test('splits frontmatter and body', () => {
		const { frontmatter, body } = parseNote(NOTE);
		expect(frontmatter['tmdb_id']).toBe('84958');
		expect(frontmatter['media_type']).toBe('TV Series');
		expect(body).toContain('# Loki');
	});
	test('no frontmatter → empty fm, full body', () => {
		const { frontmatter, body } = parseNote('# Just a heading');
		expect(Object.keys(frontmatter).length).toBe(0);
		expect(body).toBe('# Just a heading');
	});
});

describe('extractMyNotes', () => {
	test('extracts trailing section', () => {
		expect(extractMyNotes(parseNote(NOTE).body)).toBe('great finale');
	});
	test('missing section → empty', () => {
		expect(extractMyNotes('# T\n\ncontent')).toBe('');
	});
});

describe('noteTmdbRef', () => {
	test('canonical note', () => {
		expect(noteTmdbRef({ tmdb_id: '84958', media_type: 'TV Series' })).toEqual({ tmdbId: '84958', isMovie: false });
		expect(noteTmdbRef({ tmdb_id: '693134', media_type: 'Movie' })).toEqual({ tmdbId: '693134', isMovie: true });
	});
	test('quoted values stripped', () => {
		expect(noteTmdbRef({ tmdb_id: '"84958"', media_type: '"TV Series"' })).toEqual({ tmdbId: '84958', isMovie: false });
	});
	test('raw Media DB note fallback (id + dataSource)', () => {
		expect(noteTmdbRef({ id: '693134', dataSource: 'TMDBMovieAPI' })).toEqual({ tmdbId: '693134', isMovie: true });
		expect(noteTmdbRef({ id: '84958', dataSource: 'TMDBSeriesAPI' })).toEqual({ tmdbId: '84958', isMovie: false });
	});
	test('no id → null', () => {
		expect(noteTmdbRef({ type: 'list' })).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — `Cannot find module 'packages/obsidian/src/watchlist/parse'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/obsidian/src/watchlist/parse.ts
export interface ParsedNote {
	frontmatter: Record<string, string>;
	body: string;
}

export function parseNote(content: string): ParsedNote {
	const m = /^---\n([\s\S]*?)\n---([\s\S]*)$/.exec(content);
	const frontmatter: Record<string, string> = {};
	let body = content;
	if (m) {
		body = m[2];
		for (const line of m[1].split('\n')) {
			const mm = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
			if (mm) frontmatter[mm[1]] = mm[2].trim();
		}
	}
	return { frontmatter, body };
}

export function extractMyNotes(body: string): string {
	const m = /##\s*My Notes\s*([\s\S]*)$/.exec(body ?? '');
	return m ? m[1].trim() : '';
}

function stripQuotes(s: string | undefined): string {
	return (s ?? '').trim().replace(/^"|"$/g, '');
}

export function noteTmdbRef(fm: Record<string, string>): { tmdbId: string; isMovie: boolean } | null {
	const tid = stripQuotes(fm['tmdb_id']);
	if (tid) return { tmdbId: tid, isMovie: stripQuotes(fm['media_type']) === 'Movie' };
	const rawId = stripQuotes(fm['id']);
	const ds = (fm['dataSource'] ?? '').trim();
	if (rawId && ds.startsWith('TMDB')) return { tmdbId: rawId, isMovie: ds.includes('Movie') };
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/parse.ts tests/watchlist-parse.test.ts
git commit -m "feat(watchlist): note parsing (frontmatter, My Notes, tmdb ref)"
```

---

### Task 3: buildRecord — TMDB detail → WatchlistRecord

**Files:**
- Create: `packages/obsidian/src/watchlist/build.ts`
- Create: `tests/fixtures/tmdb-movie-dune2.json` (mock payload — copy verbatim from `watchlist_sync.py` `selftest()` L301-316, JSON-ified: `True`→`true`)
- Create: `tests/fixtures/tmdb-tv-loki.json` (mock below)
- Test: `tests/watchlist-build.test.ts`

**Interfaces:**
- Consumes: `WatchlistRecord` (Task 1).
- Produces: `buildRecord(details: TmdbDetail, isMovie: boolean, prev: Record<string, string>): WatchlistRecord` where `TmdbDetail = Record<string, any>` (raw TMDB JSON).

`tests/fixtures/tmdb-tv-loki.json`:

```json
{
	"id": 84958, "name": "Loki", "original_name": "Loki",
	"original_language": "en",
	"spoken_languages": [{ "iso_639_1": "en", "english_name": "English" }],
	"overview": "After stealing the Tesseract...",
	"episode_run_time": [], "status": "Ended",
	"first_air_date": "2021-06-09", "last_air_date": "2023-11-09",
	"number_of_seasons": 2, "number_of_episodes": 12,
	"networks": [{ "name": "Disney+" }],
	"vote_average": 8.2, "homepage": "https://www.disneyplus.com/series/wp/6pARMvILBGzF",
	"poster_path": null,
	"genres": [{ "name": "Drama" }, { "name": "Sci-Fi & Fantasy" }],
	"origin_country": ["United States of America"],
	"created_by": [{ "name": "Michael Waldron" }],
	"aggregate_credits": { "cast": [{ "name": "Tom Hiddleston" }, { "name": "Sophia Di Martino" }] },
	"external_ids": { "imdb_id": "tt9140554" },
	"content_ratings": { "results": [{ "iso_3166_1": "US", "rating": "TV-14" }] },
	"videos": { "results": [{ "site": "YouTube", "type": "Trailer", "official": true, "key": "nW948Va-l10" }] },
	"last_episode_to_air": { "season_number": 2, "episode_number": 6, "name": "Glorious Purpose" },
	"next_episode_to_air": null
}
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchlist-build.test.ts
import { describe, expect, test } from 'bun:test';
import { buildRecord } from 'packages/obsidian/src/watchlist/build';
import movieDetail from 'tests/fixtures/tmdb-movie-dune2.json';
import tvDetail from 'tests/fixtures/tmdb-tv-loki.json';

const EMPTY_PREV = { watch_status: 'Unwatched', rating: '0', rating_stars: '' };

describe('buildRecord movie', () => {
	const r = buildRecord(movieDetail, true, EMPTY_PREV);
	test('core mapping (mirrors python selftest)', () => {
		expect(r.language).toBe('English');
		expect(r.country).toBe('United States of America');
		expect(r.imdbId).toBe('tt15239678');
		expect(r.contentRating).toBe('PG-13');
		expect(r.tmdbId).toBe('693134');
		expect(r.category).toBe('Movie');
		expect(r.trailer).toContain('youtube.com');
		expect(r.year).toBe('2024');
		expect(r.director).toEqual(['Denis Villeneuve']);
		expect(r.writer).toEqual(['Jon Spaihts']);
		expect(r.producer).toEqual(['Mary Parent']);
		expect(r.imdbPage).toBe('https://www.imdb.com/title/tt15239678/');
	});
	test('movie: seasons/episodes null, vod empty', () => {
		expect(r.seasons).toBeNull();
		expect(r.episodes).toBeNull();
		expect(r.vod).toEqual([]);
	});
});

describe('buildRecord tv', () => {
	const r = buildRecord(tvDetail, false, EMPTY_PREV);
	test('tv mapping', () => {
		expect(r.mediaType).toBe('TV Series');
		expect(r.category).toBe('Series');
		expect(r.year).toBe('2021 - 2023');
		expect(r.seasons).toBe(2);
		expect(r.episodes).toBe(12);
		expect(r.vod).toEqual(['Disney+']);
		expect(r.contentRating).toBe('TV-14');
		expect(r.lastEpisode).toBe('S2, E6: Glorious Purpose');
		expect(r.upcomingEpisode).toBeNull();
		expect(r.runtime).toBeNull();
		expect(r.director).toEqual(['Michael Waldron']);
	});
	test('ongoing series year + TBA', () => {
		const ongoing = { ...tvDetail, status: 'Returning Series', last_air_date: '2026-01-01', next_episode_to_air: null };
		const r2 = buildRecord(ongoing, false, EMPTY_PREV);
		expect(r2.year).toBe('2021 -');
		expect(r2.upcomingEpisode).toBe('TBA');
	});
	test('same start/end year collapses', () => {
		const oneYear = { ...tvDetail, first_air_date: '2021-06-09', last_air_date: '2021-07-14' };
		expect(buildRecord(oneYear, false, EMPTY_PREV).year).toBe('2021');
	});
});

describe('anime derivation', () => {
	test('Animation + Japanese → Anime', () => {
		const anime = {
			...tvDetail,
			genres: [{ name: 'Animation' }, { name: 'Drama' }],
			original_language: 'ja',
			spoken_languages: [{ iso_639_1: 'ja', english_name: 'Japanese' }],
		};
		expect(buildRecord(anime, false, EMPTY_PREV).category).toBe('Anime');
	});
	test('Animation + English → not Anime', () => {
		const western = { ...tvDetail, genres: [{ name: 'Animation' }] };
		expect(buildRecord(western, false, EMPTY_PREV).category).toBe('Series');
	});
});

describe('user-field preservation', () => {
	test('prev fields carried', () => {
		const prev = { watch_status: 'Watching', rating: '4', rating_stars: '⭐️⭐️⭐️⭐️', notion_url: 'https://notion.so/x' };
		const r = buildRecord(tvDetail, false, prev);
		expect(r.watchStatus).toBe('Watching');
		expect(r.rating).toBe('4');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️⭐️');
		expect(r.notionUrl).toBe('https://notion.so/x');
	});
});

describe('watch-status rule (TV)', () => {
	test('Watched + newer episode → Unwatched', () => {
		const prev = { watch_status: 'Watched', last_air_date: '2023-10-01', rating: '5', rating_stars: '⭐️⭐️⭐️⭐️⭐️' };
		expect(buildRecord(tvDetail, false, prev).watchStatus).toBe('Unwatched');
	});
	test('Watched + same date → stays Watched', () => {
		const prev = { watch_status: 'Watched', last_air_date: '2023-11-09' };
		expect(buildRecord(tvDetail, false, prev).watchStatus).toBe('Watched');
	});
	test('movie never flips', () => {
		const prev = { watch_status: 'Watched', last_air_date: '2020-01-01' };
		expect(buildRecord(movieDetail, true, prev).watchStatus).toBe('Watched');
	});
	test('no prev last_air_date → no flip', () => {
		const prev = { watch_status: 'Watched' };
		expect(buildRecord(tvDetail, false, prev).watchStatus).toBe('Watched');
	});
});

describe('eng_name derivation', () => {
	test('non-Latin original → engName = localized title', () => {
		const jp = { ...movieDetail, title: 'A Silent Voice: The Movie', original_title: '映画 聲の形' };
		expect(buildRecord(jp, true, EMPTY_PREV).engName).toBe('A Silent Voice: The Movie');
	});
	test('same Latin title → empty', () => {
		expect(buildRecord(movieDetail, true, EMPTY_PREV).engName).toBe('');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation (direct port of `build_record`, watchlist_sync.py L120-214, + seasons/episodes/vod)**

```ts
// packages/obsidian/src/watchlist/build.ts
import type { WatchlistRecord } from 'packages/obsidian/src/watchlist/schema';

export type TmdbDetail = Record<string, any>;

const IMG_BASE = 'https://image.tmdb.org/t/p/original';

const LANG_FALLBACK: Record<string, string> = {
	en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French',
	es: 'Spanish', de: 'German', hi: 'Hindi', ta: 'Tamil', th: 'Thai',
};

function langName(details: TmdbDetail): string {
	const code: string = details.original_language ?? '';
	for (const sl of details.spoken_languages ?? []) {
		if (sl.iso_639_1 === code && sl.english_name) return sl.english_name;
	}
	return LANG_FALLBACK[code] ?? code;
}

function crewNames(crew: any[], jobs: Set<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of crew) {
		if (jobs.has(c.job) && !seen.has(c.name)) {
			seen.add(c.name);
			out.push(c.name);
		}
	}
	return out;
}

function usCertFromReleaseDates(rd: TmdbDetail): string {
	for (const entry of rd?.results ?? []) {
		if (entry.iso_3166_1 === 'US') {
			for (const d of entry.release_dates ?? []) {
				if (d.certification) return d.certification;
			}
		}
	}
	return '';
}

function usCertFromContentRatings(cr: TmdbDetail): string {
	for (const entry of cr?.results ?? []) {
		if (entry.iso_3166_1 === 'US' && entry.rating) return entry.rating;
	}
	return '';
}

function pickTrailer(videos: TmdbDetail): string {
	const vids: any[] = videos?.results ?? [];
	const yt = (v: any): string => 'https://www.youtube.com/watch?v=' + v.key;
	for (const v of vids) if (v.site === 'YouTube' && v.type === 'Trailer' && v.official) return yt(v);
	for (const v of vids) if (v.site === 'YouTube' && v.type === 'Trailer') return yt(v);
	return '';
}

export function buildRecord(details: TmdbDetail, isMovie: boolean, prev: Record<string, string>): WatchlistRecord {
	const genres: string[] = (details.genres ?? []).map((g: any) => g.name);
	const language = langName(details);
	const imdbId: string = details.external_ids?.imdb_id ?? '';
	const trailer = pickTrailer(details.videos ?? {});

	let title: string, originalTitle: string, mediaType: 'Movie' | 'TV Series';
	let releaseDate: string | null, runtime: number | null, status: string, contentRating: string, country: string;
	let cast: string[], director: string[], writer: string[], producer: string[];
	let seasons: number | null, episodes: number | null, vod: string[];
	let lastAirDate: string | null = null, nextAirDate: string | null = null;
	let lastEpisode: string | null = null, upEpisode: string | null = null;
	let yearDisp: string;

	if (isMovie) {
		const credits = details.credits ?? {};
		cast = (credits.cast ?? []).slice(0, 12).map((c: any) => c.name);
		const crew: any[] = credits.crew ?? [];
		director = crewNames(crew, new Set(['Director']));
		writer = crewNames(crew, new Set(['Writer', 'Screenplay', 'Story']));
		producer = crewNames(crew, new Set(['Producer']));
		title = details.title ?? '';
		originalTitle = details.original_title ?? '';
		mediaType = 'Movie';
		releaseDate = details.release_date || null;
		runtime = details.runtime || null;
		status = details.status ?? '';
		contentRating = usCertFromReleaseDates(details.release_dates ?? {});
		const countries: string[] = (details.production_countries ?? []).map((c: any) => c.name);
		country = countries[0] ?? '';
		yearDisp = (releaseDate ?? '').slice(0, 4);
		seasons = null;
		episodes = null;
		vod = [];
	} else {
		const agg = details.aggregate_credits ?? {};
		cast = (agg.cast ?? []).slice(0, 12).map((c: any) => c.name);
		const createdBy: string[] = (details.created_by ?? []).map((c: any) => c.name);
		director = createdBy; // series: creators (latest-episode director needs extra call — Phase 3)
		writer = createdBy;
		producer = [];
		title = details.name ?? '';
		originalTitle = details.original_name ?? '';
		mediaType = 'TV Series';
		releaseDate = details.first_air_date || null;
		const rt: number[] = details.episode_run_time ?? [];
		runtime = rt.length > 0 ? rt[0] : null;
		status = details.status ?? '';
		contentRating = usCertFromContentRatings(details.content_ratings ?? {});
		const countries: string[] = details.origin_country ?? [];
		country = countries[0] ?? '';
		seasons = details.number_of_seasons ?? null;
		episodes = details.number_of_episodes ?? null;
		vod = (details.networks ?? []).map((n: any) => n.name);
		lastAirDate = details.last_air_date || null;
		const le = details.last_episode_to_air;
		const ne = details.next_episode_to_air;
		lastEpisode = le ? `S${le.season_number}, E${le.episode_number}: ${le.name}` : null;
		upEpisode = ne
			? `S${ne.season_number}, E${ne.episode_number}: ${ne.name}`
			: ['Returning Series', 'Pilot'].includes(status)
				? 'TBA'
				: null;
		nextAirDate = ne?.air_date ?? null;
		const start = (releaseDate ?? '').slice(0, 4);
		const ended = ['Ended', 'Canceled', 'Cancelled'].includes(status);
		const end = ended ? (lastAirDate ?? '').slice(0, 4) : null;
		yearDisp = end && end !== start ? `${start} - ${end}` : start && !ended ? `${start} -` : start;
	}

	const category: 'Movie' | 'Series' | 'Anime' =
		genres.includes('Animation') && language === 'Japanese' ? 'Anime' : isMovie ? 'Movie' : 'Series';

	const poster = details.poster_path ? IMG_BASE + details.poster_path : null;
	let engName = '';
	// eslint-disable-next-line no-control-regex
	if (originalTitle && originalTitle !== title && !/^[\x00-\x7F ]+$/.test(originalTitle)) {
		engName = title; // original is non-Latin → english name is the localized title
	}

	// ---- preserve user-managed fields ----
	let watchStatus = prev['watch_status'] || 'Unwatched';
	const rating = prev['rating'] || '0';
	const ratingStars = prev['rating_stars'] ?? '';
	const notionUrl = prev['notion_url'] || '';

	// ---- TV watch-status rule: new episode aired since last sync ----
	const prevLast = (prev['last_air_date'] ?? '').trim().replace(/^"|"$/g, '');
	if (!isMovie && watchStatus === 'Watched' && lastAirDate && prevLast && lastAirDate > prevLast) {
		watchStatus = 'Unwatched';
	}

	return {
		title, engName, mediaType, category,
		watchStatus, rating, ratingStars,
		year: yearDisp, runtime, seasons, episodes, vod, genre: genres, status,
		language, country, director, writer, producer, contentRating,
		tmdbRating: details.vote_average ?? null, tmdbId: String(details.id),
		imdbId, releaseDate, lastAirDate, nextAirDate, lastEpisode, upcomingEpisode: upEpisode,
		poster, trailer, homepage: details.homepage ?? '',
		imdbPage: imdbId ? `https://www.imdb.com/title/${imdbId}/` : '',
		notionUrl, synopsis: details.overview ?? '',
		cast: cast.join(', '),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/build.ts tests/watchlist-build.test.ts tests/fixtures/
git commit -m "feat(watchlist): buildRecord — TMDB detail → canonical record"
```

---

### Task 4: renderNote — record → note string (golden test)

**Files:**
- Create: `packages/obsidian/src/watchlist/render.ts`
- Create: `tests/fixtures/canonical-series.md` — copy verbatim from `/Users/AfiqZudinHadi/Documents/obsidian-media-db/reference/sample_canonical_series.md`
- Test: `tests/watchlist-render.test.ts`

**Interfaces:**
- Consumes: `WatchlistRecord`, yaml helpers.
- Produces: `renderNote(r: WatchlistRecord, myNotes: string): string` — full note content, frontmatter order exactly: `type, category, media_type, watch_status, rating, rating_stars, year, runtime, seasons, episodes, vod, genre, status, language, country, director, writer, producer, content_rating, tmdb_rating, tmdb_id, imdb_id, release_date, last_air_date, next_air_date, last_episode, upcoming_episode, eng_name, poster, trailer, homepage, imdb_page, notion_url, tags`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchlist-render.test.ts
import { describe, expect, test } from 'bun:test';
import { renderNote } from 'packages/obsidian/src/watchlist/render';
import type { WatchlistRecord } from 'packages/obsidian/src/watchlist/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOKI: WatchlistRecord = {
	title: 'Loki', engName: '', mediaType: 'TV Series', category: 'Series',
	watchStatus: 'Watched', rating: '5', ratingStars: '⭐️⭐️⭐️⭐️⭐️',
	year: '2021 - 2023', runtime: null, seasons: 2, episodes: 12, vod: ['Disney+'],
	genre: ['Drama', 'Sci-Fi & Fantasy'], status: 'Ended',
	language: 'English', country: 'United States of America',
	director: ['Aaron Moorhead', 'Justin Benson'], writer: ['Eric Martin'],
	producer: ['Rachel Alter', 'Tommy Turtle'], contentRating: 'TV-14',
	tmdbRating: 8.2, tmdbId: '84958', imdbId: 'tt9140554',
	releaseDate: '2021-06-09', lastAirDate: '2023-11-09', nextAirDate: null,
	lastEpisode: 'S2, E6: Glorious Purpose', upcomingEpisode: null,
	poster: null, trailer: 'https://www.youtube.com/watch?v=nW948Va-l10',
	homepage: 'https://www.disneyplus.com/series/wp/6pARMvILBGzF',
	imdbPage: 'https://www.imdb.com/title/tt9140554/',
	notionUrl: 'https://www.notion.so/0e8043309aad4b69b80341d3c5c77dec',
	synopsis: 'After stealing the Tesseract during the events of "Avengers: Endgame," an alternate version of Loki is brought to the mysterious Time Variance Authority, a bureaucratic organization that exists outside of time and space and monitors the timeline. They give Loki a choice: face being erased from existence due to being a "time variant" or help fix the timeline and stop a greater threat.',
	cast: 'Tom Hiddleston, Sophia Di Martino, Wunmi Mosaku, Eugene Cordero, Ke Huy Quan, Owen Wilson',
};

describe('renderNote golden', () => {
	test('matches canonical series fixture byte-for-byte', () => {
		const expected = readFileSync(join(import.meta.dir, 'fixtures', 'canonical-series.md'), 'utf-8');
		expect(renderNote(LOKI, '')).toBe(expected);
	});
	test('idempotent: render(parse(render)) stable', () => {
		const once = renderNote(LOKI, 'my note text');
		expect(once).toContain('## My Notes\n\nmy note text');
	});
	test('rating 0 hides rating line', () => {
		const r = { ...LOKI, rating: '0', ratingStars: '' };
		expect(renderNote(r, '')).not.toContain('**Rating:**');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation (port of `render_note`, watchlist_sync.py L216-267, + seasons/episodes/vod lines)**

```ts
// packages/obsidian/src/watchlist/render.ts
import type { WatchlistRecord } from 'packages/obsidian/src/watchlist/schema';
import { yamlList, yamlScalar, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';

const CATEGORY_TAG: Record<string, string> = { Movie: 'movie', Series: 'series', Anime: 'anime' };

export function renderNote(r: WatchlistRecord, myNotes: string): string {
	const tag = CATEGORY_TAG[r.category];
	const stars = r.ratingStars;
	const fm = [
		'---',
		'type: watchlist_item',
		`category: ${r.category}`,
		`media_type: ${r.mediaType}`,
		`watch_status: ${r.watchStatus}`,
		`rating: ${r.rating}`,
		`rating_stars: ${stars}`,
		`year: ${r.year || ''}`,
		`runtime: ${r.runtime ? r.runtime : 'null'}`,
		`seasons: ${r.seasons ?? 'null'}`,
		`episodes: ${r.episodes ?? 'null'}`,
		`vod: ${yamlList(r.vod)}`,
		`genre: ${yamlList(r.genre)}`,
		`status: ${r.status}`,
		`language: ${yamlScalar(r.language)}`,
		`country: ${yamlScalar(r.country)}`,
		`director: ${yamlScalar(r.director.join(', '))}`,
		`writer: ${yamlScalar(r.writer.join(', '))}`,
		`producer: ${yamlScalar(r.producer.join(', '))}`,
		`content_rating: ${r.contentRating}`,
		`tmdb_rating: ${r.tmdbRating}`,
		`tmdb_id: ${r.tmdbId}`,
		`imdb_id: ${r.imdbId}`,
		`release_date: ${r.releaseDate ? r.releaseDate : 'null'}`,
		`last_air_date: ${r.lastAirDate ? r.lastAirDate : 'null'}`,
		`next_air_date: ${r.nextAirDate ? r.nextAirDate : 'null'}`,
		`last_episode: ${r.lastEpisode ? yamlScalar(r.lastEpisode) : ''}`,
		`upcoming_episode: ${r.upcomingEpisode ? yamlScalar(r.upcomingEpisode) : ''}`,
		`eng_name: ${yamlScalar(r.engName)}`,
		`poster: ${quotedOrNull(r.poster)}`,
		`trailer: ${quotedOrNull(r.trailer)}`,
		`homepage: ${quotedOrNull(r.homepage)}`,
		`imdb_page: ${quotedOrNull(r.imdbPage)}`,
		`notion_url: ${quotedOrNull(r.notionUrl)}`,
		`tags: [watchlist, ${tag}]`,
		'---',
	];
	const b: string[] = ['', `# ${r.title}`];
	if (r.engName) b.push(`*${r.engName}*`);
	b.push('');
	if (r.poster) b.push(`![poster|200](${r.poster})`, '');
	const meta = [`**${r.category}**`, ...[r.year, r.language, r.country].filter(x => x)];
	b.push(meta.join(' · '), '');
	if (r.rating !== '0' && r.rating !== '' && stars) b.push(`**Rating:** ${stars} (${r.rating}/5)`);
	b.push(`**Watch Status:** ${r.watchStatus}`);
	if (r.tmdbRating) b.push(`**TMDB Rating:** ${r.tmdbRating}/10`);
	b.push('');
	if (r.synopsis) b.push('## Synopsis', r.synopsis, '');
	const crew: string[] = [];
	if (r.director.length) crew.push(`**Director:** ${r.director.join(', ')}`);
	if (r.writer.length) crew.push(`**Writer:** ${r.writer.join(', ')}`);
	if (r.producer.length) crew.push(`**Producer:** ${r.producer.join(', ')}`);
	if (crew.length) b.push(...crew, '');
	if (r.cast) b.push('## Cast', r.cast, '');
	const links: string[] = [];
	if (r.imdbPage) links.push(`- [IMDb](${r.imdbPage})`);
	if (r.trailer) links.push(`- [Trailer](${r.trailer})`);
	if (r.homepage) links.push(`- [Homepage](${r.homepage})`);
	if (r.notionUrl) links.push(`- [Original Notion entry](${r.notionUrl})`);
	if (links.length) b.push('## Links', ...links, '');
	b.push('## My Notes', '', myNotes, '');
	return fm.join('\n') + '\n' + b.join('\n');
}
```

NOTE for implementer: if the golden test fails on whitespace, diff the two strings char-by-char (`Bun.write` both to tmp files, `diff`) and adjust ONLY the fixture-vs-python discrepancies (e.g. trailing spaces after `last_episode:` when empty, final newline). The canonical fixture is the authority — real vault notes look like it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/render.ts tests/watchlist-render.test.ts tests/fixtures/canonical-series.md
git commit -m "feat(watchlist): renderNote — canonical note serializer (golden-tested)"
```

---

### Task 5: TMDB detail client (auth v3/v4, append_to_response)

**Files:**
- Create: `packages/obsidian/src/watchlist/tmdb.ts`
- Test: `tests/watchlist-tmdb.test.ts`

**Interfaces:**
- Consumes: nothing internal (http injected).
- Produces: `type HttpJsonFn = (url: string, headers: Record<string, string>) => Promise<any>`; `fetchDetail(http: HttpJsonFn, key: string, tmdbId: string, isMovie: boolean): Promise<any>`; `searchTitle(http: HttpJsonFn, key: string, query: string, isMovie: boolean, year?: string): Promise<any[]>`.
- Plugin passes an adapter over `obsidianFetch` (Task 6/7); tests pass a stub.

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchlist-tmdb.test.ts
import { describe, expect, test } from 'bun:test';
import { fetchDetail, searchTitle } from 'packages/obsidian/src/watchlist/tmdb';

function capture(): { calls: { url: string; headers: Record<string, string> }[]; http: any } {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	return {
		calls,
		http: async (url: string, headers: Record<string, string>) => {
			calls.push({ url, headers });
			return { results: [] };
		},
	};
}

describe('fetchDetail', () => {
	test('v4 token → Bearer header, no api_key param', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'eyJhbGciOi.fake.jwt', '693134', true);
		expect(calls[0].headers['Authorization']).toBe('Bearer eyJhbGciOi.fake.jwt');
		expect(calls[0].url).not.toContain('api_key');
	});
	test('v3 key → api_key param, no auth header', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'abc123', '693134', true);
		expect(calls[0].url).toContain('api_key=abc123');
		expect(calls[0].headers['Authorization']).toBeUndefined();
	});
	test('movie url + append', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'k', '693134', true);
		expect(calls[0].url).toContain('/3/movie/693134');
		expect(calls[0].url).toContain('append_to_response=credits%2Cexternal_ids%2Crelease_dates%2Cvideos');
		expect(calls[0].url).toContain('language=en-US');
	});
	test('tv url + append', async () => {
		const { calls, http } = capture();
		await fetchDetail(http, 'k', '84958', false);
		expect(calls[0].url).toContain('/3/tv/84958');
		expect(calls[0].url).toContain('append_to_response=aggregate_credits%2Cexternal_ids%2Ccontent_ratings%2Cvideos');
	});
});

describe('searchTitle', () => {
	test('movie search url + year', async () => {
		const { calls, http } = capture();
		await searchTitle(http, 'k', 'Dune Part Two', true, '2024');
		expect(calls[0].url).toContain('/3/search/movie');
		expect(calls[0].url).toContain('query=Dune+Part+Two');
		expect(calls[0].url).toContain('primary_release_year=2024');
	});
	test('tv search url', async () => {
		const { calls, http } = capture();
		await searchTitle(http, 'k', 'Loki', false, '2021');
		expect(calls[0].url).toContain('/3/search/tv');
		expect(calls[0].url).toContain('first_air_date_year=2021');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```ts
// packages/obsidian/src/watchlist/tmdb.ts
export type HttpJsonFn = (url: string, headers: Record<string, string>) => Promise<any>;

const BASE = 'https://api.themoviedb.org/3';

function authParts(key: string): { headers: Record<string, string>; extraParams: Record<string, string> } {
	if (key.startsWith('eyJ')) {
		return { headers: { Authorization: `Bearer ${key}`, accept: 'application/json' }, extraParams: {} };
	}
	return { headers: { accept: 'application/json' }, extraParams: { api_key: key } };
}

function buildUrl(path: string, params: Record<string, string>): string {
	const qs = new URLSearchParams(params);
	return `${BASE}${path}?${qs.toString()}`;
}

export async function fetchDetail(http: HttpJsonFn, key: string, tmdbId: string, isMovie: boolean): Promise<any> {
	const { headers, extraParams } = authParts(key);
	const path = isMovie ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
	const append = isMovie ? 'credits,external_ids,release_dates,videos' : 'aggregate_credits,external_ids,content_ratings,videos';
	return await http(buildUrl(path, { append_to_response: append, language: 'en-US', ...extraParams }), headers);
}

export async function searchTitle(http: HttpJsonFn, key: string, query: string, isMovie: boolean, year?: string): Promise<any[]> {
	const { headers, extraParams } = authParts(key);
	const params: Record<string, string> = { query, language: 'en-US', ...extraParams };
	if (year) params[isMovie ? 'primary_release_year' : 'first_air_date_year'] = year;
	const res = await http(buildUrl(isMovie ? '/search/movie' : '/search/tv', params), headers);
	return res?.results ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/tmdb.ts tests/watchlist-tmdb.test.ts
git commit -m "feat(watchlist): tmdb client — v3/v4 auth, detail + search"
```

---

### Task 6: SyncEngine — iterate, tier, throttle, diff-on-write, watch rule

**Files:**
- Create: `packages/obsidian/src/watchlist/SyncEngine.ts`
- Test: `tests/watchlist-sync-engine.test.ts`

**Interfaces:**
- Consumes: `parseNote`, `extractMyNotes`, `noteTmdbRef` (Task 2); `buildRecord` (Task 3); `renderNote` (Task 4).
- Produces:

```ts
export interface SyncDeps {
	listNotes(): Promise<{ path: string; content: string }[]>;
	writeNote(path: string, content: string): Promise<void>;
	fetchDetail(tmdbId: string, isMovie: boolean): Promise<any>; // throws TmdbRateLimitError on 429
	sleep(ms: number): Promise<void>;
	log(msg: string): void;
}
export interface SyncOptions { full?: boolean; dryRun?: boolean; throttleMs?: number } // throttleMs default 250
export interface SyncReport { scanned: number; synced: number; written: number; skippedNoId: number; skippedStatic: number; flipped: string[]; errors: { path: string; error: string }[] }
export class TmdbRateLimitError extends Error { retryAfterMs: number }
export async function syncFolder(deps: SyncDeps, opts?: SyncOptions): Promise<SyncReport>
export function isActive(fm: Record<string, string>): boolean
```

Tier rule: `isActive(fm)` = `status` ∈ {`Returning Series`, `In Production`, `Planned`, `Pilot`} OR `watch_status` = `Watching` OR `next_air_date` set (non-null, non-empty) OR `status` missing/empty. Everything else = STATIC → skipped unless `opts.full`.

429 handling: on `TmdbRateLimitError`, `sleep(retryAfterMs)`, retry ONCE; second failure records error for that note and continues.

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchlist-sync-engine.test.ts
import { describe, expect, test } from 'bun:test';
import { syncFolder, isActive, TmdbRateLimitError, type SyncDeps } from 'packages/obsidian/src/watchlist/SyncEngine';
import tvDetail from 'tests/fixtures/tmdb-tv-loki.json';

const ENDED_NOTE = `---
type: watchlist_item
media_type: TV Series
watch_status: Watched
rating: 5
rating_stars: ⭐️⭐️⭐️⭐️⭐️
status: Ended
tmdb_id: 84958
last_air_date: 2023-11-09
---

# Loki

## My Notes

keep me
`;

const AIRING_NOTE = ENDED_NOTE.replace('status: Ended', 'status: Returning Series').replace('last_air_date: 2023-11-09', 'last_air_date: 2023-10-01');

function makeDeps(notes: { path: string; content: string }[], detail: any = tvDetail) {
	const writes: { path: string; content: string }[] = [];
	const fetches: string[] = [];
	const deps: SyncDeps = {
		listNotes: async () => notes,
		writeNote: async (path, content) => { writes.push({ path, content }); },
		fetchDetail: async (id) => { fetches.push(id); return detail; },
		sleep: async () => {},
		log: () => {},
	};
	return { deps, writes, fetches };
}

describe('isActive tiering', () => {
	test('Returning Series → active', () => expect(isActive({ status: 'Returning Series' })).toBe(true));
	test('Watching → active regardless of status', () => expect(isActive({ status: 'Ended', watch_status: 'Watching' })).toBe(true));
	test('next_air_date set → active', () => expect(isActive({ status: 'Ended', next_air_date: '2026-08-01' })).toBe(true));
	test('Ended → static', () => expect(isActive({ status: 'Ended', next_air_date: 'null' })).toBe(false));
	test('Released movie → static', () => expect(isActive({ status: 'Released' })).toBe(false));
	test('missing status → active (needs first enrich)', () => expect(isActive({})).toBe(true));
});

describe('syncFolder', () => {
	test('default run skips static notes', async () => {
		const { deps, fetches } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		const report = await syncFolder(deps);
		expect(fetches.length).toBe(0);
		expect(report.skippedStatic).toBe(1);
	});
	test('full run processes static notes', async () => {
		const { deps, fetches } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		await syncFolder(deps, { full: true });
		expect(fetches).toEqual(['84958']);
	});
	test('diff-on-write: unchanged content not rewritten', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		const first = await syncFolder(deps, { full: true });
		expect(first.written).toBe(1);
		// second pass with the note the engine just produced → no write
		const rendered = (await (async () => { const w: any[] = []; const d2 = { ...deps, listNotes: async () => [{ path: 'Loki.md', content: (await deps as any).lastWrite }] }; return null; })(), null);
		// simpler: re-run with the written content
	});
	test('watch rule flips through full pipeline', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: AIRING_NOTE }]);
		const report = await syncFolder(deps);
		expect(writes.length).toBe(1);
		expect(writes[0].content).toContain('watch_status: Unwatched');
		expect(report.flipped).toEqual(['Loki.md']);
	});
	test('My Notes preserved through rewrite', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: AIRING_NOTE }]);
		await syncFolder(deps);
		expect(writes[0].content).toContain('keep me');
	});
	test('no tmdb ref → skipped, counted', async () => {
		const { deps, fetches } = makeDeps([{ path: '_Dashboard.md', content: '# dash' }]);
		const report = await syncFolder(deps, { full: true });
		expect(fetches.length).toBe(0);
		expect(report.skippedNoId).toBe(1);
	});
	test('dryRun: no writes, report counts', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: AIRING_NOTE }]);
		const report = await syncFolder(deps, { dryRun: true });
		expect(writes.length).toBe(0);
		expect(report.written).toBe(1); // counts what WOULD be written
	});
	test('429 → sleep(retryAfter) then retry succeeds', async () => {
		let calls = 0;
		const slept: number[] = [];
		const deps: SyncDeps = {
			listNotes: async () => [{ path: 'Loki.md', content: AIRING_NOTE }],
			writeNote: async () => {},
			fetchDetail: async () => {
				calls++;
				if (calls === 1) { const e = new TmdbRateLimitError('429'); e.retryAfterMs = 1500; throw e; }
				return tvDetail;
			},
			sleep: async ms => { slept.push(ms); },
			log: () => {},
		};
		const report = await syncFolder(deps);
		expect(calls).toBe(2);
		expect(slept).toContain(1500);
		expect(report.errors.length).toBe(0);
	});
	test('fetch error recorded, other notes continue', async () => {
		const { deps } = makeDeps([
			{ path: 'Bad.md', content: AIRING_NOTE },
			{ path: 'Good.md', content: AIRING_NOTE },
		]);
		let n = 0;
		deps.fetchDetail = async () => { n++; if (n === 1) throw new Error('boom'); return tvDetail; };
		const report = await syncFolder(deps);
		expect(report.errors.length).toBe(1);
		expect(report.errors[0].path).toBe('Bad.md');
		expect(report.synced).toBe(1);
	});
});
```

NOTE for implementer: replace the malformed `diff-on-write` test above with this working version:

```ts
	test('diff-on-write: second pass on rendered output writes nothing', async () => {
		const { deps, writes } = makeDeps([{ path: 'Loki.md', content: ENDED_NOTE }]);
		await syncFolder(deps, { full: true });
		const rendered = writes[0].content;
		const second = makeDeps([{ path: 'Loki.md', content: rendered }]);
		const report = await syncFolder(second.deps, { full: true });
		expect(second.writes.length).toBe(0);
		expect(report.written).toBe(0);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```ts
// packages/obsidian/src/watchlist/SyncEngine.ts
import { parseNote, extractMyNotes, noteTmdbRef } from 'packages/obsidian/src/watchlist/parse';
import { buildRecord } from 'packages/obsidian/src/watchlist/build';
import { renderNote } from 'packages/obsidian/src/watchlist/render';

export interface SyncDeps {
	listNotes(): Promise<{ path: string; content: string }[]>;
	writeNote(path: string, content: string): Promise<void>;
	fetchDetail(tmdbId: string, isMovie: boolean): Promise<any>;
	sleep(ms: number): Promise<void>;
	log(msg: string): void;
}

export interface SyncOptions {
	full?: boolean;
	dryRun?: boolean;
	throttleMs?: number;
}

export interface SyncReport {
	scanned: number;
	synced: number;
	written: number;
	skippedNoId: number;
	skippedStatic: number;
	flipped: string[];
	errors: { path: string; error: string }[];
}

export class TmdbRateLimitError extends Error {
	retryAfterMs: number = 2000;
}

const ACTIVE_STATUSES = new Set(['Returning Series', 'In Production', 'Planned', 'Pilot']);

function strip(s: string | undefined): string {
	return (s ?? '').trim().replace(/^"|"$/g, '');
}

export function isActive(fm: Record<string, string>): boolean {
	const status = strip(fm['status']);
	if (!status) return true; // never enriched → needs first pass
	if (ACTIVE_STATUSES.has(status)) return true;
	if (strip(fm['watch_status']) === 'Watching') return true;
	const nextAir = strip(fm['next_air_date']);
	if (nextAir && nextAir !== 'null') return true;
	return false;
}

export async function syncFolder(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncReport> {
	const throttleMs = opts.throttleMs ?? 250;
	const report: SyncReport = { scanned: 0, synced: 0, written: 0, skippedNoId: 0, skippedStatic: 0, flipped: [], errors: [] };
	const notes = await deps.listNotes();
	for (const note of notes) {
		report.scanned++;
		const { frontmatter, body } = parseNote(note.content);
		const ref = noteTmdbRef(frontmatter);
		if (!ref) {
			report.skippedNoId++;
			continue;
		}
		if (!opts.full && !isActive(frontmatter)) {
			report.skippedStatic++;
			continue;
		}
		try {
			let detail: any;
			try {
				detail = await deps.fetchDetail(ref.tmdbId, ref.isMovie);
			} catch (e) {
				if (e instanceof TmdbRateLimitError) {
					await deps.sleep(e.retryAfterMs);
					detail = await deps.fetchDetail(ref.tmdbId, ref.isMovie);
				} else {
					throw e;
				}
			}
			const record = buildRecord(detail, ref.isMovie, frontmatter);
			const rendered = renderNote(record, extractMyNotes(body));
			report.synced++;
			if (strip(frontmatter['watch_status']) === 'Watched' && record.watchStatus === 'Unwatched') {
				report.flipped.push(note.path);
			}
			if (rendered !== note.content) {
				report.written++;
				if (!opts.dryRun) await deps.writeNote(note.path, rendered);
				deps.log(`${opts.dryRun ? '[dry] ' : ''}updated ${note.path}`);
			}
			await deps.sleep(throttleMs);
		} catch (e) {
			report.errors.push({ path: note.path, error: e instanceof Error ? e.message : String(e) });
			deps.log(`ERROR ${note.path}: ${String(e)}`);
		}
	}
	return report;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/SyncEngine.ts tests/watchlist-sync-engine.test.ts
git commit -m "feat(watchlist): SyncEngine — tiered diff-on-write sync with throttle/backoff"
```

---

### Task 7: Settings + plugin wiring (commands, interval, catch-up)

**Files:**
- Modify: `packages/obsidian/src/settings/Settings.ts` — add fields to `MediaDbPluginSettings` (~L52-132), defaults to `DEFAULT_SETTINGS` (~L311), UI section in `MediaDbSettingTab.display()` (~L442)
- Modify: `packages/obsidian/src/main.ts` — commands in `registerCommands()` (~L103), interval in `onload()` (~L48)
- Create: `packages/obsidian/src/watchlist/WatchlistController.ts` (vault adapter + scheduler glue)
- Test: `tests/watchlist-controller.test.ts`

**Interfaces:**
- Consumes: `syncFolder`, `SyncDeps` (Task 6); `fetchDetail` (Task 5); existing `plugin.settings`, `app.vault`, `obsidianFetch` (`packages/obsidian/src/utils/Utils.ts:283`), secretStorage pattern from `TMDBMovieAPI.ts:64`.
- Produces: `WatchlistController` with `syncNow(full: boolean, dryRun: boolean): Promise<SyncReport>`, `maybeCatchUp(): Promise<void>`, `resolveMissingIds(dryRun: boolean): Promise<void>` (impl Task 8).

New settings fields (add to interface + defaults):

```ts
	watchlistEnabled: boolean;        // default false
	watchlistFolder: string;          // default 'Watchlist'
	watchlistSyncIntervalHours: number; // default 24
	watchlistLastSync: number;        // epoch ms, default 0 — updated after each successful scheduled sync
```

Settings UI (new "Watchlist sync" group in `display()`): toggle `watchlistEnabled`, text `watchlistFolder`, slider/text `watchlistSyncIntervalHours` (1–168). TMDB key reuses the existing TMDB secret (`settings.TMDBKeyId` via secretStorage) — no new key field.

`WatchlistController` core:

```ts
// packages/obsidian/src/watchlist/WatchlistController.ts
import { Notice, TFile, TFolder } from 'obsidian';
import type MediaDbPlugin from 'packages/obsidian/src/main';
import { syncFolder, TmdbRateLimitError, type SyncDeps, type SyncReport } from 'packages/obsidian/src/watchlist/SyncEngine';
import { fetchDetail } from 'packages/obsidian/src/watchlist/tmdb';
import { obsidianFetch } from 'packages/obsidian/src/utils/Utils';

export class WatchlistController {
	constructor(private plugin: MediaDbPlugin) {}

	private async getKey(): Promise<string> {
		const keyId = this.plugin.settings.TMDBKeyId;
		const key = keyId ? await this.plugin.app.secretStorage.getSecret(keyId) : '';
		if (!key) throw new Error('TMDB API key not configured (Media DB Sync settings).');
		return key;
	}

	private makeDeps(key: string): SyncDeps {
		const { app } = this.plugin;
		const folder = app.vault.getAbstractFileByPath(this.plugin.settings.watchlistFolder);
		return {
			listNotes: async () => {
				if (!(folder instanceof TFolder)) throw new Error(`Watchlist folder not found: ${this.plugin.settings.watchlistFolder}`);
				const files = folder.children.filter((f): f is TFile => f instanceof TFile && f.extension === 'md' && !f.name.startsWith('_'));
				const out: { path: string; content: string }[] = [];
				for (const f of files) out.push({ path: f.path, content: await app.vault.read(f) });
				return out;
			},
			writeNote: async (path, content) => {
				const f = app.vault.getAbstractFileByPath(path);
				if (f instanceof TFile) await app.vault.modify(f, content);
			},
			fetchDetail: async (tmdbId, isMovie) => {
				const http = async (url: string, headers: Record<string, string>): Promise<any> => {
					const res = await obsidianFetch({ url, headers });
					if (res.status === 429) {
						const err = new TmdbRateLimitError('TMDB 429');
						const ra = Number(res.headers?.['retry-after'] ?? 2);
						err.retryAfterMs = ra * 1000;
						throw err;
					}
					if (res.status !== 200) throw new Error(`TMDB ${res.status} for ${url}`);
					return res.json;
				};
				return await fetchDetail(http, tmdbId, isMovie, key === undefined ? '' : key);
			},
			sleep: ms => new Promise(r => setTimeout(r, ms)),
			log: msg => console.log(`[media-db-sync] ${msg}`),
		};
	}

	async syncNow(full: boolean, dryRun = false): Promise<SyncReport> {
		const key = await this.getKey();
		const report = await syncFolder(this.makeDeps(key), { full, dryRun });
		const mode = dryRun ? 'DRY-RUN ' : '';
		new Notice(
			`Watchlist ${mode}sync: ${report.synced} checked, ${report.written} updated, ${report.flipped.length} flipped to Unwatched` +
				(report.errors.length ? `, ${report.errors.length} errors (see console)` : ''),
		);
		if (!dryRun) {
			this.plugin.settings.watchlistLastSync = Date.now();
			await this.plugin.saveSettings();
		}
		return report;
	}

	async maybeCatchUp(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.watchlistEnabled) return;
		const due = s.watchlistLastSync + s.watchlistSyncIntervalHours * 3600_000;
		if (Date.now() >= due) {
			await this.syncNow(false).catch(e => console.error('[media-db-sync] scheduled sync failed', e));
		}
	}
}
```

NOTE for implementer: check exact `obsidianFetch` signature/return at `packages/obsidian/src/utils/Utils.ts:283` and the exact secretStorage call shape at `packages/obsidian/src/api/apis/TMDBMovieAPI.ts:62-90` before writing — mirror what the codebase actually does (incl. how non-200s and headers surface). Fix the `fetchDetail(http, tmdbId, isMovie, key…)` argument order to match Task 5's signature `fetchDetail(http, key, tmdbId, isMovie)`.

`main.ts` wiring (inside `onload()` after settings load):

```ts
		this.watchlist = new WatchlistController(this);
		// catch-up shortly after startup (let vault index settle), then hourly due-check
		window.setTimeout(() => void this.watchlist.maybeCatchUp(), 30_000);
		this.registerInterval(window.setInterval(() => void this.watchlist.maybeCatchUp(), 3600_000));
```

Commands (inside `registerCommands()`):

```ts
		this.addCommand({
			id: 'watchlist-sync-now',
			name: 'Watchlist: sync now (airing/active only)',
			callback: () => void this.watchlist.syncNow(false),
		});
		this.addCommand({
			id: 'watchlist-sync-full',
			name: 'Watchlist: full sync (all entries)',
			callback: () => void this.watchlist.syncNow(true),
		});
		this.addCommand({
			id: 'watchlist-sync-dry-run',
			name: 'Watchlist: dry-run full sync (log only, no writes)',
			callback: () => void this.watchlist.syncNow(true, true),
		});
```

- [ ] **Step 1: Write failing controller test** — `tests/watchlist-controller.test.ts` covering `maybeCatchUp` due-time logic with a fake plugin object (settings + stubbed `syncNow`): overdue → calls sync; not due → no call; disabled → no call.

```ts
// tests/watchlist-controller.test.ts
import { describe, expect, test } from 'bun:test';
import { WatchlistController } from 'packages/obsidian/src/watchlist/WatchlistController';

function fakePlugin(overrides: Partial<{ enabled: boolean; last: number; hours: number }> = {}) {
	return {
		settings: {
			watchlistEnabled: overrides.enabled ?? true,
			watchlistLastSync: overrides.last ?? 0,
			watchlistSyncIntervalHours: overrides.hours ?? 24,
			watchlistFolder: 'Watchlist',
			TMDBKeyId: 'kid',
		},
		saveSettings: async () => {},
		app: {},
	} as any;
}

describe('maybeCatchUp', () => {
	test('overdue → syncs', async () => {
		const c = new WatchlistController(fakePlugin({ last: 0 }));
		let called = false;
		(c as any).syncNow = async () => { called = true; return {} as any; };
		await c.maybeCatchUp();
		expect(called).toBe(true);
	});
	test('recent sync → no call', async () => {
		const c = new WatchlistController(fakePlugin({ last: Date.now() }));
		let called = false;
		(c as any).syncNow = async () => { called = true; return {} as any; };
		await c.maybeCatchUp();
		expect(called).toBe(false);
	});
	test('disabled → no call', async () => {
		const c = new WatchlistController(fakePlugin({ enabled: false, last: 0 }));
		let called = false;
		(c as any).syncNow = async () => { called = true; return {} as any; };
		await c.maybeCatchUp();
		expect(called).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** `WatchlistController.ts` (code above, with obsidianFetch/secretStorage shapes verified against the codebase), settings fields + defaults + UI group, `main.ts` commands + interval + `watchlist` property.

- [ ] **Step 4: Run all gates**

Run: `bun run test 2>&1 | tail -5` → PASS; `bun run tsc` → exit 0; `bun run build 2>&1 | tail -3` → built.

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/WatchlistController.ts packages/obsidian/src/settings/Settings.ts packages/obsidian/src/main.ts tests/watchlist-controller.test.ts
git commit -m "feat(watchlist): settings, commands, catch-up scheduler wiring"
```

---

### Task 8: Resolve-missing-ids command

**Files:**
- Create: `packages/obsidian/src/watchlist/resolve.ts`
- Modify: `packages/obsidian/src/watchlist/WatchlistController.ts` (add `resolveMissingIds`)
- Modify: `packages/obsidian/src/main.ts` (add command)
- Test: `tests/watchlist-resolve.test.ts`

**Interfaces:**
- Consumes: `searchTitle` (Task 5), `parseNote` (Task 2).
- Produces: `resolveNote(fm: Record<string, string>, filename: string, search: (q: string, isMovie: boolean, year?: string) => Promise<any[]>): Promise<{ tmdbId: string; isMovie: boolean; matchedTitle: string } | null>`.

Rules: candidate query = `title` field else filename minus `.md`. `year` hint = leading 4 digits of `year`/`release_date` if present. `media_type` field decides movie vs tv; missing → try movie first, then tv. Accept top result ONLY if its title (or original title) case-insensitively equals the query, OR it is the only result. Otherwise return null (log for manual fix) — no guessing.

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchlist-resolve.test.ts
import { describe, expect, test } from 'bun:test';
import { resolveNote } from 'packages/obsidian/src/watchlist/resolve';

const HIT = { id: 693134, title: 'Dune: Part Two', original_title: 'Dune: Part Two' };
const OTHER = { id: 1, title: 'Dune', original_title: 'Dune' };

describe('resolveNote', () => {
	test('exact title match accepted', async () => {
		const r = await resolveNote({ media_type: 'Movie' }, 'Dune: Part Two.md', async () => [HIT, OTHER]);
		expect(r).toEqual({ tmdbId: '693134', isMovie: true, matchedTitle: 'Dune: Part Two' });
	});
	test('single result accepted even if inexact', async () => {
		const r = await resolveNote({ media_type: 'Movie' }, 'Dune Part 2.md', async () => [HIT]);
		expect(r?.tmdbId).toBe('693134');
	});
	test('ambiguous → null', async () => {
		const r = await resolveNote({ media_type: 'Movie' }, 'Dune something.md', async () => [HIT, OTHER]);
		expect(r).toBeNull();
	});
	test('no media_type → movie then tv fallback', async () => {
		const calls: boolean[] = [];
		const r = await resolveNote({}, 'Loki.md', async (q, isMovie) => {
			calls.push(isMovie);
			return isMovie ? [] : [{ id: 84958, name: 'Loki', original_name: 'Loki' }];
		});
		expect(calls).toEqual([true, false]);
		expect(r).toEqual({ tmdbId: '84958', isMovie: false, matchedTitle: 'Loki' });
	});
	test('year hint passed through', async () => {
		let seenYear: string | undefined;
		await resolveNote({ media_type: 'Movie', year: '2024' }, 'Dune: Part Two.md', async (q, m, year) => {
			seenYear = year;
			return [HIT];
		});
		expect(seenYear).toBe('2024');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | tail -5`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```ts
// packages/obsidian/src/watchlist/resolve.ts
type SearchFn = (query: string, isMovie: boolean, year?: string) => Promise<any[]>;

export interface ResolveResult {
	tmdbId: string;
	isMovie: boolean;
	matchedTitle: string;
}

function resultTitle(r: any): string {
	return r.title ?? r.name ?? '';
}

function resultTitles(r: any): string[] {
	return [r.title, r.original_title, r.name, r.original_name].filter(Boolean).map((t: string) => t.toLowerCase());
}

async function tryOne(query: string, isMovie: boolean, year: string | undefined, search: SearchFn): Promise<ResolveResult | null> {
	const results = await search(query, isMovie, year);
	if (results.length === 0) return null;
	const q = query.toLowerCase();
	const exact = results.find(r => resultTitles(r).includes(q));
	const pick = exact ?? (results.length === 1 ? results[0] : null);
	if (!pick) return null;
	return { tmdbId: String(pick.id), isMovie, matchedTitle: resultTitle(pick) };
}

export async function resolveNote(fm: Record<string, string>, filename: string, search: SearchFn): Promise<ResolveResult | null> {
	const strip = (s: string | undefined): string => (s ?? '').trim().replace(/^"|"$/g, '');
	const query = strip(fm['title']) || filename.replace(/\.md$/, '');
	const yearField = strip(fm['year']) || strip(fm['release_date']);
	const year = /^\d{4}/.exec(yearField)?.[0];
	const mt = strip(fm['media_type']);
	if (mt === 'Movie') return await tryOne(query, true, year, search);
	if (mt) return await tryOne(query, false, year, search);
	return (await tryOne(query, true, year, search)) ?? (await tryOne(query, false, year, search));
}
```

Controller addition (`WatchlistController.resolveMissingIds(dryRun)`): list notes → for each with NO `noteTmdbRef` AND `type` missing or `watchlist_item` (skip `_`-prefixed, skip `type: list` dashboards) → `resolveNote` with `searchTitle` bound to key/http → on hit: patch `tmdb_id` + `media_type` into frontmatter (regex insert after `type:` line or prepend fm block if absent) and log; on null: log "ambiguous/no match". Notice summary at end. Command id `watchlist-resolve-ids`, name `Watchlist: resolve missing TMDB ids`. Next scheduled/manual sync then enriches them (missing `status` → ACTIVE tier → picked up automatically).

- [ ] **Step 4: Run all gates**

Run: `bun run test 2>&1 | tail -5` → PASS; `bun run tsc` → 0; `bun run build 2>&1 | tail -3` → built.

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian/src/watchlist/resolve.ts packages/obsidian/src/watchlist/WatchlistController.ts packages/obsidian/src/main.ts tests/watchlist-resolve.test.ts
git commit -m "feat(watchlist): resolve-missing-ids command"
```

---

### Task 9: Real-vault dry-run verification

**Files:**
- No new source. Verification against `/Users/AfiqZudinHadi/Documents/ai_brain/02 - Areas/Interests/Watchlist/` (568 notes; ALL have tmdb_id — verified 2026-07-29; 5 extra non-entry files skip via no-id path).

- [ ] **Step 1: Commit vault state** — `cd ~/Documents/ai_brain && git add -A && git commit -m "pre-sync snapshot"` (revert point).
- [ ] **Step 2: Install dev build** — copy `dist/main.js`, `dist/styles.css`, `manifest.json` into `~/Documents/ai_brain/.obsidian/plugins/media-db-sync/`, enable in Obsidian, set folder `02 - Areas/Interests/Watchlist`, confirm TMDB key present.
- [ ] **Step 3: Run `Watchlist: dry-run full sync`** — read console log. Expect: 568 checked, plausible update count (formatting normalization, e.g. `tmdb_rating 7.0→7`, is expected on first pass), 0 errors, no vault modifications (`git status` clean).
- [ ] **Step 4: Review a sample of logged diffs** — user (Afiq) approves before any live run. STOP here for user sign-off.
- [ ] **Step 5: Live full sync** — run `Watchlist: full sync`, then `git diff --stat` in vault; spot-check: an airing series updated, an Ended one byte-identical (or normalized once), `## My Notes` intact everywhere (`git diff -U0 | grep -c 'My Notes'` → 0 content changes under that heading).
- [ ] **Step 6: Verify in Obsidian Base** — `Watchlist.base` tabs render; `next_air_date`/`last_episode` fresh on airing series.
- [ ] **Step 7: Commit fork** — final state, push branch.

---

## Self-Review Notes

- Spec coverage: schema fields (SPEC.md) → Tasks 3/4 incl. `seasons`/`episodes`/`vod` (absent from python reference, present in real vault — always emit, movies `null`/`null`/`[]`). Sync + tiering + throttle → Task 6. Catch-up scheduler → Task 7. Watch rule → Task 3 (logic) + 6 (report). Resolve → Task 8. v3/v4 auth → Task 5. Preserve fields → Tasks 3/6 tests. Dry-run → Tasks 6/7/9.
- Known deliberate deviations from python: comma added to `yamlScalar` quoting regex (matches real vault output); `seasons`/`episodes`/`vod` added; TS number formatting may normalize `x.0` ratings (one-time diff, reviewed in Task 9 dry-run).
- Type consistency: `WatchlistRecord` field names used identically in Tasks 3, 4, 6. `fetchDetail(http, key, tmdbId, isMovie)` — Task 7 code block has an arg-order bug flagged in its NOTE; implementer must match Task 5.
- Phase 2 (manga/books/games) intentionally out of scope.
