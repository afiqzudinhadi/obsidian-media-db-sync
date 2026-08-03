import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGame, renderGame, parseSteamDate, gameSpec, type GameRecord } from 'packages/obsidian/src/library/game';
import type { SpecDeps, LibraryNoteCtx } from 'packages/obsidian/src/library/types';
import steamFixture from 'tests/fixtures/steam-appdetails.json';
import rawgFixture from 'tests/fixtures/rawg-game.json';

const STEAM_DATA = steamFixture['792100'].data;
const EMPTY_PREV: Record<string, string> = {};

function makeDeps(overrides: Partial<SpecDeps> = {}): SpecDeps & { notifyCalls: string[]; logCalls: string[] } {
	const notifyCalls: string[] = [];
	const logCalls: string[] = [];
	return {
		http: async () => ({}),
		httpText: async () => '',
		getKey: () => '',
		log: (msg: string) => {
			logCalls.push(msg);
		},
		notify: (msg: string) => {
			notifyCalls.push(msg);
		},
		notifyCalls,
		logCalls,
		...overrides,
	};
}

function ctxFor(fm: Record<string, string>, body = '## My Notes\n\n'): LibraryNoteCtx {
	return { frontmatter: fm, body, filename: '7 Billion Humans.md' };
}

describe('parseSteamDate', () => {
	test('"2 Mar, 2018" -> 2018-03-02', () => {
		expect(parseSteamDate('2 Mar, 2018')).toBe('2018-03-02');
	});
	test('"31 Dec, 2020" -> 2020-12-31', () => {
		expect(parseSteamDate('31 Dec, 2020')).toBe('2020-12-31');
	});
	test('two-digit day, no leading zero needed', () => {
		expect(parseSteamDate('15 Jan, 2019')).toBe('2019-01-15');
	});
	test('garbage -> empty string', () => {
		expect(parseSteamDate('Coming soon')).toBe('');
	});
	test('empty -> empty string', () => {
		expect(parseSteamDate('')).toBe('');
	});
	test('unrecognized month -> empty string', () => {
		expect(parseSteamDate('2 Zzz, 2018')).toBe('');
	});
});

describe('buildGame (steam source) field mapping', () => {
	const r = buildGame('steam', STEAM_DATA, EMPTY_PREV);
	test('core fields', () => {
		expect(r.title).toBe('7 Billion Humans');
		expect(r.developer).toEqual(['Tomorrow Corporation']);
		expect(r.publisher).toEqual(['Tomorrow Corporation']);
		expect(r.genre).toEqual(['Casual', 'Indie', 'Strategy']);
		expect(r.releaseDate).toBe('2018-03-02');
		expect(r.metacritic).toBe(79);
		expect(r.steamAppid).toBe('792100');
		expect(r.poster).toBe('https://cdn.akamai.steamstatic.com/steam/apps/792100/header.jpg');
		expect(r.url).toBe('https://store.steampowered.com/app/792100');
	});
	test('platforms default to [PC] regardless of Steam payload', () => {
		expect(r.platforms).toEqual(['PC']);
	});
	test('rawg_id empty when prev had none', () => {
		expect(r.rawgId).toBe('');
	});
	test('rawg_id preserved from prev when steam-sourced (never dropped by steam enrich)', () => {
		const r2 = buildGame('steam', STEAM_DATA, { rawg_id: '4200' });
		expect(r2.rawgId).toBe('4200');
		expect(r2.steamAppid).toBe('792100');
	});
	test('no metacritic block -> null', () => {
		const r2 = buildGame('steam', { ...STEAM_DATA, metacritic: undefined }, EMPTY_PREV);
		expect(r2.metacritic).toBeNull();
	});
	test('no header_image -> poster null', () => {
		const r2 = buildGame('steam', { ...STEAM_DATA, header_image: undefined }, EMPTY_PREV);
		expect(r2.poster).toBeNull();
	});
});

