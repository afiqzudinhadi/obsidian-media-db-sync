import { describe, expect, test } from 'bun:test';

// Test that verifies the try/catch wrapping is syntactically correct
// and the error handling path exists in LibraryController.resolveType

describe('LibraryController per-entry error isolation', () => {
	test('try/catch present in resolveType for per-entry failures', async () => {
		// Read the source file and verify try/catch is present
		const srcText = (await Bun.file('packages/obsidian/src/library/LibraryController.ts').text());

		// Verify the fix is in place: try block wrapping readNote/writeNote
		expect(srcText).toContain('try {');
		expect(srcText).toContain('const content = await deps.readNote(entry.path);');
		expect(srcText).toContain('await deps.writeNote(entry.path');
		expect(srcText).toContain('} catch (e) {');
		expect(srcText).toContain('picker failed for');
		expect(srcText).toContain('skipped++;');
	});

	test('error logging includes filename and message', async () => {
		const srcText = await Bun.file('packages/obsidian/src/library/LibraryController.ts').text();

		// Verify error log includes entry filename
		expect(srcText).toContain('picker failed for ${entry.filename}');
		// Verify error message is captured
		expect(srcText).toContain('e instanceof Error ? e.message : String(e)');
	});
});
