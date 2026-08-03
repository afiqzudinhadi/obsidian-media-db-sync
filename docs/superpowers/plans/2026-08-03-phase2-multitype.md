# Phase 2 Multi-Type Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the plugin to manga/books/games/comics: canonical schemas, enrichment, resolve, tiered sync w/ chapter/issue flip automation (RSS → MangaDex → Jikan for manga; Comic Vine for comics).

**Architecture:** New `packages/obsidian/src/library/` module. Per-type `MediaTypeSpec` objects (manga/book/game/comic) plug into one generic `librarySync` engine that copies Phase 1's proven shape (diff-on-write, tier, throttle, 429 retry via `withRateLimitRetry`, custom-section + user-field preservation). Watchlist code untouched.

**Tech Stack:** bun + vite; tests `bun run test` (NEVER raw `bun test`); typecheck `bun run typecheck`; build `bun run build`. All three green before every commit.

**Spec:** `docs/superpowers/specs/2026-08-03-phase2-multitype-design.md` — field tables + decisions are authoritative. Phase 1 pattern anchors: `packages/obsidian/src/watchlist/` (parse.ts helpers reusable as-is; SyncEngine.ts = engine shape to copy; WatchlistController.ts = controller idioms; tmdb.ts = fetcher shape).

## Global Constraints

- ALL HTTP via injected `HttpJsonFn`/`HttpTextFn`; plugin wires `obsidianFetch` (see `WatchlistController.makeHttp`). Never node fetch.
- Preserve on every write: `rating`, `rating_stars`, per-type status field (`read_status`/`play_status`), `last_read_chapter`/`last_read_issue`, `rss`, all id fields once set, body `## My Notes` + `## Collection` + any custom `##` section (use Phase 1 `extractCustomSections`/`renderNote` pattern).
- ISO string dates, lexicographic compare, no `Date` parsing of data values.
- Diff-on-write; dryRun counts without writing.
- Ratings/scores 1 decimal.
- Per-spec throttleMs: jikan 350, mangadex 250, comicvine 350, openlibrary 250, steam 250, rawg 250, rss 100.
- Unique-exact-match resolve semantics (Phase 1 `resolve.ts` rule: 1 exact → accept; 0 exact + sole result → accept; else null).
- NO Claude/AI attribution in commit messages.
- Real vault data (fixtures source): `/Users/AfiqZudinHadi/Documents/ai_brain/02 - Areas/Interests/{Mangas,Books,Games,Comics}/` — entries currently stock-skeleton fm (`type: comicManga|book|game`, `dataSource: manual`, empty `id`); first sync converts to canonical.

### API endpoints (verify response shapes against docs/adapters during impl; upstream adapters in `packages/obsidian/src/api/apis/` show auth/URL conventions)

| API | Resolve | Enrich | Auth |
|---|---|---|---|
| Jikan | `GET https://api.jikan.moe/v4/manga?q={title}&limit=10` | `GET https://api.jikan.moe/v4/manga/{mal_id}/full` | none |
| MangaDex | `GET https://api.mangadex.org/manga?title={t}&limit=10` | `GET https://api.mangadex.org/manga/{id}/feed?order[readableAt]=desc&limit=1&translatedLanguage[]=en` → latest chapter `attributes.chapter` + `attributes.readableAt` | none |
| Open Library | `GET https://openlibrary.org/search.json?q={t}&limit=10` (docs[].key=`/works/OL…W`, author_name, first_publish_year, number_of_pages_median, subject, cover_i) | search doc is enough — no second call needed | none |
| Steam | appid from note `url` regex `store\.steampowered\.com/app/(\d+)` (28/31 games have it); else name search `GET https://store.steampowered.com/api/storesearch/?term={t}&cc=us&l=en` | `GET https://store.steampowered.com/api/appdetails?appids={id}&cc=us&l=en` → `{[id]:{success,data:{name,developers,publishers,genres[].description,release_date.date,metacritic.score,header_image,short_description}}}` (release_date.date = "2 Mar, 2018" → parse to ISO) | none |
| RAWG | `GET https://api.rawg.io/api/games?key={k}&search={t}&page_size=10` | `GET https://api.rawg.io/api/games/{id}?key={k}` → name, developers[].name, publishers[].name, platforms[].platform.name, genres[].name, released (ISO), metacritic, background_image, description_raw | key (query param) |
| Comic Vine | `GET https://comicvine.gamespot.com/api/volumes/?api_key={k}&format=json&filter=name:{t}&limit=10` | `GET https://comicvine.gamespot.com/api/volume/4050-{id}/?api_key={k}&format=json` → name, publisher.name, count_of_issues, last_issue{issue_number,name}, start_year, image.original_url, description (HTML → strip tags), people[].name | key; also send `User-Agent` style headers per ComicVineAPI.ts conventions |
| RSS | note `rss` field URL → `GET` raw XML | items via regex parse (no DOMParser dependency): `<item>…</item>` / `<entry>…</entry>`, fields title / pubDate|updated / guid|id | none |

