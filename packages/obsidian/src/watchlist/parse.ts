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
