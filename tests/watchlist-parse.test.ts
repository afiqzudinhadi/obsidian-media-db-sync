import { describe, expect, test } from 'bun:test';
import { parseNote, extractMyNotes, noteTmdbRef, extractCustomSections } from 'packages/obsidian/src/watchlist/parse';

const NOTE = `---
type: watchlist_item
media_type: TV Series
tmdb_id: 84958
last_air_date: 2023-11-09
watch_status: Watched
---

# Loki

## My Notes

great finale
`;

describe('parseNote', () => {
	test('splits frontmatter and body', () => {
		const { frontmatter, body } = parseNote(NOTE);
		expect(frontmatter['tmdb_id']).toBe('84958');
		expect(frontmatter['media_type']).toBe('TV Series');
		expect(body).toContain('# Loki');
	});
	test('no frontmatter → empty fm, full body', () => {
		const { frontmatter, body } = parseNote('# Just a heading');
		expect(Object.keys(frontmatter).length).toBe(0);
		expect(body).toBe('# Just a heading');
	});
});

describe('extractMyNotes', () => {
	test('extracts trailing section', () => {
		expect(extractMyNotes(parseNote(NOTE).body)).toBe('great finale');
	});
	test('missing section → empty', () => {
		expect(extractMyNotes('# T\n\ncontent')).toBe('');
	});
});

describe('noteTmdbRef', () => {
	test('canonical note', () => {
		expect(noteTmdbRef({ tmdb_id: '84958', media_type: 'TV Series' })).toEqual({ tmdbId: '84958', isMovie: false });
		expect(noteTmdbRef({ tmdb_id: '693134', media_type: 'Movie' })).toEqual({ tmdbId: '693134', isMovie: true });
	});
	test('quoted values stripped', () => {
		expect(noteTmdbRef({ tmdb_id: '"84958"', media_type: '"TV Series"' })).toEqual({ tmdbId: '84958', isMovie: false });
	});
	test('raw Media DB note fallback (id + dataSource)', () => {
		expect(noteTmdbRef({ id: '693134', dataSource: 'TMDBMovieAPI' })).toEqual({ tmdbId: '693134', isMovie: true });
		expect(noteTmdbRef({ id: '84958', dataSource: 'TMDBSeriesAPI' })).toEqual({ tmdbId: '84958', isMovie: false });
	});
	test('no id → null', () => {
		expect(noteTmdbRef({ type: 'list' })).toBeNull();
	});
});

describe('extractCustomSections', () => {
	test('extracts non-owned section', () => {
		const body = `\n# Loki\n\n## Links\n- [IMDb](x)\n\n## Collection\nPart of [[Movies]]\n\n## My Notes\n\ngreat finale\n`;
		expect(extractCustomSections(body)).toEqual([{ heading: 'Collection', content: 'Part of [[Movies]]' }]);
	});
	test('owned headings excluded (Synopsis, Cast, Links, My Notes)', () => {
		const body = `\n## Synopsis\nblah\n\n## Cast\nA, B\n\n## Links\n- x\n\n## My Notes\n\nnote\n`;
		expect(extractCustomSections(body)).toEqual([]);
	});
	test('two custom sections keep order', () => {
		const body = `\n## Collection\nPart of [[Movies]]\n\n## Rewatch Log\n- 2024-01-01\n- 2025-02-02\n\n## My Notes\n\nnote\n`;
		expect(extractCustomSections(body)).toEqual([
			{ heading: 'Collection', content: 'Part of [[Movies]]' },
			{ heading: 'Rewatch Log', content: '- 2024-01-01\n- 2025-02-02' },
		]);
	});
	test('preserves internal blank lines, trims trailing', () => {
		const body = `\n## Collection\nline one\n\nline two\n\n\n## My Notes\n\nnote\n`;
		expect(extractCustomSections(body)).toEqual([{ heading: 'Collection', content: 'line one\n\nline two' }]);
	});
	test('no custom sections → empty array', () => {
		const body = `\n# Loki\n\n## Links\n- x\n\n## My Notes\n\nnote\n`;
		expect(extractCustomSections(body)).toEqual([]);
	});
	test('empty/missing body → empty array', () => {
		expect(extractCustomSections('')).toEqual([]);
	});
});
