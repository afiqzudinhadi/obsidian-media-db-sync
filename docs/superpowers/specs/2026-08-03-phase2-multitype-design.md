# Phase 2 — Manga / Books / Games / Comics Design

Approved 2026-08-03. Extends the watchlist suite (Phase 1, shipped) to four more media types using the same canonical-schema + sync-engine pattern.

## Context

Vault folders exist (migrated 2026-08-02, stock Media DB skeleton frontmatter, `dataSource: manual`, empty `id`):
- `02 - Areas/Interests/Mangas/` — 25 entries
- `02 - Areas/Interests/Books/` — 14 entries
- `02 - Areas/Interests/Games/` — 31 entries
- `02 - Areas/Interests/Comics/` — 7 entries

Each folder has `_index.md` (+ some `_Misc.md`) — `_`-prefixed, skipped by engine. Entries carry `## Collection` (`Part of [[Mangas]]` etc.) and `## My Notes` — both survive sync via Phase 1's custom-section preservation. No `.base` views yet for these types.

## Decisions (user-approved)

1. **Canonical per-type schemas** (Watchlist pattern), NOT stock Media DB fields. Existing skeleton entries convert on first sync.
2. **Manga chapter tracking**: user-owned `read_status` + `last_read_chapter`; automated `latest_chapter` detection with source priority **RSS (per-note feed URL) → MangaDex → Jikan finish-flip**; Read→Unread flip + Notice on new chapter.
3. **Games**: Steam first (no key), RAWG fallback (free key) for non-Steam titles.
4. **Comics**: Comic Vine (free key) + issue-flip automation (`latest_issue`, `last_read_issue`).
5. **Books**: Open Library, metadata refresh only — no automation.

## Schemas

Common to all four (mirrors watchlist conventions): `type: {manga|book|game|comic}_item`; user-owned preserved on every write: `rating`, `rating_stars`, status field (below), progress fields (below), `rss`, body `## My Notes` + `## Collection` + any custom `##` section; `tags: [<plural>, <type>]`; ISO string dates; `poster` (cover URL); `synopsis` in body render like watchlist (`# Title`, meta line, status lines, `## Synopsis`, type-specific crew/detail lines, `## Links`, custom sections, `## My Notes`).

### manga_item
| Field | Source | Notes |
|---|---|---|
| `mal_id` | resolve/Jikan | sync key |
| `mangadex_id` | resolve/MangaDex | chapter feed key; blank if unmatched |
| `rss` | **user** | optional feed URL, top chapter source |
| `title`, `eng_name` | Jikan | eng_name logic like watchlist |
| `authors` | Jikan | comma-joined |
| `genre` | Jikan | list |
| `status` | Jikan | Publishing / Finished / On Hiatus |
| `chapters`, `volumes` | Jikan | totals; null while Publishing |
| `score` | Jikan | 1dp (analog of tmdb_rating) |
| `published_from`, `published_to` | Jikan | ISO |
| `read_status` | **user** | Reading / Read / Unread / Dropped |
| `last_read_chapter` | **user** | number, manual |
| `latest_chapter` | RSS/MangaDex | number or null |
| `last_chapter_date` | RSS/MangaDex | ISO |
| `poster`, `synopsis`, `url` (MAL page) | Jikan | |

**Flip rule (manga)**: `read_status == 'Read'` AND new `latest_chapter` > stored `latest_chapter` (or new item date > stored `last_chapter_date` when numberless) → `read_status: Unread` + Notice naming title + chapter. Also finish-flip: status Publishing→Finished while Read → Unread.

### comic_item
`comicvine_id` (sync key), `title`, `publisher`, `people` (comma-joined writers/artists; no genre field — Comic Vine has none reliable), `issues` (count_of_issues), `latest_issue` (last issue number), `last_issue_date` (ISO), `start_year`, `status` (derived: last issue within 90d → Ongoing, else Concluded — Comic Vine has no status field), `read_status` (**user**), `last_read_issue` (**user**), `poster`, `synopsis`, `url` (site_detail_url).
**Flip rule**: Read + new `latest_issue` > stored → Unread + Notice.

### book_item
`olid` (sync key; `isbn` kept if present), `title`, `authors`, `year` (first_publish_year), `pages`, `genre` (subjects, capped 8), `read_status` (**user**), `poster` (cover), `synopsis` (description when available), `url` (OL page). No automation.

### game_item
`steam_appid` and/or `rawg_id` (either is sync key; steam preferred), `title`, `developer`, `publisher`, `platforms` (list), `genre` (list), `release_date` (ISO), `metacritic` (int/null), `play_status` (**user**: Playing / Played / Unplayed / Dropped), `poster`, `synopsis`, `url` (store/RAWG page). No automation.

