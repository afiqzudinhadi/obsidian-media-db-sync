export type HttpJsonFn = (url: string, headers: Record<string, string>) => Promise<any>;
export type HttpTextFn = (url: string, headers: Record<string, string>) => Promise<string>;
export type HttpPostJsonFn = (url: string, body: unknown, headers: Record<string, string>) => Promise<any>;

export interface LibraryNoteCtx {
	frontmatter: Record<string, string>;
	body: string;
	filename: string;
}

/** One candidate offered to the user when resolve() can't pick a unique match on its own. */
export interface ResolveCandidate {
	label: string; // human-readable (title + year/author/publisher/etc, whatever the spec already logs)
	detail?: string; // optional second line for the picker (format/status/publisher/id, etc) -- muted, smaller text
	patches: Record<string, string>; // full id-field patch for this candidate (e.g. anilist_id + mal_id)
}

/** resolve() outcome: either a confident unique-match patch, or a shortlist for the user to pick from. */
export type ResolveOutcome = { patches: Record<string, string> } | { candidates: ResolveCandidate[] };

export interface MediaTypeSpec {
	typeName: 'manga' | 'book' | 'game' | 'comic';
	itemType: string; // 'manga_item' etc.
	folderSettingKey: string;
	enabledSettingKey: string;
	throttleMs: number;
	hasId(fm: Record<string, string>): boolean;
	isActive(fm: Record<string, string>): boolean;
	resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<ResolveOutcome | null>; // null = no match/error
	sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null>; // full new note content; null = skip
}

export interface SpecDeps {
	http: HttpJsonFn;
	httpText: HttpTextFn;
	httpPostJson: HttpPostJsonFn;
	getKey(name: 'rawg' | 'comicvine'): string; // '' when unset
	log(msg: string): void;
	notify(msg: string): void;
}
