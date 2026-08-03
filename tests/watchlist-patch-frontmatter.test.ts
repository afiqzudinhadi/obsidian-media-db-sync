import { describe, expect, test } from 'bun:test';
import { patchFrontmatter } from 'packages/obsidian/src/watchlist/patchFrontmatter';

describe('patchFrontmatter', () => {
	test('inserts patches right after the type: line when frontmatter exists', () => {
		const content = '---\ntype: watchlist_item\ntitle: Loki\n---\n\nbody';
		const out = patchFrontmatter(content, { tmdb_id: '84958', media_type: 'TV Series' });
		expect(out).toBe('---\ntype: watchlist_item\ntmdb_id: 84958\nmedia_type: TV Series\ntitle: Loki\n---\n\nbody');
	});

	test('no type: line -> patches prepended before existing frontmatter', () => {
		const content = '---\ntitle: Loki\n---\n\nbody';
		const out = patchFrontmatter(content, { tmdb_id: '1' });
		expect(out).toBe('---\ntmdb_id: 1\ntitle: Loki\n---\n\nbody');
	});

	test('no frontmatter at all -> creates block with defaultType', () => {
		const content = '# Loki\n\nbody';
		const out = patchFrontmatter(content, { tmdb_id: '1' }, { defaultType: 'watchlist_item' });
		expect(out).toBe('---\ntype: watchlist_item\ntmdb_id: 1\n---\n\n# Loki\n\nbody');
	});

	test('no frontmatter, no defaultType -> no type line inserted', () => {
		const content = 'body only';
		const out = patchFrontmatter(content, { mal_id: '5' });
		expect(out).toBe('---\nmal_id: 5\n---\n\nbody only');
	});

	test('multiple patch keys preserve insertion order', () => {
		const content = '---\ntype: manga_item\n---\n';
		const out = patchFrontmatter(content, { mal_id: '5', mangadex_id: 'abc' });
		expect(out).toContain('mal_id: 5\nmangadex_id: abc');
	});
});
