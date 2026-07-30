import { Notice, TFile, TFolder } from 'obsidian';
import type MediaDbPlugin from 'packages/obsidian/src/main';
import { syncFolder, TmdbRateLimitError, type SyncDeps, type SyncReport } from 'packages/obsidian/src/watchlist/SyncEngine';
import { fetchDetail } from 'packages/obsidian/src/watchlist/tmdb';
import { obsidianFetch } from 'packages/obsidian/src/utils/Utils';

export class WatchlistController {
	constructor(private plugin: MediaDbPlugin) {}

	private getKey(): string {
		const keyId = this.plugin.settings.TMDBKeyId;
		const key = keyId ? this.plugin.app.secretStorage.getSecret(keyId) : null;
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
					const res = await obsidianFetch(new Request(url, { headers }));
					if (res.status === 429) {
						const err = new TmdbRateLimitError('TMDB 429');
						const ra = Number(res.headers.get('retry-after') ?? 2);
						err.retryAfterMs = ra * 1000;
						throw err;
					}
					if (res.status !== 200) throw new Error(`TMDB ${res.status} for ${url}`);
					return await res.json();
				};
				return await fetchDetail(http, key, tmdbId, isMovie);
			},
			sleep: ms => new Promise(r => setTimeout(r, ms)),
			log: msg => console.log(`[media-db-sync] ${msg}`),
		};
	}

	async syncNow(full: boolean, dryRun = false): Promise<SyncReport> {
		const key = this.getKey();
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
