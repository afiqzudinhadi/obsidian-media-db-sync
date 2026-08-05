import { Notice, TFile, TFolder } from 'obsidian';
import { bookSpec } from 'packages/obsidian/src/library/book';
import { CandidatePickerModal } from 'packages/obsidian/src/library/CandidatePickerModal';
import { comicSpec } from 'packages/obsidian/src/library/comic';
import { gameSpec } from 'packages/obsidian/src/library/game';
import { libraryFolderResolve, libraryFolderSync, type LibraryEngineDeps, type LibraryReport, type LibraryResolveReport } from 'packages/obsidian/src/library/LibraryEngine';
import { mangaSpec } from 'packages/obsidian/src/library/manga';
import type { HttpJsonFn, HttpPostJsonFn, HttpTextFn, MediaTypeSpec, ResolveCandidate, SpecDeps } from 'packages/obsidian/src/library/types';
import type MediaDbPlugin from 'packages/obsidian/src/main';
import { obsidianFetch } from 'packages/obsidian/src/utils/Utils';
import { patchFrontmatter } from 'packages/obsidian/src/watchlist/patchFrontmatter';
import { TmdbRateLimitError } from 'packages/obsidian/src/watchlist/SyncEngine';
import { shouldNotifySync } from 'packages/obsidian/src/watchlist/WatchlistController';

/** Type <-> command-slug map, used by main.ts to register per-type commands and by the controller to iterate specs. */
export const LIBRARY_TYPES: readonly { spec: MediaTypeSpec; slug: string }[] = [
	{ spec: mangaSpec, slug: 'mangas' },
	{ spec: bookSpec, slug: 'books' },
	{ spec: gameSpec, slug: 'games' },
	{ spec: comicSpec, slug: 'comics' },
];

/** Specs whose enrichment needs a secretStorage-held API key (jikan/mangadex/openlibrary/rss/steam are keyless). */
const KEY_REQUIREMENT: Partial<Record<MediaTypeSpec['typeName'], 'rawg' | 'comicvine'>> = {
	game: 'rawg',
	comic: 'comicvine',
};

const KEY_LABEL: Record<'rawg' | 'comicvine', string> = {
	rawg: 'RAWG',
	comicvine: 'Comic Vine',
};

function emptyReport(): LibraryReport {
	return { scanned: 0, synced: 0, written: 0, skippedNoId: 0, skippedStatic: 0, skippedNoData: 0, flipped: [], errors: [] };
}

function emptyResolveReport(): LibraryResolveReport {
	return { resolved: [], ambiguous: [], needsChoice: [], skippedNoResolve: 0, errors: [] };
}

export class LibraryController {
	private syncing = false;
	private specs: MediaTypeSpec[] = LIBRARY_TYPES.map(t => t.spec);

	constructor(private plugin: MediaDbPlugin) {}

	private notify(msg: string, timeout?: number): void {
		new Notice(msg, timeout);
	}

	private getKey(name: 'rawg' | 'comicvine'): string {
		const keyId = name === 'rawg' ? this.plugin.settings.RAWGAPIKeyId : this.plugin.settings.ComicVineKeyId;
		const key = keyId ? this.plugin.app.secretStorage.getSecret(keyId) : null;
		return key ?? '';
	}

	private folderFor(spec: MediaTypeSpec): string {
		return (this.plugin.settings as unknown as Record<string, string>)[spec.folderSettingKey];
	}

	private enabledFor(spec: MediaTypeSpec): boolean {
		return (this.plugin.settings as unknown as Record<string, boolean>)[spec.enabledSettingKey];
	}

	// Duplicated (not extracted) from WatchlistController.makeHttp -- watchlist code stays untouched per plan.
	// Kept minimal + generic (no TMDB-specific wording) since it's shared across all library APIs.
	private makeHttp(): HttpJsonFn {
		return async (url: string, headers: Record<string, string>): Promise<any> => {
			const res = await obsidianFetch(new Request(url, { headers }));
			if (res.status === 429) {
				const err = new TmdbRateLimitError(`Library API 429 for ${url}`);
				const ra = Number(res.headers.get('retry-after'));
				err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000;
				throw err;
			}
			if (res.status !== 200) throw new Error(`Library API ${res.status} for ${url}`);
			return await res.json();
		};
	}