---

### Task 1: Library core — types + RSS/Atom parser

**Files:**
- Create: `packages/obsidian/src/library/types.ts`
- Create: `packages/obsidian/src/library/rss.ts`
- Test: `tests/library-rss.test.ts`

**Interfaces (produces):**

```ts
// types.ts
export type HttpJsonFn = (url: string, headers: Record<string, string>) => Promise<any>;
export type HttpTextFn = (url: string, headers: Record<string, string>) => Promise<string>;

export interface LibraryNoteCtx {
	frontmatter: Record<string, string>;
	body: string;
	filename: string;
}

export interface MediaTypeSpec {
	typeName: 'manga' | 'book' | 'game' | 'comic';
	itemType: string; // 'manga_item' etc.
	folderSettingKey: string;
	enabledSettingKey: string;
	throttleMs: number;
	hasId(fm: Record<string, string>): boolean;
	isActive(fm: Record<string, string>): boolean;
	resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<Record<string, string> | null>; // returns fm patches (id fields)
	sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null>; // full new note content; null = skip
}

export interface SpecDeps {
	http: HttpJsonFn;
	httpText: HttpTextFn;
	getKey(name: 'rawg' | 'comicvine'): string; // '' when unset
	log(msg: string): void;
	notify(msg: string): void;
}
```

```ts
// rss.ts
export interface FeedItem { title: string; date: string; id: string } // date ISO or ''
export function parseFeed(xml: string): FeedItem[];        // RSS 2.0 <item> + Atom <entry>, regex-based, entities decoded (&amp; &lt; &gt; &quot; &#39;), CDATA unwrapped
export function extractChapterNumber(title: string): number | null; // /(chapter|ch\.?|#)\s*(\d+(\.\d+)?)/i → parseFloat; null when no match
export function latestChapter(items: FeedItem[]): { chapter: number | null; date: string; title: string } | null; // items assumed newest-first; falls back to date ordering when parseable
```

- [ ] **Step 1: failing tests** — `tests/library-rss.test.ts`: RSS 2.0 sample (3 items, titles "Chainsaw Man Chapter 214" / "…Chapter 213.5" / "…Chapter 213", pubDate RFC822 → ISO date conversion via `new Date(x).toISOString().slice(0,10)` is ALLOWED here — parsing feed metadata, not vault data), Atom sample (`<entry><title>Ch. 12 — name</title><updated>2026-08-01T…</updated>`), CDATA title, entity-encoded title, numberless titles → `extractChapterNumber` null + `latestChapter` date-based, empty/garbage xml → `[]`. Chapter regex cases: "Chapter 214" 214, "ch.213.5" 213.5, "#77" 77, "Episode 5" null, "Vol. 3 Chapter 21" 21.
- [ ] **Step 2:** `bun run test` → fail (module not found)
- [ ] **Step 3:** implement `rss.ts` + `types.ts`
- [ ] **Step 4:** all gates green
- [ ] **Step 5:** commit `feat(library): core types + rss/atom chapter feed parser`

---

### Task 2: Manga spec (Jikan + MangaDex + RSS, flip rules)

**Files:**
- Create: `packages/obsidian/src/library/manga.ts`
- Create: `tests/fixtures/jikan-manga-csm.json` (realistic Jikan `/manga/{id}/full` payload for Chainsaw Man: mal_id 116778, title, title_english, authors[].name, genres[].name, status "Publishing", chapters null, volumes null, score 8.73, published.from/to ISO-ish, synopsis, images.jpg.large_image_url, url)
- Create: `tests/fixtures/mangadex-feed.json` (feed response: data[0].attributes {chapter:"214", readableAt:"2026-07-30T…"})
- Test: `tests/library-manga.test.ts`

