import { Notice, TFile, TFolder } from 'obsidian';
import type MediaDbPlugin from 'packages/obsidian/src/main';
import { syncFolder, withRateLimitRetry, TmdbRateLimitError, type SyncDeps, type SyncReport } from 'packages/obsidian/src/watchlist/SyncEngine';
import { fetchDetail, searchTitle, type HttpJsonFn } from 'packages/obsidian/src/watchlist/tmdb';
import { obsidianFetch } from 'packages/obsidian/src/utils/Utils';
import { parseNote, noteTmdbRef, stripQuotes } from 'packages/obsidian/src/watchlist/parse';
import { resolveNote } from 'packages/obsidian/src/watchlist/resolve';

export interface ResolveReport {
	scanned: number;
	resolved: number;
	ambiguous: number;
	errors: { path: string; error: string }[];
}

function patchFrontmatter(content: string, tmdbId: string, mediaType: string): string {
	const insert = `tmdb_id: ${tmdbId}\nmedia_type: ${mediaType}`;
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (fmMatch) {
		const inner = fmMatch[1];
		const typeLine = /^type:.*$/m.exec(inner);
		const newInner = typeLine ? inner.slice(0, typeLine.index + typeLine[0].length) + '\n' + insert + inner.slice(typeLine.index + typeLine[0].length) : insert + '\n' + inner;
		return content.slice(0, fmMatch.index) + '---\n' + newInner + '\n---' + content.slice(fmMatch.index + fmMatch[0].length);
	}
	return `---\ntype: watchlist_item\n${insert}\n---\n\n` + content;
}

export function shouldNotifySync(quiet: boolean, written: number, errorCount: number): boolean {
	return !quiet || written > 0 || errorCount > 0;
}

export class WatchlistController {
	private syncing = false;

	constructor(private plugin: MediaDbPlugin) {}

	private getKey(): string {
		const keyId = this.plugin.settings.TMDBKeyId;
		const key = keyId ? this.plugin.app.secretStorage.getSecret(keyId) : null;
		if (!key) throw new Error('TMDB API key not configured (Media DB Sync settings).');
		return key;
	}

	private makeHttp(): HttpJsonFn {
		return async (url: string, headers: Record<string, string>): Promise<any> => {
			const res = await obsidianFetch(new Request(url, { headers }));
			if (res.status === 429) {
				const err = new TmdbRateLimitError('TMDB 429');
				const ra = Number(res.headers.get('retry-after'));
				err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000;
				throw err;
			}
			if (res.status !== 200) throw new Error(`TMDB ${res.status} for ${url}`);
			return await res.json();
		};
	}

	private makeDeps(key: string): SyncDeps {
		const { app } = this.plugin;
		const folder = app.vault.getAbstractFileByPath(this.plugin.settings.watchlistFolder);
		const http = this.makeHttp();
		return {
			listNotes: async () => {
				if (!(folder instanceof TFolder)) throw new Error(`Watchlist folder not found: ${this.plugin.settings.watchlistFolder}`);
				const files = folder.children.filter((f): f is TFile => f instanceof TFile && f.extension === 'md' && !f.name.startsWith('_'));
				return files.map(f => ({ path: f.path }));
			},
			readNote: async path => {
				const f = app.vault.getAbstractFileByPath(path);
				if (!(f instanceof TFile)) throw new Error(`Watchlist note not found: ${path}`);
				return await app.vault.read(f);
			},
			writeNote: async (path, content) => {
				const f = app.vault.getAbstractFileByPath(path);
				if (f instanceof TFile) await app.vault.modify(f, content);
			},
			fetchDetail: async (tmdbId, isMovie) => await fetchDetail(http, key, tmdbId, isMovie),
			sleep: ms => new Promise(r => setTimeout(r, ms)),
			log: msg => console.log(`[media-db-sync] ${msg}`),
		};
	}

	async syncNow(full: boolean, dryRun = false, quiet = false): Promise<SyncReport> {
		if (this.syncing) {
			new Notice('Watchlist sync already running');
			return { scanned: 0, synced: 0, written: 0, skippedNoId: 0, skippedStatic: 0, flipped: [], errors: [] };
		}
		this.syncing = true;
		try {
			const key = this.getKey();
			const report = await syncFolder(this.makeDeps(key), { full, dryRun });
			const mode = dryRun ? 'DRY-RUN ' : '';
			if (shouldNotifySync(quiet, report.written, report.errors.length)) {
				new Notice(
					`Watchlist ${mode}sync: ${report.synced} checked, ${report.written} updated, ${report.flipped.length} flipped to Unwatched` +
						(report.errors.length ? `, ${report.errors.length} errors (see console)` : ''),
				);
			}
			if (!dryRun) {
				this.plugin.settings.watchlistLastSync = Date.now();
				await this.plugin.saveSettings();
			}
			return report;
		} finally {
			this.syncing = false;
		}
	}

	async maybeCatchUp(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.watchlistEnabled) return;
		const due = s.watchlistLastSync + s.watchlistSyncIntervalHours * 3600_000;
		if (Date.now() >= due) {
			await this.syncNow(false, false, true).catch(e => console.error('[media-db-sync] scheduled sync failed', e));
		}
	}

	async resolveMissingIds(dryRun = false): Promise<ResolveReport> {
		if (this.syncing) {
			new Notice('Watchlist sync already running');
			return { scanned: 0, resolved: 0, ambiguous: 0, errors: [] };
		}
		this.syncing = true;
		try {
			const key = this.getKey();
			const deps = this.makeDeps(key);
			const http = this.makeHttp();
			const search = (q: string, isMovie: boolean, year?: string) => searchTitle(http, key, q, isMovie, year);

			const report: ResolveReport = { scanned: 0, resolved: 0, ambiguous: 0, errors: [] };
			const notes = await deps.listNotes();
			for (const note of notes) {
				const content = await deps.readNote(note.path);
				const { frontmatter } = parseNote(content);
				if (noteTmdbRef(frontmatter)) continue;
				const type = stripQuotes(frontmatter['type']);
				if (type && type !== 'watchlist_item') continue; // skip type: list dashboards etc.
				report.scanned++;
				try {
					const filename = note.path.split('/').pop() ?? note.path;
					const result = await withRateLimitRetry(() => resolveNote(frontmatter, filename, search), deps.sleep);
					if (!result) {
						report.ambiguous++;
						deps.log(`ambiguous/no match: ${note.path}`);
					} else {
						report.resolved++;
						const mediaType = result.isMovie ? 'Movie' : 'TV Series';
						deps.log(`${dryRun ? '[dry] ' : ''}resolved ${note.path} -> tmdb_id ${result.tmdbId} (${result.matchedTitle})`);
						if (!dryRun) await deps.writeNote(note.path, patchFrontmatter(content, result.tmdbId, mediaType));
					}
					await deps.sleep(250);
				} catch (e) {
					report.errors.push({ path: note.path, error: e instanceof Error ? e.message : String(e) });
					deps.log(`ERROR ${note.path}: ${String(e)}`);
				}
			}
			const mode = dryRun ? 'DRY-RUN ' : '';
			new Notice(
				`Watchlist ${mode}resolve: ${report.scanned} scanned, ${report.resolved} resolved, ${report.ambiguous} ambiguous/no match` +
					(report.errors.length ? `, ${report.errors.length} errors (see console)` : ''),
			);
			return report;
		} finally {
			this.syncing = false;
		}
	}
}
