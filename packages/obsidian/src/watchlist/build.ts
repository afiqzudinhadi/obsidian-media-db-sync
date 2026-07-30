import type { WatchlistRecord } from 'packages/obsidian/src/watchlist/schema';

export type TmdbDetail = Record<string, any>;

const IMG_BASE = 'https://image.tmdb.org/t/p/original';

const LANG_FALLBACK: Record<string, string> = {
	en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French',
	es: 'Spanish', de: 'German', hi: 'Hindi', ta: 'Tamil', th: 'Thai',
};

function langName(details: TmdbDetail): string {
	const code: string = details.original_language ?? '';
	for (const sl of details.spoken_languages ?? []) {
		if (sl.iso_639_1 === code && sl.english_name) return sl.english_name;
	}
	return LANG_FALLBACK[code] ?? code;
}

function crewNames(crew: any[], jobs: Set<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of crew) {
		if (jobs.has(c.job) && !seen.has(c.name)) {
			seen.add(c.name);
			out.push(c.name);
		}
	}
	return out;
}

function usCertFromReleaseDates(rd: TmdbDetail): string {
	for (const entry of rd?.results ?? []) {
		if (entry.iso_3166_1 === 'US') {
			for (const d of entry.release_dates ?? []) {
				if (d.certification) return d.certification;
			}
		}
	}
	return '';
}

function usCertFromContentRatings(cr: TmdbDetail): string {
	for (const entry of cr?.results ?? []) {
		if (entry.iso_3166_1 === 'US' && entry.rating) return entry.rating;
	}
	return '';
}

function pickTrailer(videos: TmdbDetail): string {
	const vids: any[] = videos?.results ?? [];
	const yt = (v: any): string => 'https://www.youtube.com/watch?v=' + v.key;
	for (const v of vids) if (v.site === 'YouTube' && v.type === 'Trailer' && v.official) return yt(v);
	for (const v of vids) if (v.site === 'YouTube' && v.type === 'Trailer') return yt(v);
	return '';
}

export function buildRecord(details: TmdbDetail, isMovie: boolean, prev: Record<string, string>): WatchlistRecord {
	const genres: string[] = (details.genres ?? []).map((g: any) => g.name);
	const language = langName(details);
	const imdbId: string = details.external_ids?.imdb_id ?? '';
	const trailer = pickTrailer(details.videos ?? {});

	let title: string, originalTitle: string, mediaType: 'Movie' | 'TV Series';
	let releaseDate: string | null, runtime: number | null, status: string, contentRating: string, country: string;
	let cast: string[], director: string[], writer: string[], producer: string[];
	let seasons: number | null, episodes: number | null, vod: string[];
	let lastAirDate: string | null = null, nextAirDate: string | null = null;
	let lastEpisode: string | null = null, upEpisode: string | null = null;
	let yearDisp: string;

	if (isMovie) {
		const credits = details.credits ?? {};
		cast = (credits.cast ?? []).slice(0, 12).map((c: any) => c.name);
		const crew: any[] = credits.crew ?? [];
		director = crewNames(crew, new Set(['Director']));
		writer = crewNames(crew, new Set(['Writer', 'Screenplay', 'Story']));
		producer = crewNames(crew, new Set(['Producer']));
		title = details.title ?? '';
		originalTitle = details.original_title ?? '';
		mediaType = 'Movie';
		releaseDate = details.release_date || null;
		runtime = details.runtime || null;
		status = details.status ?? '';
		contentRating = usCertFromReleaseDates(details.release_dates ?? {});
		const countries: string[] = (details.production_countries ?? []).map((c: any) => c.name);
		country = countries[0] ?? '';
		yearDisp = (releaseDate ?? '').slice(0, 4);
		seasons = null;
		episodes = null;
		vod = [];
	} else {
		const agg = details.aggregate_credits ?? {};
		cast = (agg.cast ?? []).slice(0, 12).map((c: any) => c.name);
		const createdBy: string[] = (details.created_by ?? []).map((c: any) => c.name);
		director = createdBy; // series: creators (latest-episode director needs extra call — Phase 3)
		writer = createdBy;
		producer = [];
		title = details.name ?? '';
		originalTitle = details.original_name ?? '';
		mediaType = 'TV Series';
		releaseDate = details.first_air_date || null;
		const rt: number[] = details.episode_run_time ?? [];
		runtime = rt.length > 0 ? rt[0] : null;
		status = details.status ?? '';
		contentRating = usCertFromContentRatings(details.content_ratings ?? {});
		const countries: string[] = details.origin_country ?? [];
		country = countries[0] ?? '';
		seasons = details.number_of_seasons ?? null;
		episodes = details.number_of_episodes ?? null;
		vod = (details.networks ?? []).map((n: any) => n.name);
		lastAirDate = details.last_air_date || null;
		const le = details.last_episode_to_air;
		const ne = details.next_episode_to_air;
		lastEpisode = le ? `S${le.season_number}, E${le.episode_number}: ${le.name}` : null;
		upEpisode = ne
			? `S${ne.season_number}, E${ne.episode_number}: ${ne.name}`
			: ['Returning Series', 'Pilot'].includes(status)
				? 'TBA'
				: null;
		nextAirDate = ne?.air_date ?? null;
		const start = (releaseDate ?? '').slice(0, 4);
		const ended = ['Ended', 'Canceled', 'Cancelled'].includes(status);
		const end = ended ? (lastAirDate ?? '').slice(0, 4) : null;
		yearDisp = end && end !== start ? `${start} - ${end}` : start && !ended ? `${start} -` : start;
	}

	const category: 'Movie' | 'Series' | 'Anime' =
		genres.includes('Animation') && language === 'Japanese' ? 'Anime' : isMovie ? 'Movie' : 'Series';

	const poster = details.poster_path ? IMG_BASE + details.poster_path : null;
	let engName = '';
	// eslint-disable-next-line no-control-regex
	if (originalTitle && originalTitle !== title && !/^[\x00-\x7F ]+$/.test(originalTitle)) {
		engName = title; // original is non-Latin → english name is the localized title
	}

	// ---- preserve user-managed fields ----
	let watchStatus = prev['watch_status'] || 'Unwatched';
	const rating = prev['rating'] || '0';
	const ratingStars = prev['rating_stars'] ?? '';
	const rawNotionUrl = prev['notion_url'] || '';
	const notionUrl = rawNotionUrl === 'null' ? '' : rawNotionUrl; // quotedOrNull renders empty as literal `null` — don't round-trip it as a value

	// ---- TV watch-status rule: new episode aired since last sync ----
	const prevLast = (prev['last_air_date'] ?? '').trim().replace(/^"|"$/g, '');
	if (!isMovie && watchStatus === 'Watched' && lastAirDate && prevLast && lastAirDate > prevLast) {
		watchStatus = 'Unwatched';
	}

	return {
		title, engName, mediaType, category,
		watchStatus, rating, ratingStars,
		year: yearDisp, runtime, seasons, episodes, vod, genre: genres, status,
		language, country, director, writer, producer, contentRating,
		tmdbRating: details.vote_average ?? null, tmdbId: String(details.id),
		imdbId, releaseDate, lastAirDate, nextAirDate, lastEpisode, upcomingEpisode: upEpisode,
		poster, trailer, homepage: details.homepage ?? '',
		imdbPage: imdbId ? `https://www.imdb.com/title/${imdbId}/` : '',
		notionUrl, synopsis: details.overview ?? '',
		cast: cast.join(', '),
	};
}