**Canonical manga_item frontmatter order** (analog of watchlist renderNote — golden-test this):
`type: manga_item`, `title`, `eng_name`, `read_status`, `rating`, `rating_stars`, `last_read_chapter`, `latest_chapter`, `last_chapter_date`, `chapters`, `volumes`, `status`, `authors`, `genre`, `score`, `published_from`, `published_to`, `mal_id`, `mangadex_id`, `rss`, `poster`, `url`, `tags: [mangas, manga]`.
Body: `# Title`, `*eng_name*` opt, poster opt, meta line `**Manga** · status · score`, `**Read Status:** …` + `**Progress:** ch. {last_read_chapter} / {latest_chapter ?? chapters ?? '?'}` when last_read_chapter set, `## Synopsis`, `**Authors:** …`, `## Links` (MAL page + RSS feed link when set), custom sections, `## My Notes`.

**Behavior (test each):**
- buildManga(jikan, prev): field mapping incl score 1dp (8.73→8.7), eng_name logic (title_english ≠ title → eng_name), status passthrough (Publishing/Finished/On Hiatus).
- User fields preserved: read_status (default Unread), rating, rating_stars, last_read_chapter, rss, mangadex_id (kept if set even when resolve missed).
- Chapter source priority in `sync()`: rss field set → fetch feed via httpText → `latestChapter()`; else mangadex_id set → feed endpoint; else latest_chapter unchanged. New latest > stored (or numberless: new date > stored `last_chapter_date`) → update fields + flip `read_status Read → Unread` + `deps.notify('«title» ch. N out')`. Reading/Unread/Dropped never flipped.
- Finish-flip: prev status Publishing + new Finished + read_status Read → Unread.
- `isActive`: status Publishing/On Hiatus OR read_status Reading OR rss set OR mal_id empty/status empty (first pass). Finished + Read/Unread → static.
- Skeleton conversion: prev stock fm (`read: false`, `personalRating:`, empty canonical fields) → canonical defaults (read: 'true'→read_status Read, else Unread; personalRating n→rating n + stars emoji ×n).
- RSS fetch failure → log, proceed w/ mangadex/jikan (no throw).

- [ ] Steps: TDD (fixtures + tests → fail → implement → gates) → commit `feat(library): manga spec — jikan enrich, rss/mangadex chapter flip`

---

### Task 3: Book spec (Open Library, static)

**Files:** Create `packages/obsidian/src/library/book.ts`, `tests/fixtures/openlibrary-search.json` (docs[0] for 1984: key "/works/OL1168083W", author_name ["George Orwell"], first_publish_year 1949, number_of_pages_median 328, subject [...12+ entries], cover_i 12919016), test `tests/library-book.test.ts`.

**book_item fm order:** `type: book_item`, `title`, `read_status`, `rating`, `rating_stars`, `authors`, `year`, `pages`, `genre` (subjects capped 8), `olid`, `isbn` (preserve if prev had), `poster` (`https://covers.openlibrary.org/b/id/{cover_i}-L.jpg`), `url` (`https://openlibrary.org{key}`), `tags: [books, book]`. Body analog (meta line `**Book** · year · pages p.`). No automation; `isActive` = olid empty only (first pass); after that STATIC.
Skeleton conversion: `author`→authors, `read`→read_status, `personalRating`→rating/stars, goodreads `url` → kept as `## Links` entry "Goodreads".

- [ ] TDD → gates → commit `feat(library): book spec — open library`

---

### Task 4: Game spec (Steam primary, RAWG fallback)

**Files:** Create `packages/obsidian/src/library/game.ts`, fixtures `steam-appdetails.json` (792100: name "7 Billion Humans", developers, publishers, genres[].description, release_date {date:"2 Mar, 2018"}, metacritic{score:79}, header_image, short_description) + `rawg-game.json`, test `tests/library-game.test.ts`.

