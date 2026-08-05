import { describe, expect, test } from 'bun:test';
import { CandidatePickerModal } from 'packages/obsidian/src/library/CandidatePickerModal';

const CANDIDATES = [
	{ label: 'Foo (2020)', patches: { mal_id: '1' } },
	{ label: 'Bar (2021)', patches: { mal_id: '2' } },
];

function fakeApp(): any {
	return {};
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
