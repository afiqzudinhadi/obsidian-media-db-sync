import type { App } from 'obsidian';
import { FuzzySuggestModal } from 'obsidian';
import type { ResolveCandidate } from 'packages/obsidian/src/library/types';

const SKIP_LABEL = 'Skip';
const NEVER_LABEL = 'Never resolve (mark no_resolve)';

interface PickerItem {
	label: string;
	index: number | 'never' | null; // null = Skip, 'never' = mark no_resolve
}

/**
 * Fuzzy picker for an ambiguous resolve() result. `pick()` resolves to the chosen candidate's
 * index, 'never' when the user picks "Never resolve (mark no_resolve)", or null when the user
 * picks "Skip" / dismisses the modal (Esc, click-outside) without choosing -- null is treated as
 * a plain skip by the caller (LibraryController.resolveType).
 */
export class CandidatePickerModal extends FuzzySuggestModal<PickerItem> {
	private settled = false;
	private resolveFn?: (index: number | 'never' | null) => void;

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
		return [...this.candidates.map((c, index) => ({ label: c.label, index })), { label: SKIP_LABEL, index: null }, { label: NEVER_LABEL, index: 'never' as const }];
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

	private settle(index: number | 'never' | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveFn?.(index);
	}

	pick(): Promise<number | 'never' | null> {
		return new Promise(resolve => {
			this.resolveFn = resolve;
			this.open();
		});
	}
}
