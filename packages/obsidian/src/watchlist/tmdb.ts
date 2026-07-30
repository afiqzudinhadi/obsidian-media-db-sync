export type HttpJsonFn = (url: string, headers: Record<string, string>) => Promise<any>;

const BASE = 'https://api.themoviedb.org/3';

function authParts(key: string): { headers: Record<string, string>; extraParams: Record<string, string> } {
	if (key.startsWith('eyJ')) {
		return { headers: { Authorization: `Bearer ${key}`, accept: 'application/json' }, extraParams: {} };
	}
	return { headers: { accept: 'application/json' }, extraParams: { api_key: key } };
}

function buildUrl(path: string, params: Record<string, string>): string {
	const qs = new URLSearchParams(params);
	return `${BASE}${path}?${qs.toString()}`;
}

export async function fetchDetail(http: HttpJsonFn, key: string, tmdbId: string, isMovie: boolean): Promise<any> {
	const { headers, extraParams } = authParts(key);
	const path = isMovie ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
	const append = isMovie ? 'credits,external_ids,release_dates,videos' : 'aggregate_credits,external_ids,content_ratings,videos';
	return await http(buildUrl(path, { append_to_response: append, language: 'en-US', ...extraParams }), headers);
}

export async function searchTitle(http: HttpJsonFn, key: string, query: string, isMovie: boolean, year?: string): Promise<any[]> {
	const { headers, extraParams } = authParts(key);
	const params: Record<string, string> = { query, language: 'en-US', ...extraParams };
	if (year) params[isMovie ? 'primary_release_year' : 'first_air_date_year'] = year;
	const res = await http(buildUrl(isMovie ? '/search/movie' : '/search/tv', params), headers);
	return res?.results ?? [];
}