describe('buildGame (rawg source) field mapping', () => {
	const r = buildGame('rawg', rawgFixture, EMPTY_PREV);
	test('core fields', () => {
		expect(r.title).toBe('Hollow Knight');
		expect(r.developer).toEqual(['Team Cherry']);
		expect(r.publisher).toEqual(['Team Cherry']);
		expect(r.genre).toEqual(['Action', 'Adventure', 'Indie']);
		expect(r.releaseDate).toBe('2017-02-24');
		expect(r.metacritic).toBe(90);
		expect(r.rawgId).toBe('4200');
		expect(r.poster).toBe('https://media.rawg.io/media/games/4cf/4cfc6b7f1850590a4634b08bfab308ab.jpg');
	});
	test('platforms mapped from platform.name', () => {
		expect(r.platforms).toEqual(['PC', 'macOS', 'Linux', 'Nintendo Switch']);
	});
	test('steam_appid preserved from prev when rawg-sourced (never dropped by rawg enrich)', () => {
		const r2 = buildGame('rawg', rawgFixture, { steam_appid: '792100' });
		expect(r2.steamAppid).toBe('792100');
		expect(r2.rawgId).toBe('4200');
	});
	test('steam_appid empty when prev had none', () => {
		expect(r.steamAppid).toBe('');
	});
	test('url falls back to prev url when set', () => {
		const r2 = buildGame('rawg', rawgFixture, { url: 'https://store.steampowered.com/app/999' });
		expect(r2.url).toBe('https://store.steampowered.com/app/999');
	});
	test('url falls back to rawg id-based link when no prev url', () => {
		expect(r.url).toBe('https://rawg.io/games/4200');
	});
	test('no platforms array -> empty', () => {
		const r2 = buildGame('rawg', { ...rawgFixture, platforms: undefined }, EMPTY_PREV);
		expect(r2.platforms).toEqual([]);
	});
});

describe('buildGame user-field preservation', () => {
	test('play_status defaults to Unplayed', () => {
		expect(buildGame('steam', STEAM_DATA, EMPTY_PREV).playStatus).toBe('Unplayed');
	});
	test('play_status carried from prev', () => {
		expect(buildGame('steam', STEAM_DATA, { play_status: 'Played' }).playStatus).toBe('Played');
	});
	test('rating/rating_stars carried from prev', () => {
		const prev = { rating: '4', rating_stars: '⭐️⭐️⭐️⭐️' };
		const r = buildGame('steam', STEAM_DATA, prev);
		expect(r.rating).toBe('4');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️⭐️');
	});
});

describe('buildGame skeleton conversion', () => {
	test('played: true -> play_status Played', () => {
		expect(buildGame('steam', STEAM_DATA, { played: 'true', personalRating: '' }).playStatus).toBe('Played');
	});
	test('played: false -> play_status Unplayed', () => {
		expect(buildGame('steam', STEAM_DATA, { played: 'false', personalRating: '' }).playStatus).toBe('Unplayed');
	});
	test('personalRating 3 -> rating 3 + 3 stars', () => {
		const r = buildGame('steam', STEAM_DATA, { played: 'false', personalRating: '3' });
		expect(r.rating).toBe('3');
		expect(r.ratingStars).toBe('⭐️⭐️⭐️');
	});
	test('empty personalRating -> rating 0, no stars', () => {
		const r = buildGame('steam', STEAM_DATA, { played: 'false', personalRating: '' });
		expect(r.rating).toBe('0');
		expect(r.ratingStars).toBe('');
	});
});