	private makeHttpText(): HttpTextFn {
		return async (url: string, headers: Record<string, string>): Promise<string> => {
			const res = await obsidianFetch(new Request(url, { headers }));
			if (res.status === 429) {
				const err = new TmdbRateLimitError(`Library API 429 for ${url}`);
				const ra = Number(res.headers.get('retry-after'));
				err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000;
				throw err;
			}
			if (res.status !== 200) throw new Error(`Library API ${res.status} for ${url}`);
			return await res.text();
		};
	}

	// POST-JSON counterpart of makeHttp -- needed for GraphQL APIs (AniList) that require a
	// POST body instead of query-string params. Same 429/error handling as makeHttp.
	private makeHttpPostJson(): HttpPostJsonFn {
		return async (url: string, body: unknown, headers: Record<string, string>): Promise<any> => {
			const res = await obsidianFetch(
				new Request(url, {
					method: 'POST',
					body: JSON.stringify(body),
					headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
				}),
			);
			if (res.status === 429) {
				const err = new TmdbRateLimitError(`Library API 429 for ${url}`);
				const ra = Number(res.headers.get('retry-after'));
				err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000;
				throw err;
			}
			if (res.status !== 200) throw new Error(`Library API ${res.status} for ${url}`);
			return await res.json();
		};
	}

	/** dryRun=true routes flip notifications to the log instead of a real Notice -- a dry-run
	 * preview shouldn't pop user-facing notices for changes that were never actually written. */
	private makeSpecDeps(dryRun = false): SpecDeps {
		return {
			http: this.makeHttp(),
			httpText: this.makeHttpText(),
			httpPostJson: this.makeHttpPostJson(),
			getKey: name => this.getKey(name),
			log: msg => console.log(`[media-db-library] ${msg}`),
			notify: msg => {
				if (dryRun) {
					console.log(`[media-db-library] [dry] ${msg}`);
				} else {
					this.notify(msg);
				}
			},
		};
	}

	private makeDeps(spec: MediaTypeSpec, dryRun = false): LibraryEngineDeps {
		const { app } = this.plugin;
		const folderPath = this.folderFor(spec);
		const folder = app.vault.getAbstractFileByPath(folderPath);
		return {
			listNotes: async () => {
				if (!(folder instanceof TFolder)) throw new Error(`Library folder not found: ${folderPath}`);
				const files = folder.children.filter((f): f is TFile => f instanceof TFile && f.extension === 'md' && !f.name.startsWith('_'));
				return files.map(f => ({ path: f.path }));
			},
			readNote: async path => {
				const f = app.vault.getAbstractFileByPath(path);
				if (!(f instanceof TFile)) throw new Error(`Library note not found: ${path}`);
				return await app.vault.read(f);
			},
			writeNote: async (path, content) => {
				const f = app.vault.getAbstractFileByPath(path);
				if (f instanceof TFile) await app.vault.modify(f, content);
			},
			sleep: ms => new Promise(r => setTimeout(r, ms)),
			log: msg => console.log(`[media-db-library] ${msg}`),
			specDeps: this.makeSpecDeps(dryRun),
		};
	}

	/** Per-note key skipping already happens inside the spec (log+skip); this only surfaces one Notice per sync run naming the affected type. */
	private warnMissingKey(spec: MediaTypeSpec, quiet: boolean): void {
		const req = KEY_REQUIREMENT[spec.typeName];
		if (!req || this.getKey(req)) return;
		const msg = `Library sync: ${KEY_LABEL[req]} API key not configured — ${spec.typeName} enrichment skipped (Media DB Sync settings).`;
		if (quiet) {
			console.log(`[media-db-library] ${msg}`);
		} else {
			this.notify(msg, 0);
		}
	}

	/** Surfaces every counter, not just synced/written/flipped -- a run where fetches are
	 * silently failing (e.g. Comic Vine error envelope) must not read as an empty-but-clean
	 * success just because skippedNoData/errors were left out of the message. */
	private buildSyncSummary(spec: MediaTypeSpec, mode: string, report: LibraryReport): string {
		let msg = `Library ${mode}sync (${spec.typeName}): ${report.scanned} scanned, ${report.synced} ok, ${report.written} updated, ${report.flipped.length} flipped`;
		if (report.skippedStatic) msg += `, ${report.skippedStatic} static`;
		if (report.skippedNoId) msg += `, ${report.skippedNoId} no-id`;
		if (report.skippedNoData) msg += `, ${report.skippedNoData} no-data (see console)`;
		if (report.errors.length) msg += `, ${report.errors.length} errors (see console)`;
		return msg;
	}

