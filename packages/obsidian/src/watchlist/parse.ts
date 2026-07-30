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

const OWNED_HEADINGS = new Set(['Synopsis', 'Cast', 'Links', 'My Notes']);

export interface CustomSection {
	heading: string;
	content: string;
}

export function extractCustomSections(body: string): CustomSection[] {
	const lines = (body ?? '').split('\n');
	const sections: CustomSection[] = [];
	let heading: string | null = null;
	let buf: string[] = [];
	const flush = (): void => {
		if (heading === null) return;
		const content = buf.join('\n').replace(/(\n\s*)+$/, '');
		if (!OWNED_HEADINGS.has(heading)) sections.push({ heading, content });
	};
	for (const line of lines) {
		const m = /^##\s+(.*)$/.exec(line);
		if (m) {
			flush();
			heading = m[1].trim();
			buf = [];
		} else if (heading !== null) {
			buf.push(line);
		}
	}
	flush();
	return sections;
}

export function stripQuotes(s: string | undefined): string {
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
