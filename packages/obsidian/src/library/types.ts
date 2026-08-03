export type HttpJsonFn = (url: string, headers: Record<string, string>) => Promise<any>;
export type HttpTextFn = (url: string, headers: Record<string, string>) => Promise<string>;

export interface LibraryNoteCtx {
	frontmatter: Record<string, string>;
	body: string;
	filename: string;
}

export interface MediaTypeSpec {
	typeName: 'manga' | 'book' | 'game' | 'comic';
	itemType: string; // 'manga_item' etc.
	folderSettingKey: string;
	enabledSettingKey: string;
	throttleMs: number;
	hasId(fm: Record<string, string>): boolean;
	isActive(fm: Record<string, string>): boolean;
	resolve(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<Record<string, string> | null>; // returns fm patches (id fields)
	sync(ctx: LibraryNoteCtx, deps: SpecDeps): Promise<{ content: string; flipped: boolean } | null>; // full new note content; null = skip
}

export interface SpecDeps {
	http: HttpJsonFn;
	httpText: HttpTextFn;
	getKey(name: 'rawg' | 'comicvine'): string; // '' when unset
	log(msg: string): void;
	notify(msg: string): void;
}
