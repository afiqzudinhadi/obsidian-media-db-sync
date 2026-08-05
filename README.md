# Media DB Sync

An Obsidian plugin that fills in media metadata, re-syncs it on a schedule, and flips a series back to `Unwatched` when a new episode airs. Fork of [Media DB](https://github.com/mProjectsCode/obsidian-media-db-plugin) by Moritz Jung.

The stock plugin writes a note once, at import time, and never touches it again. This fork adds the part that runs afterwards.

# Table of Contents

- [Media DB Sync](#media-db-sync)
- [Table of Contents](#table-of-contents)
- [What This Fork Adds](#what-this-fork-adds)
- [Plugin Info](#plugin-info)
- [Watchlist Notes](#watchlist-notes)
    - [Frontmatter written on every sync](#frontmatter-written-on-every-sync)
    - [Fields the sync never overwrites](#fields-the-sync-never-overwrites)
    - [Which notes get synced](#which-notes-get-synced)
    - [The watch-status rule](#the-watch-status-rule)
    - [Anime detection](#anime-detection)
- [Library Types](#library-types)
- [Commands](#commands)
- [Settings](#settings)
- [Related Articles](#related-articles)
- [Pre-requisites](#pre-requisites)
- [Clone Repository](#clone-repository)
- [Set Up Build Environment](#set-up-build-environment)
    - [1. Install Bun](#1-install-bun)
    - [2. Install Dependencies](#2-install-dependencies)
    - [3. Build](#3-build)
    - [4. Run the Checks](#4-run-the-checks)
- [Install Into Obsidian](#install-into-obsidian)
    - [Option A: BRAT](#option-a-brat)
    - [Option B: Copy the Build](#option-b-copy-the-build)
    - [Configure](#configure)
- [Development](#development)
    - [Live Build Into a Test Vault](#live-build-into-a-test-vault)
    - [Tests](#tests)
- [Issues](#issues)
    - [TMDB API key not configured](#tmdb-api-key-not-configured)
    - [Watchlist sync already running](#watchlist-sync-already-running)
    - [Notes skipped for having no id](#notes-skipped-for-having-no-id)
    - [TMDB works in Obsidian but not from a script](#tmdb-works-in-obsidian-but-not-from-a-script)
- [License and Credit](#license-and-credit)

# What This Fork Adds

| Capability                                                                    | Stock Media DB                  | This fork                                        |
| ----------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| Import a title from an API                                                    | Yes                             | Yes, unchanged                                   |
| Re-sync an existing note later                                                | Manual, one note at a time      | Scheduled, across the whole folder               |
| `language`, `country`, `imdb_id`, `content_rating`, `trailer`, `homepage`     | Left blank on TMDB imports      | Filled                                           |
| `producer`                                                                    | Writes `studio` instead         | Individual producers                             |
| Episode tracking                                                              | No                              | `last_episode`, `upcoming_episode`, `next_air_date` |
| Watch-status automation                                                       | No                              | `Watched` flips to `Unwatched` on a new episode  |
| Backfilling ids onto notes that predate the plugin                            | No                              | `Watchlist: resolve missing TMDB ids`            |
| Manga, book, game, comic upkeep                                               | Import only                     | Scheduled sync per type                          |

# Plugin Info

| Property                  | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Plugin ID                 | `media-db-sync`                                                                           |
| Display name              | Media DB Sync                                                                             |
| Minimum Obsidian version  | 1.12.0                                                                                    |
| Desktop only              | No, runs on mobile                                                                        |
| License                   | GPL-3.0                                                                                   |
| Upstream                  | [mProjectsCode/obsidian-media-db-plugin](https://github.com/mProjectsCode/obsidian-media-db-plugin) |
| Toolchain                 | Bun + Vite                                                                                |
| Build output              | `dist/main.js`, `dist/manifest.json`, `dist/styles.css`                                   |
| Network calls             | Obsidian `requestUrl()` only, never node `fetch`                                          |

# Watchlist Notes

A watchlist note is one markdown file per title, carrying `type: watchlist_item` in its frontmatter. Everything the sync reads and writes lives in that frontmatter; the body holds the rendered sections.

### Frontmatter written on every sync

```
title            engName          media_type       category
watch_status     rating           rating_stars     year
runtime          seasons          episodes         vod
genre            status           language         country
director         writer           producer         content_rating
tmdb_rating      tmdb_id          imdb_id          release_date
last_air_date    next_air_date    last_episode     upcoming_episode
poster           trailer          homepage         imdb_page
notion_url       synopsis         cast
```

`media_type` is `Movie` or `TV Series`. `category` is `Movie`, `Series`, or `Anime`.

Body sections owned by the renderer: `## Synopsis`, `## Cast`, `## Links`, `## My Notes`.

### Fields the sync never overwrites

```
watch_status     kept, except for the episode rule below
rating           kept
rating_stars     kept
notion_url       kept
## My Notes      body text under this heading is carried across verbatim
```

A note with no `watch_status` yet starts at `Unwatched`.

### Which notes get synced

`Watchlist: sync now` skips anything inactive, so a daily run costs a handful of requests instead of one per note. A note counts as active when either of these holds:

```
status        is one of: Returning Series, In Production, Planned, Pilot
watch_status  is Watching
```

Everything else is only touched by `Watchlist: full sync`. Requests are spaced 250 ms apart by default.

### The watch-status rule

```
if media is a TV series
and watch_status == "Watched"
and TMDB's last_air_date is newer than the last_air_date stored in the note
then watch_status -> "Unwatched"
```

That is the whole rule. A movie you marked `Watched` stays `Watched`, because a movie has no `last_air_date` that can move.

### Anime detection

```
genre contains "Animation"  AND  language == "Japanese"   ->  category: Anime
otherwise, if it is a movie                               ->  category: Movie
otherwise                                                 ->  category: Series
```

This is why the blank `language` field on stock TMDB imports matters. Without it, every anime lands in `Series`.

# Library Types

Each type is a separate folder with its own toggle. All four run on the watchlist's sync interval.

| Type  | Default folder | Data sources                                                  | API key needed |
| ----- | -------------- | ------------------------------------------------------------- | -------------- |
| Manga | `Mangas`       | Jikan (MyAnimeList), AniList, MangaDex RSS for chapter counts | None           |
| Book  | `Books`        | Open Library                                                  | None           |
| Game  | `Games`        | Steam store, RAWG                                             | RAWG           |
| Comic | `Comics`       | Comic Vine                                                    | Comic Vine     |

When a resolve pass turns up several plausible matches for one note, it opens a picker instead of guessing. The picker offers `Never resolve (mark no_resolve)`; a note with `no_resolve: true` is skipped by every future resolve pass and left out of the "missing id" count.

Notes that resolve to nothing still get converted into the canonical shape locally, with no API calls, so they appear in Bases views rather than staying invisible.

# Commands

Inherited from upstream, unchanged:

| Command                                          |
| ------------------------------------------------ |
| Create entry                                     |
| Create entry (per media type)                    |
| Create entry (advanced search)                   |
| Create entry by id                               |
| Update open note (this will recreate the note)   |
| Update metadata                                  |
| Insert link                                      |

Added here:

| Command                                                | What it does                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `Watchlist: sync now (airing/active only)`             | Syncs active notes only                                         |
| `Watchlist: full sync (all entries)`                   | Syncs every note in the folder                                  |
| `Watchlist: dry-run full sync (log only, no writes)`   | Walks the full sync and logs the diff without writing           |
| `Watchlist: resolve missing TMDB ids`                  | Searches TMDB for notes that have no `tmdb_id`                  |
| `Library: sync <type> now`                             | One type                                                        |
| `Library: resolve <type> ids`                          | Backfills ids for one type                                      |
| `Library: dry-run <type> full sync`                    | Log only                                                        |
| `Library: sync all`                                    | Every enabled type                                              |

Run the dry-run against a real folder before the first live sync. If the vault is under git, commit it first.

# Settings

Under **Watchlist sync**:

| Setting                | Default     | Notes            |
| ---------------------- | ----------- | ---------------- |
| Enable watchlist sync  | Off         |                  |
| Watchlist folder       | `Watchlist` |                  |
| Sync interval (hours)  | `24`        | Accepts 1 to 168 |

Under **Library sync**, per type: an enable toggle and a folder path.

The scheduler is catch-up based rather than a wall-clock timer. On load it checks whether `lastSync + interval` is already in the past and runs if so, so a laptop that was asleep at the scheduled hour still syncs when it wakes.

API keys are held in the Obsidian keychain, not in `data.json`. TMDB takes either credential: a token starting with `eyJ` is sent as `Authorization: Bearer`, anything else is sent as `?api_key=`.

# Related Articles

- [Upstream Media DB README](https://github.com/mProjectsCode/obsidian-media-db-plugin/blob/master/README.md), for the import features, templates, property mappings, and the per-API "search by ID" reference
- [TMDB API docs](https://developer.themoviedb.org/reference/intro/getting-started)
- [BRAT](https://github.com/TfTHacker/obsidian42-brat), for installing a plugin straight from a repo
- [Obsidian Bases](https://help.obsidian.md/bases), which is what the `watchlist_item` shape is written for

# Pre-requisites

- Obsidian 1.12.0 or newer
- A TMDB API key or read access token, from [your TMDB API settings](https://www.themoviedb.org/settings/api)
- [Bun](https://bun.sh/) 1.x, if you are building from source
- Git

# Clone Repository

```bash
git clone git@github.com:afiqzudinhadi/obsidian-media-db-sync.git
cd obsidian-media-db-sync
```

The upstream remote is kept, so changes from Moritz Jung's plugin can be pulled in:

```bash
git fetch upstream
```

# Set Up Build Environment

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

This project uses Bun and Vite. It does not use npm or esbuild; older notes that say otherwise are stale.

### 2. Install Dependencies

```bash
bun install
```

### 3. Build

```bash
bun run build
```

Type-checks first, then writes `main.js`, `manifest.json`, and `styles.css` into `dist/`.

### 4. Run the Checks

```bash
bun run check
```

Formatter check, both type-check passes, ESLint at zero warnings, then the test suite.

# Install Into Obsidian

### Option A: BRAT

Install BRAT, then add `afiqzudinhadi/obsidian-media-db-sync` as a beta plugin. BRAT reads `manifest-beta.json` and updates from releases.

### Option B: Copy the Build

```bash
mkdir -p /path/to/vault/.obsidian/plugins/media-db-sync
cp dist/main.js dist/manifest.json dist/styles.css /path/to/vault/.obsidian/plugins/media-db-sync/
```

Reload Obsidian, then enable **Media DB Sync** under Settings, Community plugins.

The plugin id is `media-db-sync`, not `obsidian-media-db`, so this installs alongside the stock plugin and neither one overwrites the other's folder or `data.json`.

### Configure

1. Paste the TMDB key into Settings, Media DB Sync.
2. Turn on **Enable watchlist sync** and set the folder.
3. Run `Watchlist: dry-run full sync` and read the console output.
4. If the diff looks right, run `Watchlist: full sync`.

# Development

### Live Build Into a Test Vault

```bash
bun run dev
```

In development mode the output goes to `exampleVault/.obsidian/plugins/media-db-sync/` instead of `dist/`, and rebuilds on save.

### Tests

```bash
bun test --preload ./tests/setup.ts
```

Use `bun run test:log` to see the sync engine's log lines. The suite covers the serializer, YAML quoting, the diff-on-write path, the candidate picker loop, and the watch-status rule.

# Issues

### TMDB API key not configured

```
TMDB API key not configured (Media DB Sync settings).
```

The key sits in the Obsidian keychain, not in `data.json`, so it does not travel with a synced vault. Enter it again on each device.

### Watchlist sync already running

```
Watchlist sync already running
```

A sync is in progress. Both a manual command and the scheduler can start one, and the second caller is turned away rather than allowed to write over the first. Wait for it to finish. The library sync reports the same way with `Library sync already running`.

### Notes skipped for having no id

The sync report counts notes it could not act on because they carry no `tmdb_id`. Anything imported before this plugin existed will be in that group. Run `Watchlist: resolve missing TMDB ids`, then sync again. Notes marked `no_resolve: true` are deliberate opt-outs and are excluded from the count.

### TMDB works in Obsidian but not from a script

```
nodename nor servname provided, or not known
```

Some ISP DNS resolvers return nothing for TMDB's API host, which breaks `curl` and any Python or Node script on that connection. Obsidian's `requestUrl()` goes through Chromium's network stack and resolves it fine. That is why every network call here goes through `requestUrl()`, and why an external cron script is not a working substitute on such a connection.

# License and Credit

GPL-3.0, inherited from upstream. The import pipeline, API adapters, modals, and property mapping are Moritz Jung's work: see [mProjectsCode/obsidian-media-db-plugin](https://github.com/mProjectsCode/obsidian-media-db-plugin). The sync engine, watchlist schema, library specs, and resolve flow are added in this fork.
