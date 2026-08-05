# Media DB Sync

An Obsidian plugin that fills in media metadata, re-syncs it on a schedule, and flips a series back to `Unwatched` when a new episode airs. Fork of [Media DB](https://github.com/mProjectsCode/obsidian-media-db-plugin) by Moritz Jung.

The stock plugin writes a note once, at import time, and never touches it again. This fork adds the part that runs afterwards.

This is a complete plugin, not an add-on. The stock Media DB plugin does not need to be installed. See [Relationship to the Stock Plugin](#relationship-to-the-stock-plugin).

# Table of Contents

**Using the plugin**

- [What This Fork Adds](#what-this-fork-adds)
- [Relationship to the Stock Plugin](#relationship-to-the-stock-plugin)
- [Install](#install)
    - [Requirements](#requirements)
    - [Option A: BRAT](#option-a-brat)
    - [Option B: Copy the files in by hand](#option-b-copy-the-files-in-by-hand)
    - [Configure](#configure)
    - [First sync](#first-sync)
- [Commands](#commands)
- [Settings](#settings)
- [Watchlist Notes](#watchlist-notes)
    - [Frontmatter written on every sync](#frontmatter-written-on-every-sync)
    - [Fields the sync never overwrites](#fields-the-sync-never-overwrites)
    - [Which notes get synced](#which-notes-get-synced)
    - [The watch-status rule](#the-watch-status-rule)
    - [Anime detection](#anime-detection)
- [Library Types](#library-types)
- [Issues](#issues)
    - [TMDB API key not configured](#tmdb-api-key-not-configured)
    - [Watchlist sync already running](#watchlist-sync-already-running)
    - [Notes skipped for having no id](#notes-skipped-for-having-no-id)
    - [TMDB works in Obsidian but not from a script](#tmdb-works-in-obsidian-but-not-from-a-script)

**Building it yourself**

- [Build From Source](#build-from-source)
    - [Requirements](#requirements-1)
    - [1. Clone](#1-clone)
    - [2. Install Bun](#2-install-bun)
    - [3. Install dependencies](#3-install-dependencies)
    - [4. Build](#4-build)
- [Development](#development)
    - [Live build into a test vault](#live-build-into-a-test-vault)
    - [Tests and checks](#tests-and-checks)
    - [Why Bun](#why-bun)
    - [Pulling from upstream](#pulling-from-upstream)
- [Plugin Info](#plugin-info)
- [Related Articles](#related-articles)
- [License and Credit](#license-and-credit)

# What This Fork Adds

| Capability                                                                | Stock Media DB             | This fork                                           |
| ------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------- |
| Import a title from an API                                                | Yes                        | Yes, unchanged                                      |
| Re-sync an existing note later                                            | Manual, one note at a time | Scheduled, across the whole folder                  |
| `language`, `country`, `imdb_id`, `content_rating`, `trailer`, `homepage` | Left blank on TMDB imports | Filled                                              |
| `producer`                                                                | Writes `studio` instead    | Individual producers                                |
| Episode tracking                                                          | No                         | `last_episode`, `upcoming_episode`, `next_air_date` |
| Watch-status automation                                                   | No                         | `Watched` flips to `Unwatched` on a new episode     |
| Backfilling ids onto notes that predate the plugin                        | No                         | `Watchlist: resolve missing TMDB ids`               |
| Manga, book, game, comic upkeep                                           | Import only                | Scheduled sync per type                             |

# Relationship to the Stock Plugin

This fork carries the entire upstream plugin: all 16 API adapters, the search and ID modals, the ribbon icon, templates, and property mapping. Nothing in `src/` references the stock plugin, so it runs on its own.

It uses the plugin id `media-db-sync` rather than `obsidian-media-db`, which means it can also sit alongside the stock plugin without either one touching the other's folder or `data.json`. Two consequences if you are switching over:

| Thing                                                | What happens                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| API keys                                             | Not shared. Each plugin keeps its own keychain reference. Paste the key again here.                                                             |
| Settings: folders, templates, property mappings      | Not inherited. Set them again.                                                                                                                  |
| Notes the stock plugin already wrote                 | Read fine. Anything with a `tmdb_id` syncs straight away; the rest go through `Watchlist: resolve missing TMDB ids` or local canonical conversion. |

# Install

### Requirements

- Obsidian 1.12.0 or newer, desktop or mobile
- A TMDB API key or read access token, from [your TMDB API settings](https://www.themoviedb.org/settings/api)

RAWG and Comic Vine keys are needed only for the game and comic library types.

### Option A: BRAT

The plugin is not in Obsidian's community plugin browser, so [BRAT](https://github.com/TfTHacker/obsidian42-brat) is the way to install and keep it updated.

1. Install BRAT from the community plugin browser and enable it.
2. Run `BRAT: Add a beta plugin for testing`.
3. Enter `afiqzudinhadi/obsidian-media-db-sync`.
4. Leave "Enable after installing" checked.

Releases are cut as prereleases, and BRAT tracks the version in `manifest-beta.json`, so `BRAT: Check for updates to all beta plugins` picks up new builds.

### Option B: Copy the files in by hand

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/afiqzudinhadi/obsidian-media-db-sync/releases), or produce them yourself with [Build From Source](#build-from-source). Then:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/media-db-sync
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/media-db-sync/
```

The folder structure ends up as:

```
[vault]
|_ .obsidian
   |_ plugins
      |_ media-db-sync
         |_ main.js
         |_ manifest.json
         |_ styles.css
```

Reload Obsidian, then enable **Media DB Sync** under Settings, Community plugins.

### Configure

1. Paste the TMDB key into Settings, Media DB Sync.
2. Turn on **Enable watchlist sync** and point it at your folder.
3. Enable any library types you want, and set their folders.

### First sync

Run `Watchlist: dry-run full sync` and read the console output. It reports what it would change and writes nothing.

If the diff looks right, run `Watchlist: full sync`. If the vault is under git, commit it first.

# Commands

Inherited from upstream, unchanged:

| Command                                        |
| ---------------------------------------------- |
| Create entry                                   |
| Create entry (per media type)                  |
| Create entry (advanced search)                 |
| Create entry by id                             |
| Update open note (this will recreate the note) |
| Update metadata                                |
| Insert link                                    |

Added here:

| Command                                              | What it does                                          |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `Watchlist: sync now (airing/active only)`           | Syncs active notes only                               |
| `Watchlist: full sync (all entries)`                 | Syncs every note in the folder                        |
| `Watchlist: dry-run full sync (log only, no writes)` | Walks the full sync and logs the diff without writing |
| `Watchlist: resolve missing TMDB ids`                | Searches TMDB for notes that have no `tmdb_id`        |
| `Library: sync <type> now`                           | One type                                              |
| `Library: resolve <type> ids`                        | Backfills ids for one type                            |
| `Library: dry-run <type> full sync`                  | Log only                                              |
| `Library: sync all`                                  | Every enabled type                                    |

# Settings

Under **Watchlist sync**:

| Setting               | Default     | Notes            |
| --------------------- | ----------- | ---------------- |
| Enable watchlist sync | Off         |                  |
| Watchlist folder      | `Watchlist` |                  |
| Sync interval (hours) | `24`        | Accepts 1 to 168 |

Under **Library sync**, per type: an enable toggle and a folder path. All four types run on the watchlist's interval.

The scheduler is catch-up based rather than a wall-clock timer. On load it checks whether `lastSync + interval` is already in the past and runs if so, so a laptop that was asleep at the scheduled hour still syncs when it wakes.

API keys are held in the Obsidian keychain, not in `data.json`. TMDB takes either credential: a token starting with `eyJ` is sent as `Authorization: Bearer`, anything else is sent as `?api_key=`.

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

Each type is a separate folder with its own toggle.

| Type  | Default folder | Data sources                                                  | API key needed |
| ----- | -------------- | ------------------------------------------------------------- | -------------- |
| Manga | `Mangas`       | Jikan (MyAnimeList), AniList, MangaDex RSS for chapter counts | None           |
| Book  | `Books`        | Open Library                                                  | None           |
| Game  | `Games`        | Steam store, RAWG                                             | RAWG           |
| Comic | `Comics`       | Comic Vine                                                    | Comic Vine     |

When a resolve pass turns up several plausible matches for one note, it opens a picker instead of guessing. The picker offers `Never resolve (mark no_resolve)`; a note with `no_resolve: true` is skipped by every future resolve pass and left out of the "missing id" count.

Notes that resolve to nothing still get converted into the canonical shape locally, with no API calls, so they appear in Bases views rather than staying invisible.

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

---

Everything below is for building and modifying the plugin. Skip it if you only want to use it.

# Build From Source

### Requirements

- [Bun](https://bun.sh/) 1.x
- Git

### 1. Clone

```bash
git clone git@github.com:afiqzudinhadi/obsidian-media-db-sync.git
cd obsidian-media-db-sync
```

### 2. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 3. Install dependencies

```bash
bun install
```

### 4. Build

```bash
bun run build
```

Type-checks, then writes `main.js`, `manifest.json`, and `styles.css` into `dist/`. Those are the three files the [manual install](#option-b-copy-the-files-in-by-hand) step copies into a vault.

### Cutting a release

Pushing a tag triggers `.github/workflows/release.yml`, which builds and attaches those three files plus a zip to a GitHub release. A tag containing a hyphen is treated as a semver prerelease: it is published with the prerelease flag, and `manifest-beta.json` is shipped in place of `manifest.json` so the installed version matches the tag BRAT resolved.

```bash
git tag 0.1.0-beta.2
git push origin 0.1.0-beta.2
```

Bump the version in `manifest-beta.json` first, and keep it equal to the tag.

# Development

### Live build into a test vault

```bash
bun run dev
```

In development mode the output goes to `exampleVault/.obsidian/plugins/media-db-sync/` instead of `dist/`, and rebuilds on save.

### Tests and checks

```bash
bun test --preload ./tests/setup.ts     # or: bun run test
bun run check                            # format check, typecheck, lint at zero warnings, tests
```

`bun run test:log` adds the sync engine's log lines. The suite covers the serializer, YAML quoting, the diff-on-write path, the candidate picker loop, and the watch-status rule.

### Why Bun

The toolchain comes from upstream; the `scripts` block is unchanged from Moritz Jung's plugin. It matters in two different degrees:

- **Tests need Bun.** All 25 test files import from `bun:test`, and `tests/setup.ts` calls `mock.module('obsidian', ...)` to stub the Obsidian API, which has no runtime outside the app. Another runner means rewriting the imports and that mock layer.
- **The build does not, strictly.** It is `tsc` plus `vite`, both plain node tools; only the script string hardcodes `bun run tsc`. Note that `bun.lock` is the only committed lockfile, so `npm install` resolves fresh rather than reproducing the locked tree.

### Pulling from upstream

The upstream remote is kept:

```bash
git fetch upstream
```

# Plugin Info

| Property                 | Value                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Plugin ID                | `media-db-sync`                                                                                     |
| Display name             | Media DB Sync                                                                                       |
| Minimum Obsidian version | 1.12.0                                                                                              |
| Desktop only             | No, runs on mobile                                                                                  |
| License                  | GPL-3.0                                                                                             |
| Upstream                 | [mProjectsCode/obsidian-media-db-plugin](https://github.com/mProjectsCode/obsidian-media-db-plugin) |
| Toolchain                | Bun + Vite                                                                                          |
| Build output             | `dist/main.js`, `dist/manifest.json`, `dist/styles.css`                                             |
| Network calls            | Obsidian `requestUrl()` only, never node `fetch`                                                    |

# Related Articles

- [Upstream Media DB README](https://github.com/mProjectsCode/obsidian-media-db-plugin/blob/master/README.md), for the import features, templates, property mappings, and the per-API "search by ID" reference
- [TMDB API docs](https://developer.themoviedb.org/reference/intro/getting-started)
- [BRAT](https://github.com/TfTHacker/obsidian42-brat), for installing a plugin straight from a repo
- [Obsidian Bases](https://help.obsidian.md/bases), which is what the `watchlist_item` shape is written for

# License and Credit

GPL-3.0, inherited from upstream. The import pipeline, API adapters, modals, and property mapping are Moritz Jung's work: see [mProjectsCode/obsidian-media-db-plugin](https://github.com/mProjectsCode/obsidian-media-db-plugin). The sync engine, watchlist schema, library specs, and resolve flow are added in this fork.
