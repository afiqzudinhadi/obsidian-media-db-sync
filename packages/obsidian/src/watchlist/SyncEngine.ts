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