describe('renderGame golden', () => {
	const RECORD: GameRecord = {
		title: '7 Billion Humans',
		playStatus: 'Played',
		rating: '4',
		ratingStars: '⭐️⭐️⭐️⭐️',
		developer: ['Tomorrow Corporation'],
		publisher: ['Tomorrow Corporation'],
		platforms: ['PC'],
		genre: ['Casual', 'Indie', 'Strategy'],
		releaseDate: '2018-03-02',
		metacritic: 79,
		steamAppid: '792100',
		rawgId: '',
		poster: 'https://cdn.akamai.steamstatic.com/steam/apps/792100/header.jpg',
		url: 'https://store.steampowered.com/app/792100',
		description: 'From the creators of Human Resource Machine! Program a workforce of dumb humans to do your bidding in this fiendish puzzle game.',
	};

	test('matches canonical game fixture byte-for-byte', () => {
		const expected = readFileSync(join(import.meta.dir, 'fixtures', 'canonical-game.md'), 'utf-8');
		expect(renderGame(RECORD, '', [])).toBe(expected);
	});

	test('custom section (Collection) placed after facts, before My Notes', () => {
		const out = renderGame(RECORD, '', [{ heading: 'Collection', content: 'Part of [[Games]]' }]);
		const platformsIdx = out.indexOf('**Platforms:**');
		const collectionIdx = out.indexOf('## Collection');
		const myNotesIdx = out.indexOf('## My Notes');
		expect(collectionIdx).toBeGreaterThan(platformsIdx);
		expect(myNotesIdx).toBeGreaterThan(collectionIdx);
		expect(out).toContain('## Collection\nPart of [[Games]]\n');
	});

	test('My Notes content preserved', () => {
		const out = renderGame(RECORD, 'played co-op with a friend');
		expect(out).toContain('## My Notes\n\nplayed co-op with a friend');
	});

	test('rating line present when rating set', () => {
		expect(renderGame(RECORD, '')).toContain('**Rating:** ⭐️⭐️⭐️⭐️ (4/5)');
	});

	test('rating 0 -> Rating line absent', () => {
		const r = { ...RECORD, rating: '0', ratingStars: '' };
		expect(renderGame(r, '')).not.toContain('**Rating:**');
	});

	test('links present w/ steam appid', () => {
		expect(renderGame(RECORD, '')).toContain('- [Steam](https://store.steampowered.com/app/792100/)');
	});

	test('links absent when no ids', () => {
		const r = { ...RECORD, steamAppid: '', rawgId: '', url: '' };
		const out = renderGame(r, '');
		expect(out).not.toContain('## Links');
	});

	test('rawg link uses url field verbatim when rawg_id set', () => {
		const r = { ...RECORD, steamAppid: '', rawgId: '4200', url: 'https://rawg.io/games/4200' };
		const out = renderGame(r, '');
		expect(out).toContain('- [RAWG](https://rawg.io/games/4200)');
		expect(out).not.toContain('[Steam]');
	});

	test('both ids set -> both Steam and RAWG links present', () => {
		const r = { ...RECORD, rawgId: '4200', url: 'https://rawg.io/games/4200' };
		const out = renderGame(r, '');
		expect(out).toContain('- [Steam](https://store.steampowered.com/app/792100/)');
		expect(out).toContain('- [RAWG](https://rawg.io/games/4200)');
	});

	test('no poster -> poster line omitted', () => {
		const r = { ...RECORD, poster: null };
		expect(renderGame(r, '')).not.toContain('![poster');
	});

	test('no description -> Synopsis section omitted', () => {
		const r = { ...RECORD, description: '' };
		expect(renderGame(r, '')).not.toContain('## Synopsis');
	});

	test('no developer/publisher/platforms -> fact lines omitted entirely', () => {
		const r = { ...RECORD, developer: [], publisher: [], platforms: [] };
		const out = renderGame(r, '');
		expect(out).not.toContain('**Developer:**');
		expect(out).not.toContain('**Publisher:**');
		expect(out).not.toContain('**Platforms:**');
	});

	test('no release_date/metacritic -> meta line is just **Game**', () => {
		const r = { ...RECORD, releaseDate: '', metacritic: null };
		const out = renderGame(r, '');
		expect(out).toContain('\n**Game**\n');
	});
});

describe('gameSpec.hasId', () => {
	test('steam_appid set -> true', () => expect(gameSpec.hasId({ steam_appid: '792100' })).toBe(true));
	test('rawg_id set -> true', () => expect(gameSpec.hasId({ rawg_id: '4200' })).toBe(true));
	test('both set -> true', () => expect(gameSpec.hasId({ steam_appid: '792100', rawg_id: '4200' })).toBe(true));
	test('both empty -> false', () => expect(gameSpec.hasId({ steam_appid: '', rawg_id: '' })).toBe(false));
	test('both missing -> false', () => expect(gameSpec.hasId({})).toBe(false));
});

describe('gameSpec.isActive', () => {
	test('both ids empty -> active (needs first pass)', () => {
		expect(gameSpec.isActive({})).toBe(true);
	});
	test('steam_appid set + play_status set -> static', () => {
		expect(gameSpec.isActive({ steam_appid: '792100', play_status: 'Unplayed' })).toBe(false);
	});
	test('rawg_id set + play_status set -> static', () => {
		expect(gameSpec.isActive({ rawg_id: '4200', play_status: 'Unplayed' })).toBe(false);
	});
	test('both ids set -> static, regardless of play_status', () => {
		expect(gameSpec.isActive({ steam_appid: '792100', rawg_id: '4200', play_status: 'Played' })).toBe(false);
	});
	test('id set, play_status missing (post-resolve skeleton) -> active (C1)', () => {
		expect(gameSpec.isActive({ steam_appid: '792100' })).toBe(true);
	});
	test('both ids set, play_status missing (post-resolve skeleton) -> active (C1)', () => {
		expect(gameSpec.isActive({ steam_appid: '792100', rawg_id: '4200' })).toBe(true);
	});
	test('canonical enriched note -> static', () => {
		expect(gameSpec.isActive({ steam_appid: '792100', rawg_id: '4200', play_status: 'Played' })).toBe(false);
	});
});

