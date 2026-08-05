import { describe, expect, test } from 'bun:test';
import { CandidatePickerModal } from 'packages/obsidian/src/library/CandidatePickerModal';

const CANDIDATES = [
	{ label: 'Foo (2020)', patches: { mal_id: '1' } },
	{ label: 'Bar (2021)', patches: { mal_id: '2' } },
];

const CANDIDATES_WITH_DETAIL = [
	{ label: 'Foo (2020)', detail: 'Manga · Publishing · Author One · anilist:1', patches: { mal_id: '1' } },
	{ label: 'Bar (2021)', patches: { mal_id: '2' } }, // no detail -- must render as a single-line row
];

function fakeApp(): any {
	return {};
}

/** Minimal Obsidian `HTMLElement.createDiv` stand-in: records every call's options instead of touching a real DOM. */
function fakeEl(): { calls: unknown[]; createDiv: (o?: unknown) => unknown } {
	const calls: unknown[] = [];
	return {
		calls,
		createDiv(o?: unknown) {
			calls.push(o);
			return fakeEl();
		},
	};
}

describe('CandidatePickerModal', () => {
	test('getItems: candidate labels followed by Skip then Never resolve', () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES);
		const items = modal.getItems();
		expect(items).toEqual([
			{ label: 'Foo (2020)', index: 0 },
			{ label: 'Bar (2021)', index: 1 },
			{ label: 'Skip', index: null },
			{ label: 'Never resolve (mark no_resolve)', index: 'never' },
		]);
	});

	test('getItemText returns the item label', () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES);
		expect(modal.getItemText({ label: 'Foo (2020)', index: 0 })).toBe('Foo (2020)');
	});

	test('getItems: candidate detail threaded through, Skip/Never rows have no detail', () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES_WITH_DETAIL);
		const items = modal.getItems();
		expect(items).toEqual([
			{ label: 'Foo (2020)', detail: 'Manga · Publishing · Author One · anilist:1', index: 0 },
			{ label: 'Bar (2021)', detail: undefined, index: 1 },
			{ label: 'Skip', index: null },
			{ label: 'Never resolve (mark no_resolve)', index: 'never' },
		]);
	});

	test('renderSuggestion: candidate with a detail -> label div + muted detail div', () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES_WITH_DETAIL);
		const item = modal.getItems()[0];
		const el = fakeEl();
		modal.renderSuggestion({ item, match: { score: 0, matches: [] } } as any, el as unknown as HTMLElement);
		expect(el.calls).toEqual([{ text: 'Foo (2020)' }, { text: 'Manga · Publishing · Author One · anilist:1', cls: 'media-db-sync-candidate-detail' }]);
	});

	test('renderSuggestion: candidate with no detail -> label div only', () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES_WITH_DETAIL);
		const item = modal.getItems()[1];
		const el = fakeEl();
		modal.renderSuggestion({ item, match: { score: 0, matches: [] } } as any, el as unknown as HTMLElement);
		expect(el.calls).toEqual([{ text: 'Bar (2021)' }]);
	});

	test('renderSuggestion: Skip/Never rows -> label div only, no detail row', () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES_WITH_DETAIL);
		const items = modal.getItems();
		const skipEl = fakeEl();
		modal.renderSuggestion({ item: items[2], match: { score: 0, matches: [] } } as any, skipEl as unknown as HTMLElement);
		expect(skipEl.calls).toEqual([{ text: 'Skip' }]);
		const neverEl = fakeEl();
		modal.renderSuggestion({ item: items[3], match: { score: 0, matches: [] } } as any, neverEl as unknown as HTMLElement);
		expect(neverEl.calls).toEqual([{ text: 'Never resolve (mark no_resolve)' }]);
	});

	test('onChooseItem(candidate) -> pick() resolves to that candidate index', async () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES);
		const result = modal.pick();
		modal.onChooseItem({ label: 'Bar (2021)', index: 1 }, {} as MouseEvent);
		expect(await result).toBe(1);
	});

	test('onChooseItem(Skip) -> pick() resolves to null', async () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES);
		const result = modal.pick();
		modal.onChooseItem({ label: 'Skip', index: null }, {} as MouseEvent);
		expect(await result).toBeNull();
	});

	test('onChooseItem(Never resolve) -> pick() resolves to \'never\'', async () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES);
		const result = modal.pick();
		modal.onChooseItem({ label: 'Never resolve (mark no_resolve)', index: 'never' }, {} as MouseEvent);
		expect(await result).toBe('never');
	});

	test('onClose without a prior choice (Esc / dismiss) -> pick() resolves to null', async () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES);
		const result = modal.pick();
		modal.onClose();
		expect(await result).toBeNull();
	});

	test('onClose firing after onChooseItem does not override the already-settled choice', async () => {
		const modal = new CandidatePickerModal(fakeApp(), 'Some Note.md', CANDIDATES);
		const result = modal.pick();
		modal.onChooseItem({ label: 'Foo (2020)', index: 0 }, {} as MouseEvent);
		modal.onClose(); // Obsidian calls onClose() after a choice too -- must not clobber the resolved value
		expect(await result).toBe(0);
	});
});