**game_item fm order:** `type: game_item`, `title`, `play_status`, `rating`, `rating_stars`, `developer`, `publisher`, `platforms`, `genre`, `release_date` (ISO — parse Steam "2 Mar, 2018"; month-name map, no locale dependence), `metacritic`, `steam_appid`, `rawg_id`, `poster`, `url`, `tags: [games, game]`.
- resolve: url regex appid → done; else Steam storesearch unique-exact; else RAWG search (needs key; keyless → log skip).
- enrich: steam_appid → appdetails (handle `success:false` → fall to RAWG if rawg_id/key); rawg_id → RAWG detail. Steam gives no platforms list → `platforms: [PC]` default when Steam-only.
- `played: true` skeleton → play_status Played, else Unplayed. `isActive` = ids empty (first pass) only.

- [ ] TDD → gates → commit `feat(library): game spec — steam + rawg`

---

### Task 5: Comic spec (Comic Vine + issue flip)

**Files:** Create `packages/obsidian/src/library/comic.ts`, fixture `comicvine-volume.json` (results: name "Absolute Batman", publisher.name "DC Comics", count_of_issues 10, last_issue {issue_number:"10", name}, start_year "2024", image.original_url, description "<p>…</p>", people[].name), test `tests/library-comic.test.ts`.

**comic_item fm order:** `type: comic_item`, `title`, `read_status`, `rating`, `rating_stars`, `last_read_issue`, `latest_issue`, `issues`, `status` (derived: within-90d rule needs a date — Comic Vine volume has no last-issue date; use `date_last_updated` when present, else keep prev status, default Ongoing), `publisher`, `people`, `start_year`, `comicvine_id`, `poster`, `url` (site_detail_url), `tags: [comics, comic]`.
- description HTML → plain text (strip tags, decode entities, first 2 paragraphs).
- Flip: read_status Read + new latest_issue (numeric compare of issue_number) > stored → Unread + notify.
- Comic Vine auth: `api_key` query param + `format=json`; check ComicVineAPI.ts for any required header quirks. 200 req/hr → throttleMs 350 fine at n=7.
- `isActive`: status Ongoing OR read_status Reading OR comicvine_id empty.

- [ ] TDD → gates → commit `feat(library): comic spec — comic vine + issue flip`

---

### Task 6: Generic library sync engine

**Files:** Create `packages/obsidian/src/library/LibraryEngine.ts`, test `tests/library-engine.test.ts`.

Copy `watchlist/SyncEngine.ts` shape exactly (deps: listNotes paths-only + readNote fresh-read, writeNote, sleep, log — see Phase 1 post-fix contract), parameterized by `MediaTypeSpec` + `SpecDeps`:

```ts
export interface LibraryEngineDeps {
	listNotes(): Promise<{ path: string }[]>;
	readNote(path: string): Promise<string>;
	writeNote(path: string, content: string): Promise<void>;
	sleep(ms: number): Promise<void>;
	log(msg: string): void;
	specDeps: SpecDeps;
}
export interface LibraryReport { scanned: number; synced: number; written: number; skippedNoId: number; skippedStatic: number; flipped: string[]; errors: { path: string; error: string }[] }
export async function libraryFolderSync(spec: MediaTypeSpec, deps: LibraryEngineDeps, opts: { full?: boolean; dryRun?: boolean }): Promise<LibraryReport>
export async function libraryFolderResolve(spec: MediaTypeSpec, deps: LibraryEngineDeps, opts: { dryRun?: boolean }): Promise<{ resolved: string[]; ambiguous: string[]; errors: { path: string; error: string }[] }>
```