describe('gameSpec.resolve', () => {
	test('steam store url in frontmatter -> appid parsed, zero network calls', async () => {
		let httpCalls = 0;
		const deps = makeDeps({
			http: async () => {
				httpCalls++;
				return {};
			},
		});
		const result = await gameSpec.resolve(ctxFor({ url: 'https://store.steampowered.com/app/792100/7_Billion_Humans/', title: '7 Billion Humans' }), deps);
		expect(result).toEqual({ steam_appid: '792100' });
		expect(httpCalls).toBe(0);
	});

	test('no url match, steam storesearch unique exact -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ items: [{ id: 792100, name: '7 Billion Humans' }] }),
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toEqual({ steam_appid: '792100' });
	});

	test('no exact match, sole steam result -> accepted', async () => {
		const deps = makeDeps({
			http: async () => ({ items: [{ id: 999, name: 'Some Other Game' }] }),
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toEqual({ steam_appid: '999' });
	});

	test('steam storesearch ambiguous, no key -> null, logged', async () => {
		const deps = makeDeps({
			http: async () => ({
				items: [
					{ id: 1, name: 'Foo' },
					{ id: 2, name: 'Bar' },
				],
			}),
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.some(m => m.includes('RAWG'))).toBe(true);
	});

	test('steam storesearch throws -> falls through to RAWG', async () => {
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('steampowered')) throw new Error('steam down');
				return { results: [{ id: 4200, name: '7 Billion Humans' }] };
			},
			getKey: () => 'rawgkey',
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toEqual({ rawg_id: '4200' });
		expect(deps.logCalls.some(m => m.includes('storesearch'))).toBe(true);
	});

	test('no steam results, RAWG key present, unique exact -> rawg_id accepted', async () => {
		const deps = makeDeps({
			http: async (url: string) => (url.includes('steampowered') ? { items: [] } : { results: [{ id: 4200, name: '7 Billion Humans' }] }),
			getKey: () => 'rawgkey',
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toEqual({ rawg_id: '4200' });
	});

	test('no steam results, RAWG key missing -> null, logged, no RAWG call attempted', async () => {
		let rawgCalled = false;
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('rawg')) rawgCalled = true;
				return { items: [] };
			},
			getKey: () => '',
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toBeNull();
		expect(rawgCalled).toBe(false);
		expect(deps.logCalls.some(m => m.toLowerCase().includes('key'))).toBe(true);
	});

	test('RAWG throws -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async (url: string) => {
				if (url.includes('steampowered')) return { items: [] };
				throw new Error('rawg down');
			},
			getKey: () => 'rawgkey',
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toBeNull();
	});

	test('RAWG ambiguous -> null', async () => {
		const deps = makeDeps({
			http: async (url: string) =>
				url.includes('steampowered')
					? { items: [] }
					: {
							results: [
								{ id: 1, name: 'Foo' },
								{ id: 2, name: 'Bar' },
							],
						},
			getKey: () => 'rawgkey',
		});
		const result = await gameSpec.resolve(ctxFor({ title: '7 Billion Humans' }), deps);
		expect(result).toBeNull();
	});

	test('no title, no filename fallback -> null (empty query guard)', async () => {
		const deps = makeDeps();
		const ctx: LibraryNoteCtx = { frontmatter: {}, body: '', filename: '.md' };
		const result = await gameSpec.resolve(ctx, deps);
		expect(result).toBeNull();
	});
});

describe('gameSpec.sync — no ids', () => {
	test('no steam_appid, no rawg_id -> null (needs resolve first)', async () => {
		const deps = makeDeps();
		const result = await gameSpec.sync(ctxFor({}), deps);
		expect(result).toBeNull();
	});
});

