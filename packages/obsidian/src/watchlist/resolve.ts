type SearchFn = (query: string, isMovie: boolean, year?: string) => Promise<any[]>;

export interface ResolveResult {
	tmdbId: string;
	isMovie: boolean;
	matchedTitle: string;
}

function resultTitle(r: any): string {
	return r.title ?? r.name ?? '';
}

function resultTitles(r: any): string[] {
	return [r.title, r.original_title, r.name, r.original_name].filter(Boolean).map((t: string) => t.toLowerCase());
}

async function tryOne(query: string, isMovie: boolean, year: string | undefined, search: SearchFn): Promise<ResolveResult | null> {
	const results = await search(query, isMovie, year);
	if (results.length === 0) return null;
	const q = query.toLowerCase();
	const exact = results.find(r => resultTitles(r).includes(q));
	const pick = exact ?? (results.length === 1 ? results[0] : null);
	if (!pick) return null;
	return { tmdbId: String(pick.id), isMovie, matchedTitle: resultTitle(pick) };
}

export async function resolveNote(fm: Record<string, string>, filename: string, search: SearchFn): Promise<ResolveResult | null> {
	const strip = (s: string | undefined): string => (s ?? '').trim().replace(/^"|"$/g, '');
	const query = strip(fm['title']) || filename.replace(/\.md$/, '');
	const yearField = strip(fm['year']) || strip(fm['release_date']);
	const year = /^\d{4}/.exec(yearField)?.[0];
	const mt = strip(fm['media_type']);
	if (mt === 'Movie') return await tryOne(query, true, year, search);
	if (mt) return await tryOne(query, false, year, search);
	return (await tryOne(query, true, year, search)) ?? (await tryOne(query, false, year, search));
}
