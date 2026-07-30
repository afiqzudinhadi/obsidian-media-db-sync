import type { WatchlistRecord } from 'packages/obsidian/src/watchlist/schema';
import { yamlList, yamlScalar, quotedOrNull } from 'packages/obsidian/src/watchlist/yaml';
import type { CustomSection } from 'packages/obsidian/src/watchlist/parse';

const CATEGORY_TAG: Record<string, string> = { Movie: 'movie', Series: 'series', Anime: 'anime' };

export function renderNote(r: WatchlistRecord, myNotes: string, customSections: CustomSection[] = []): string {
	const tag = CATEGORY_TAG[r.category];
	const stars = r.ratingStars;
	const fm = [
		'---',
		'type: watchlist_item',
		`category: ${r.category}`,
		`media_type: ${r.mediaType}`,
		`watch_status: ${r.watchStatus}`,
		`rating: ${r.rating}`,
		`rating_stars: ${stars}`,
		`year: ${r.year || ''}`,
		`runtime: ${r.runtime ? r.runtime : 'null'}`,
		`seasons: ${r.seasons ?? 'null'}`,
		`episodes: ${r.episodes ?? 'null'}`,
		`vod: ${yamlList(r.vod)}`,
		`genre: ${yamlList(r.genre)}`,
		`status: ${r.status}`,
		`language: ${yamlScalar(r.language)}`,
		`country: ${yamlScalar(r.country)}`,
		`director: ${yamlScalar(r.director.join(', '))}`,
		`writer: ${yamlScalar(r.writer.join(', '))}`,
		`producer: ${yamlScalar(r.producer.join(', '))}`,
		`content_rating: ${r.contentRating}`,
		`tmdb_rating: ${r.tmdbRating}`,
		`tmdb_id: ${r.tmdbId}`,
		`imdb_id: ${r.imdbId}`,
		`release_date: ${r.releaseDate ? r.releaseDate : 'null'}`,
		`last_air_date: ${r.lastAirDate ? r.lastAirDate : 'null'}`,
		`next_air_date: ${r.nextAirDate ? r.nextAirDate : 'null'}`,
		`last_episode: ${r.lastEpisode ? yamlScalar(r.lastEpisode) : ''}`,
		`upcoming_episode: ${r.upcomingEpisode ? yamlScalar(r.upcomingEpisode) : ''}`,
		`eng_name: ${yamlScalar(r.engName)}`,
		`poster: ${quotedOrNull(r.poster)}`,
		`trailer: ${quotedOrNull(r.trailer)}`,
		`homepage: ${quotedOrNull(r.homepage)}`,
		`imdb_page: ${quotedOrNull(r.imdbPage)}`,
		`notion_url: ${quotedOrNull(r.notionUrl)}`,
		`tags: [watchlist, ${tag}]`,
		'---',
	];
	const b: string[] = ['', `# ${r.title}`];
	if (r.engName) b.push(`*${r.engName}*`);
	b.push('');
	if (r.poster) b.push(`![poster|200](${r.poster})`, '');
	const meta = [`**${r.category}**`, ...[r.year, r.language, r.country].filter(x => x)];
	b.push(meta.join(' · '), '');
	if (r.rating !== '0' && r.rating !== '' && stars) b.push(`**Rating:** ${stars} (${r.rating}/5)`);
	b.push(`**Watch Status:** ${r.watchStatus}`);
	if (r.tmdbRating) b.push(`**TMDB Rating:** ${r.tmdbRating}/10`);
	b.push('');
	if (r.synopsis) b.push('## Synopsis', r.synopsis, '');
	const crew: string[] = [];
	if (r.director.length) crew.push(`**Director:** ${r.director.join(', ')}`);
	if (r.writer.length) crew.push(`**Writer:** ${r.writer.join(', ')}`);
	if (r.producer.length) crew.push(`**Producer:** ${r.producer.join(', ')}`);
	if (crew.length) b.push(...crew, '');
	if (r.cast) b.push('## Cast', r.cast, '');
	const links: string[] = [];
	if (r.imdbPage) links.push(`- [IMDb](${r.imdbPage})`);
	if (r.trailer) links.push(`- [Trailer](${r.trailer})`);
	if (r.homepage) links.push(`- [Homepage](${r.homepage})`);
	if (r.notionUrl) links.push(`- [Original Notion entry](${r.notionUrl})`);
	if (links.length) b.push('## Links', ...links, '');
	for (const s of customSections) b.push(`## ${s.heading}`, s.content, '');
	b.push('## My Notes', '', myNotes);
	if (myNotes) b.push('');
	return fm.join('\n') + '\n' + b.join('\n');
}