describe('gameSpec.sync — steam enrich', () => {
	test('success -> canonical fm rendered, platforms [PC], flipped always false', async () => {
		const deps = makeDeps({ http: async () => steamFixture });
		const result = await gameSpec.sync(ctxFor({ steam_appid: '792100', play_status: 'Played' }), deps);
		expect(result).not.toBeNull();
		expect(result!.flipped).toBe(false);
		expect(result!.content).toContain('type: game_item');
		expect(result!.content).toContain('steam_appid: 792100');
		expect(result!.content).toContain('platforms: [PC]');
		expect(result!.content).toContain('release_date: 2018-03-02');
		expect(result!.content).toContain('metacritic: 79');
	});

	test('steam appdetails fetch throws -> log, return null (no throw)', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('network down');
			},
		});
		const result = await gameSpec.sync(ctxFor({ steam_appid: '792100' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});

	test('success:false, no rawg_id -> identity-guard: log, return null (no write)', async () => {
		const deps = makeDeps({ http: async () => ({ '792100': { success: false } }) });
		const result = await gameSpec.sync(ctxFor({ steam_appid: '792100' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.some(m => m.includes('792100'))).toBe(true);
	});

	test('success:false, rawg_id set but no key -> log, return null', async () => {
		const deps = makeDeps({ http: async () => ({ '792100': { success: false } }) });
		const result = await gameSpec.sync(ctxFor({ steam_appid: '792100', rawg_id: '4200' }), deps);
		expect(result).toBeNull();
	});

	test('success:false, rawg_id set + key -> falls to RAWG detail, steam_appid preserved in output', async () => {
		const deps = makeDeps({
			http: async (url: string) => (url.includes('steampowered') ? { '792100': { success: false } } : rawgFixture),
			getKey: () => 'rawgkey',
		});
		const result = await gameSpec.sync(ctxFor({ steam_appid: '792100', rawg_id: '4200' }), deps);
		expect(result).not.toBeNull();
		expect(result!.content).toContain('steam_appid: 792100');
		expect(result!.content).toContain('rawg_id: 4200');
		expect(result!.content).toContain('platforms: [PC, macOS, Linux, Nintendo Switch]');
	});

	test('play_status/rating preserved through steam enrich', async () => {
		const deps = makeDeps({ http: async () => steamFixture });
		const fm = { steam_appid: '792100', play_status: 'Played', rating: '4', rating_stars: '⭐️⭐️⭐️⭐️' };
		const result = await gameSpec.sync(ctxFor(fm), deps);
		expect(result!.content).toContain('play_status: Played');
		expect(result!.content).toContain('rating: 4');
		expect(result!.content).toContain('rating_stars: ⭐️⭐️⭐️⭐️');
	});

	test('My Notes content preserved through sync', async () => {
		const deps = makeDeps({ http: async () => steamFixture });
		const result = await gameSpec.sync(ctxFor({ steam_appid: '792100' }, '## My Notes\n\nco-op is great'), deps);
		expect(result!.content).toContain('## My Notes\n\nco-op is great');
	});

	test('user-added ## Links section in body is owned/replaced by computed links; other custom sections unaffected', async () => {
		const deps = makeDeps({ http: async () => steamFixture });
		const body = '## Links\n- [Old link](https://example.com)\n\n## Collection\nPart of [[Games]]\n\n## My Notes\n\n';
		const result = await gameSpec.sync(ctxFor({ steam_appid: '792100' }, body), deps);
		const content = result!.content;
		expect((content.match(/## Links/g) ?? []).length).toBe(1);
		expect(content).toContain('- [Steam](https://store.steampowered.com/app/792100/)');
		expect(content).not.toContain('Old link');
		expect(content).toContain('## Collection\nPart of [[Games]]\n');
	});
});

describe('gameSpec.sync — rawg enrich', () => {
	test('rawg_id only, key present -> success, canonical fm rendered', async () => {
		const deps = makeDeps({ http: async () => rawgFixture, getKey: () => 'rawgkey' });
		const result = await gameSpec.sync(ctxFor({ rawg_id: '4200' }), deps);
		expect(result).not.toBeNull();
		expect(result!.content).toContain('rawg_id: 4200');
		expect(result!.content).toContain('type: game_item');
	});

	test('rawg_id only, no key -> log, return null', async () => {
		const deps = makeDeps({ getKey: () => '' });
		const result = await gameSpec.sync(ctxFor({ rawg_id: '4200' }), deps);
		expect(result).toBeNull();
		expect(deps.logCalls.length).toBeGreaterThan(0);
	});

	test('rawg_id only, fetch throws -> log, return null', async () => {
		const deps = makeDeps({
			http: async () => {
				throw new Error('rawg down');
			},
			getKey: () => 'rawgkey',
		});
		const result = await gameSpec.sync(ctxFor({ rawg_id: '4200' }), deps);
		expect(result).toBeNull();
	});

	test('rawg detail returns malformed/empty data -> null, no write', async () => {
		const deps = makeDeps({ http: async () => ({}), getKey: () => 'rawgkey' });
		const result = await gameSpec.sync(ctxFor({ rawg_id: '4200' }), deps);
		expect(result).toBeNull();
	});
});
