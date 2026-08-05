import type { App } from 'obsidian';
import { FuzzySuggestModal } from 'obsidian';
import type { ResolveCandidate } from 'packages/obsidian/src/library/types';

const SKIP_LABEL = 'Skip';

interface PickerItem {
	label: string;
	index: number | null; // null = Skip
}

/**
 * Fuzzy picker for an ambiguous resolve() result. `pick()` resolves to the chosen candidate's
 * index, or null when the user picks "Skip" / dismisses the modal (Esc, click-outside) without
 * choosing -- both are treated identically by the caller (LibraryController.resolveType).
 */
export class CandidatePickerModal extends FuzzySuggestModal<PickerItem> {
	private settled = false;
	private resolveFn?: (index: number | null) => void;

	constructor(
		app: App,
		private filename: string,
		private candidates: ResolveCandidate[],
	) {
		super(app);
		this.setTitle(filename);
		this.setPlaceholder(`Pick a match for ${filename}`);
	}

	getItems(): PickerItem[] {
		return [...this.candidates.map((c, index) => ({ label: c.label, index })), { label: SKIP_LABEL, index: null }];
	}

	getItemText(item: PickerItem): string {
		return item.label;
	}

	onChooseItem(item: PickerItem, _evt: MouseEvent | KeyboardEvent): void {
		this.settle(item.index);
	}

	onClose(): void {
		this.settle(null); // dismissed without choosing -> treat as skip
		this.contentEl.empty();
	}

	private settle(index: number | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveFn?.(index);
	}

	pick(): Promise<number | null> {
		return new Promise(resolve => {
			this.resolveFn = resolve;
			this.open();
		});
	}
}