	private async runSync(spec: MediaTypeSpec, full: boolean, dryRun: boolean, quiet: boolean): Promise<LibraryReport> {
		this.warnMissingKey(spec, quiet);
		const deps = this.makeDeps(spec, dryRun);
		const report = await libraryFolderSync(spec, deps, { full, dryRun });
		const mode = dryRun ? 'DRY-RUN ' : '';
		if (shouldNotifySync(quiet, report.written, report.errors.length)) {
			this.notify(this.buildSyncSummary(spec, mode, report), 0);
		}
		return report;
	}

	async syncType(spec: MediaTypeSpec, full: boolean, dryRun = false, quiet = false): Promise<LibraryReport> {
		if (this.syncing) {
			this.notify('Library sync already running');
			return emptyReport();
		}
		this.syncing = true;
		try {
			return await this.runSync(spec, full, dryRun, quiet);
		} finally {
			this.syncing = false;
		}
	}

	/** Opens the real candidate picker modal; tests override this method directly to avoid needing a real Obsidian modal. */
	private async pickCandidate(filename: string, candidates: ResolveCandidate[]): Promise<number | 'never' | null> {
		const modal = new CandidatePickerModal(this.plugin.app, filename, candidates);
		return await modal.pick();
	}

	async resolveType(spec: MediaTypeSpec, dryRun = false): Promise<LibraryResolveReport> {
		if (this.syncing) {
			this.notify('Library sync already running');
			return emptyResolveReport();
		}
		this.syncing = true;
		try {
			const deps = this.makeDeps(spec, dryRun);
			const report = await libraryFolderResolve(spec, deps, { dryRun });

			let picked = 0;
			let skipped = 0;
			let marked = 0;
			if (!dryRun) {
				for (const entry of report.needsChoice) {
					try {
						const idx = await this.pickCandidate(entry.filename, entry.candidates);
						if (idx === 'never') {
							const content = await deps.readNote(entry.path);
							await deps.writeNote(entry.path, patchFrontmatter(content, { no_resolve: 'true' }, { defaultType: spec.itemType }));
							marked++;
							continue;
						}
						const candidate = idx != null ? entry.candidates[idx] : undefined;
						if (!candidate) {
							skipped++;
							continue;
						}
						const content = await deps.readNote(entry.path);
						await deps.writeNote(entry.path, patchFrontmatter(content, candidate.patches, { defaultType: spec.itemType }));
						report.resolved.push(entry.path);
						picked++;
					} catch (e) {
						deps.log(`picker failed for ${entry.filename}: ${e instanceof Error ? e.message : String(e)}`);
						skipped++;
					}
				}
			}

			const mode = dryRun ? 'DRY-RUN ' : '';
			let msg = `Library ${mode}resolve (${spec.typeName}): ${report.resolved.length} resolved, ${report.ambiguous.length} ambiguous/no match`;
			if (report.needsChoice.length) msg += `, ${picked} picked, ${skipped} skipped`;
			if (marked) msg += `, ${marked} marked no-resolve`;
			if (report.errors.length) msg += `, ${report.errors.length} errors (see console)`;
			this.notify(msg, 0);
			return report;
		} finally {
			this.syncing = false;
		}
	}

	async syncAll(full: boolean, quiet = false): Promise<void> {
		if (this.syncing) {
			this.notify('Library sync already running');
			return;
		}
		this.syncing = true;
		try {
			for (const spec of this.specs) {
				if (!this.enabledFor(spec)) continue;
				try {
					await this.runSync(spec, full, false, quiet);
				} catch (e) {
					// one type's failure (e.g. its vault folder is missing) must not abort the
					// rest of the run -- log + surface it, then keep going with the other types
					const msg = `Library sync failed for ${spec.typeName}: ${e instanceof Error ? e.message : String(e)}`;
					console.log(`[media-db-library] ${msg}`);
					if (!quiet) this.notify(msg, 0);
				}
			}
			if (!full) {
				this.plugin.settings.libraryLastSync = Date.now();
				await this.plugin.saveSettings();
			}
		} finally {
			this.syncing = false;
		}
	}

	async maybeCatchUp(): Promise<void> {
		const s = this.plugin.settings;
		if (!this.specs.some(spec => this.enabledFor(spec))) return;
		const due = s.libraryLastSync + s.watchlistSyncIntervalHours * 3600_000;
		if (Date.now() >= due) {
			await this.syncAll(false, true).catch(e => console.error('[media-db-library] scheduled sync failed', e));
		}
	}
}
