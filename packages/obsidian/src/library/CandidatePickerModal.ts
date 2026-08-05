import type { App, FuzzyMatch } from 'obsidian';
import { FuzzySuggestModal } from 'obsidian';
import type { ResolveCandidate } from 'packages/obsidian/src/library/types';

const SKIP_LABEL = 'Skip';
const NEVER_LABEL = 'Never resolve (mark no_resolve)';
const DETAIL_CLASS = 'media-db-sync-candidate-detail';

interface PickerItem {
	label: string;
	detail?: string; // optional muted second line (format/status/publisher/id, etc); absent for Skip/Never rows
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
		return [
			...this.candidates.map((c, index) => ({ label: c.label, detail: c.detail, index })),
			{ label: SKIP_LABEL, index: null },
			{ label: NEVER_LABEL, index: 'never' as const },
		];
	}

	getItemText(item: PickerItem): string {
		return item.label;
	}

	/** Two-line suggestion row: label, plus a muted detail line when the candidate has one (Skip/Never never do). */
	renderSuggestion(match: FuzzyMatch<PickerItem>, el: HTMLElement): void {
		el.createDiv({ text: match.item.label });
		if (match.item.detail) el.createDiv({ text: match.item.detail, cls: DETAIL_CLASS });
	}

	onChooseItem(item: PickerItem, _evt: MouseEvent | KeyboardEvent): void {
		this.settle(item.index);
	}

	onClose(): void {
		// Obsidian's selectSuggestion() calls close() BEFORE onChooseItem(), so settling here
		// synchronously would discard a real choice. Defer one tick: a choice made in the same
		// tick settles first and this becomes a no-op; a genuine dismissal settles as skip.
		window.setTimeout(() => this.settle(null), 0);
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
