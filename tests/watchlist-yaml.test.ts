import { describe, expect, test } from 'bun:test';
import { yamlScalar, yamlList, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';

describe('yamlScalar', () => {
	test('plain string passes through', () => {
		expect(yamlScalar('English')).toBe('English');
	});
	test('empty/null/undefined → empty string', () => {
		expect(yamlScalar('')).toBe('');
		expect(yamlScalar(null)).toBe('');
		expect(yamlScalar(undefined)).toBe('');
	});
	test('special chars → quoted', () => {
		expect(yamlScalar('S2, E6: Glorious Purpose')).toBe('"S2, E6: Glorious Purpose"');
		expect(yamlScalar('Aaron Moorhead, Justin Benson')).toBe('"Aaron Moorhead, Justin Benson"');
	});
	test('comma alone does NOT quote (matches python regex)', () => {
		// python regex [:#\[\]{}}&*!|>%@`] has no comma; "a, b" quotes via ":"? no — verify: comma not in class, so "Alter, Turtle" stays plain
		expect(yamlScalar('Rachel Alter and Tommy Turtle')).toBe('Rachel Alter and Tommy Turtle');
	});
	test('yaml keywords → quoted', () => {
		expect(yamlScalar('null')).toBe('"null"');
		expect(yamlScalar('No')).toBe('"No"');
	});
	test('embedded quotes escaped', () => {
		expect(yamlScalar('He said "hi"')).toBe('"He said \\"hi\\""');
	});
});

describe('yamlList', () => {
	test('plain items unquoted, special quoted', () => {
		expect(yamlList(['Drama', 'Sci-Fi & Fantasy'])).toBe('[Drama, "Sci-Fi & Fantasy"]');
	});
	test('empty list', () => {
		expect(yamlList([])).toBe('[]');
	});
	test('blank items dropped', () => {
		expect(yamlList(['', 'Drama', '  '])).toBe('[Drama]');
	});
	test('Disney+ quoted', () => {
		expect(yamlList(['Disney+'])).toBe('["Disney+"]');
	});
});

describe('quotedOrNull', () => {
	test('value → quoted', () => {
		expect(quotedOrNull('https://x.y/z')).toBe('"https://x.y/z"');
	});
	test('empty/null → null literal', () => {
		expect(quotedOrNull('')).toBe('null');
		expect(quotedOrNull(null)).toBe('null');
	});
});