## Architecture

Generalize Phase 1 engine — Watchlist code untouched, no behavior change:
- `src/watchlist/` stays as-is (movie/tv).
- New `packages/obsidian/src/library/` module: `MediaTypeSpec` interface = `{ typeName, folderSettingKey, idFields, resolve(fm, filename, http): id | null, fetch(http, ids): raw, build(raw, prev): record, render(record, myNotes, customSections): string, isActive(fm): boolean, flipRule(prev, record): record }`. One spec file per type (`manga.ts`, `book.ts`, `game.ts`, `comic.ts`) + shared `rss.ts` (RSS/Atom parse + chapter-number regex `(chapter|ch\.?|#)\s*(\d+(\.\d+)?)/i`).
- Generic `LibrarySyncEngine` = Phase 1 `syncFolder` parameterized by spec (reuses `withRateLimitRetry`, diff-on-write, custom-section preservation, throttle; per-spec throttleMs — Jikan 350ms, Comic Vine 350ms, MangaDex 250ms).
- Tier: manga/comic ACTIVE when status Publishing/Ongoing or read_status Reading or rss set; books/games STATIC (full sync only) after first enrich (missing per-type id or empty `status`-analog → ACTIVE for first pass).
- Adapters: reuse upstream MALAPIManga (Jikan), OpenLibraryAPI, SteamAPI, RAWGAPI, ComicVineAPI request patterns where practical — but Phase 2 fetchers live in library specs w/ injected `HttpJsonFn` like watchlist/tmdb.ts (upstream adapters return their models, we need raw JSON + append params; copying the URL/auth conventions is enough). MangaDex + RSS = new fetchers.
- Settings: per-type enable + folder (defaults `Mangas`/`Books`/`Games`/`Comics`; user sets real vault paths like `02 - Areas/Interests/Mangas`) + RAWG/ComicVine key fields (secretStorage, same pattern as TMDB). Sync interval shared w/ watchlist scheduler; catch-up loop iterates all enabled types.
- Commands: per-type `sync now` / `resolve missing ids` + `dry-run full sync`; global `Sync all libraries`.

## Resolve pass (first run, ~77 entries)
Per-type resolve cmd: title (+`year` hint where present) → search API → unique-exact-match rule (Phase 1 semantics: 1 exact → accept; 0 exact + sole → accept; else log ambiguous). Games: Steam search miss → RAWG search. Manga: Jikan resolve → then MangaDex search by title for `mangadex_id` (best-effort; miss = blank, log). Writes id fields into frontmatter (patchFrontmatter pattern); enrichment happens on next sync (missing status → ACTIVE tier).

## Bases
Generate 4 `.base` files in `02 - Areas/Interests/`: filter `type == '<x>_item'` + folder; columns per type (manga: title/read_status/last_read_chapter/latest_chapter/status/score; comics: analog w/ issues; books: title/read_status/authors/year/pages; games: title/play_status/platforms/metacritic/release_date). Modeled on existing `Watchlist.base` file format (read it during implementation).

## Rate limits
Jikan 3 req/s (no key), MangaDex ~5 req/s (no key), Comic Vine 200 req/hr (7 comics — fine), Open Library lenient, Steam lenient, RAWG 20k/mo free. Per-spec throttle + existing 429 retry covers all.

## Error/edge policy
- Missing key (RAWG/Comic Vine) → per-type sync skips w/ one Notice, other types proceed.
- RSS fetch failure → log, fall back to MangaDex that pass.
- MangaDex title-match ambiguity → blank mangadex_id + log (user can paste id manually).
- Numberless RSS titles → date-based new-item detection, `latest_chapter` stays null.
- Skeleton→canonical conversion: first sync maps stock fields (`read`→read_status Read/Unread, `personalRating`→rating, existing url→kept in body Links) then rewrites canonical; dry-run first against real vault, git snapshot before live (same protocol as Phase 1).

## Out of scope
Watchlist changes, per-episode TV crew (Phase 3), push notifications outside Obsidian, BGG/IGDB/VNDB adapters, community-plugin submission.

## Verification protocol (mirrors Phase 1)
Gates: `bun run test` / `bun run typecheck` / `bun run build` every task. Golden fixtures per type from real vault notes. Final: resolve pass → dry-run vs real folders (77 entries) → user reviews counts + sample diffs → git snapshot → live → `git diff` audit (user-field preservation checks scripted as in Phase 1).
