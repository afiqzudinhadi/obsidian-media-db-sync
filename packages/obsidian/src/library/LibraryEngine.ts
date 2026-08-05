import type { LibraryNoteCtx, MediaTypeSpec, ResolveCandidate, SpecDeps } from 'packages/obsidian/src/library/types';
import { parseNote, stripQuotes } from 'packages/obsidian/src/watchlist/parse';
import { patchFrontmatter } from 'packages/obsidian/src/watchlist/patchFrontmatter';
import { withRateLimitRetry } from 'packages/obsidian/src/watchlist/SyncEngine';

export interface LibraryEngineDeps {
	listNotes(): Promise<{ path: string }[]>;
	readNote(path: string): Promise<string>;
	writeNote(path: string, content: string): Promise<void>;
	sleep(ms: number): Promise<void>;
	log(msg: string): void;
	specDeps: SpecDeps;
}

export interface LibraryReport {
	scanned: number;
	synced: number;
	written: number;
	skippedNoId: number;
	skippedStatic: number;
	skippedNoData: number;
	flipped: string[];
	errors: { path: string; error: string }[];
}

export interface LibraryResolveReport {
	resolved: string[];
	ambiguous: string[];
	needsChoice: { path: string; filename: string; candidates: ResolveCandidate[] }[];
	skippedNoResolve: number;
	errors: { path: string; error: string }[];
}

// Notes with `type: comicManga|book|game` are stock-skeleton entries (pre-conversion, all
// vault types collapse to these 3 legacy MediaType values) and must NOT be skipped -- the
// first sync converts them to their canonical `<type>_item` shape.
const STOCK_SKELETON_TYPES = new Set(['comicManga', 'book', 'game']);

function filenameOf(path: string): string {
	return path.split('/').pop() ?? path;
}

/** `_`-prefixed notes (dashboards/indexes) and non-entry notes (e.g. `type: folder_index`) are silently skipped. */
function isSkippableNote(filename: string, fm: Record<string, string>, itemType: string): boolean {
	if (filename.startsWith('_')) return true;
	const type = stripQuotes(fm['type']);
	if (!type) return false;
	if (type === itemType) return false;
	if (STOCK_SKELETON_TYPES.has(type)) return false;
	return true;
}

export async function libraryFolderSync(spec: MediaTypeSpec, deps: LibraryEngineDeps, opts: { full?: boolean; dryRun?: boolean } = {}): Promise<LibraryReport> {
	const report: LibraryReport = { scanned: 0, synced: 0, written: 0, skippedNoId: 0, skippedStatic: 0, skippedNoData: 0, flipped: [], errors: [] };
	const notes = await deps.listNotes();
	for (const note of notes) {
		report.scanned++;
		try {
			// Read immediately before parse/diff so mid-sync edits aren't clobbered by a stale snapshot.
			const content = await deps.readNote(note.path);
			const { frontmatter, body } = parseNote(content);
			const filename = filenameOf(note.path);
			if (isSkippableNote(filename, frontmatter, spec.itemType)) continue;
			if (!spec.hasId(frontmatter)) {
				report.skippedNoId++;
				continue;
			}
			if (!opts.full && !spec.isActive(frontmatter)) {
				report.skippedStatic++;
				continue;
			}
			const ctx: LibraryNoteCtx = { frontmatter, body, filename };
			const result = await withRateLimitRetry(() => spec.sync(ctx, deps.specDeps), deps.sleep);
			if (!result) {
				report.skippedNoData++;
			} else {
				report.synced++;
				if (result.flipped) report.flipped.push(note.path);
				if (result.content !== content) {
					report.written++;
					if (!opts.dryRun) await deps.writeNote(note.path, result.content);
					deps.log(`${opts.dryRun ? '[dry] ' : ''}updated ${note.path}`);
				}
			}
			await deps.sleep(spec.throttleMs);
		} catch (e) {
			report.errors.push({ path: note.path, error: e instanceof Error ? e.message : String(e) });
			deps.log(`ERROR ${note.path}: ${String(e)}`);
		}
	}
	return report;
}

/** `no_resolve: true` opts a note out of the entire resolve pass (all specs), same as a manual skip. */
function hasNoResolveFlag(fm: Record<string, string>): boolean {
	return stripQuotes(fm['no_resolve']) === 'true';
}

export async function libraryFolderResolve(spec: MediaTypeSpec, deps: LibraryEngineDeps, opts: { dryRun?: boolean } = {}): Promise<LibraryResolveReport> {
	const report: LibraryResolveReport = { resolved: [], ambiguous: [], needsChoice: [], skippedNoResolve: 0, errors: [] };
	const notes = await deps.listNotes();
	for (const note of notes) {
		try {
			const content = await deps.readNote(note.path);
			const { frontmatter, body } = parseNote(content);
			const filename = filenameOf(note.path);
			if (isSkippableNote(filename, frontmatter, spec.itemType)) continue;
			if (hasNoResolveFlag(frontmatter)) {
				report.skippedNoResolve++;
				deps.log(`no_resolve flag set, skipping: ${note.path}`);
				continue;
			}
			if (spec.hasId(frontmatter)) continue; // already resolved
			const ctx: LibraryNoteCtx = { frontmatter, body, filename };
			const outcome = await withRateLimitRetry(() => spec.resolve(ctx, deps.specDeps), deps.sleep);
			if (!outcome) {
				report.ambiguous.push(note.path);
				deps.log(`ambiguous/no match: ${note.path}`);
			} else if ('candidates' in outcome) {
				report.needsChoice.push({ path: note.path, filename, candidates: outcome.candidates });
				deps.log(`needs choice (${outcome.candidates.length} candidates): ${note.path}`);
			} else {
				report.resolved.push(note.path);
				deps.log(`${opts.dryRun ? '[dry] ' : ''}resolved ${note.path}`);
				if (!opts.dryRun) await deps.writeNote(note.path, patchFrontmatter(content, outcome.patches, { defaultType: spec.itemType }));
			}
			await deps.sleep(spec.throttleMs);
		} catch (e) {
			report.errors.push({ path: note.path, error: e instanceof Error ? e.message : String(e) });
			deps.log(`ERROR ${note.path}: ${String(e)}`);
		}
	}
	return report;
}