Per note: fresh read → parse → `_`-prefix + non-entry skip (`type` present and ≠ spec.itemType and ≠ stock skeleton types `comicManga|book|game` → skip) → `spec.hasId`? no → skippedNoId : tier via `spec.isActive` (unless full) → `withRateLimitRetry(() => spec.sync(ctx, specDeps), sleep)` → diff-on-write → flip bookkeeping → throttle `spec.throttleMs`. Resolve variant mirrors Phase 1 `resolveMissingIds` w/ `spec.resolve` + patchFrontmatter (extract Phase 1's `patchFrontmatter` from WatchlistController into shared util both use — move, keep watchlist tests green).

Tests: engine w/ fake spec — tier skip, full override, diff-on-write skip, dryRun no-write, flip report, 429 retry (spec.sync throws TmdbRateLimitError once), error isolation, fresh-read mid-sync (Phase 1 test pattern), stock-skeleton note NOT skipped (converts), `type: folder_index` note skipped.

- [ ] TDD → gates → commit `feat(library): generic per-type sync engine + resolve`

---

### Task 7: Controller + settings + commands wiring

**Files:** Modify `packages/obsidian/src/settings/Settings.ts`, `packages/obsidian/src/main.ts`; Create `packages/obsidian/src/library/LibraryController.ts`; test `tests/library-controller.test.ts`.

Settings additions (interface + defaults + UI group "Library sync"): per type `{manga,book,game,comic}Enabled` (false) + `…Folder` (defaults `Mangas`/`Books`/`Games`/`Comics`) ; `RAWGLibKeyId`? — NO: reuse existing `RAWGAPIKeyId` + `ComicVineKeyId` secretStorage entries (stock settings already have them — verify names at Settings.ts L53-70; no new key fields).
`LibraryController` mirrors `WatchlistController`: makeHttp shared (extract/reuse), makeHttpText analog (obsidianFetch → `res.text()`), specDeps.getKey via secretStorage, syncType(spec, full, dryRun, quiet), resolveType(spec, dryRun), syncAll(full) iterating enabled specs, `syncing` guard SHARED with watchlist? — separate flag ok (different folders, no file overlap).
Scheduler: extend `maybeCatchUp` path — after watchlist sync, run `libraryController.syncAll(false, quiet=true)` for enabled types (same lastSync? separate `libraryLastSync` — yes separate, same interval setting).
Commands (each w/ `.catch(Notice)` pattern): per type `Sync {mangas|books|games|comics} now`, `Resolve {…} ids`, `Dry-run {…} full sync`; global `Sync all libraries`.

Tests: controller-level maybeCatchUp/guard analogs (fake plugin), getKey missing-key behavior (RAWG/CV absent → spec skip Notice, others run).

- [ ] TDD → gates → commit `feat(library): controller, settings, commands, scheduler`

---

### Task 8: Bases update + real-vault verification (user-gated)

No plugin code. Direct vault edits + protocol:

- [ ] Update 4 `.base` files (`Mangas/Mangas.base` etc.): filters → `type == "manga_item"` (etc., keep `file.inFolder`), properties/columns per spec (manga: file.name/read_status/last_read_chapter/latest_chapter/status/score/genre/authors; comics: file.name/read_status/last_read_issue/latest_issue/issues/status/publisher; books: file.name/read_status/authors/year/pages/rating; games: file.name/play_status/platforms/metacritic/release_date/developer). Keep existing views structure (YAML format per current files).
- [ ] User: paste RAWG + Comic Vine keys into settings (Comic Vine free acct; RAWG free key). Reload Obsidian.
- [ ] Resolve passes (dry-run first, then live): mangas (Jikan + MangaDex), games (url-parse covers 28/31), books, comics. Review ambiguous list → manual id paste where needed.
- [ ] Dry-run full sync all 4 types → review counts + console. STOP for user sign-off.
- [ ] `cd ~/Documents/ai_brain && git add -A && git commit -m "pre-phase2-sync snapshot"`.
- [ ] Live sync all types → `git diff` audit: user-field preservation greps (Phase 1 script pattern: `-## My Notes` count 0, `-## Collection` count 0, rating/stars loss 0), sample diffs per type reviewed by user.
- [ ] User sets `rss` field on actively-followed mangas → next sync verifies RSS flip path live.
- [ ] Commit vault + fork; update fork README feature list.

---

## Self-Review Notes
- Spec coverage: schemas (T2-5), engine+preservation (T6), resolve incl. Steam-url shortcut (T4/T6), settings/keys/commands/scheduler (T7), Bases + verification protocol (T8), RSS parser + priority chain (T1/T2). Books static ✓, no-automation games ✓.
- Deliberate deviations from spec doc: none. Open verify-points flagged in-task: Comic Vine header quirks (ComicVineAPI.ts), RAWG/ComicVine settings key names (Settings.ts), Steam appdetails success:false path.
- Type consistency: `MediaTypeSpec`/`SpecDeps` (T1) consumed T2-7; `LibraryEngineDeps`/`LibraryReport` (T6) consumed T7; patchFrontmatter extraction (T6) touches WatchlistController — its tests must stay green.
