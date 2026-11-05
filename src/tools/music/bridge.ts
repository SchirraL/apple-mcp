import { runJxa } from "../../lib/applescript.js";

// Music has no public framework for the local library, so this uses the Music scripting
// dictionary via JXA with batched property reads (`tracks.whose(...).name()` returns an
// array in one Apple event). Never launches Music for read operations.

export type PlayerState = "playing" | "paused" | "stopped" | "fast forwarding" | "rewinding";

export interface TrackInfo {
	/** Persistent id (hex), stable across sessions. */
	id: string;
	name: string;
	artist: string;
	album: string;
}

export interface NowPlaying {
	state: string;
	volume: number;
	shuffle: boolean;
	repeat: string;
	track: (TrackInfo & { durationSeconds: number; positionSeconds: number }) | null;
}

export type SearchKind = "track" | "album" | "artist";

export interface AlbumHit {
	album: string;
	artist: string;
	trackCount: number;
}
export interface ArtistHit {
	artist: string;
	trackCount: number;
}

export interface SearchResult {
	kind: SearchKind;
	/** Tracks (kind track), albums (kind album) or artists (kind artist). */
	tracks?: TrackInfo[];
	albums?: AlbumHit[];
	artists?: ArtistHit[];
	/** True when more matches existed than were returned. */
	truncated: boolean;
}

export interface PlaylistInfo {
	id: string;
	name: string;
	trackCount: number;
	smart: boolean;
	/** "none" for ordinary user playlists, otherwise the special kind (folder, Music, ...). */
	specialKind: string;
}

/** Something playable, as found by `findPlayable`. */
export type Playable =
	| { kind: "track"; id: string; name: string; artist: string; album: string }
	| { kind: "playlist"; id: string; name: string; trackCount: number }
	| { kind: "album"; name: string; artist: string; trackCount: number }
	| { kind: "artist"; name: string; trackCount: number };

export interface PlayableQuery {
	kind?: "track" | "playlist" | "album" | "artist";
	/** Persistent id of a track or playlist. */
	id?: string;
	/** Exact (case-insensitive) name. */
	name?: string;
	/** Narrows albums/tracks by artist. */
	artist?: string;
}

export type VolumeChange = { level: number } | { delta: number };

export interface MusicBridge {
	/** null when Music is not running (it is not launched). */
	nowPlaying(): Promise<NowPlaying | null>;
	/** "play" launches Music if needed; the others throw if it is not running. */
	transport(action: "play" | "pause" | "next" | "previous"): Promise<NowPlaying | null>;
	setVolume(change: VolumeChange): Promise<number>;
	search(q: { query: string; kind: SearchKind; limit: number }): Promise<SearchResult>;
	listPlaylists(includeAll: boolean): Promise<PlaylistInfo[]>;
	findPlayable(q: PlayableQuery): Promise<Playable[]>;
	play(item: Playable): Promise<NowPlaying | null>;
	/** User playlists (non-folder, non-smart) matching id or exact name. */
	findPlaylists(ref: string): Promise<PlaylistInfo[]>;
	/** Resolve track ids; ids not in the library are missing from the result. */
	getTracks(ids: string[]): Promise<TrackInfo[]>;
	addToPlaylist(playlistId: string, trackIds: string[]): Promise<number>;
	createPlaylist(name: string, description?: string): Promise<PlaylistInfo>;
	removeFromPlaylist(playlistId: string, trackIds: string[]): Promise<number>;
}

type Op =
	| { op: "now" }
	| { op: "transport"; action: "play" | "pause" | "next" | "previous" }
	| { op: "volume"; change: VolumeChange }
	| { op: "search"; query: string; kind: SearchKind; limit: number }
	| { op: "playlists"; includeAll: boolean }
	| { op: "find"; q: PlayableQuery }
	| { op: "play"; item: Playable }
	| { op: "findPlaylists"; ref: string }
	| { op: "getTracks"; ids: string[] }
	| { op: "add"; playlistId: string; trackIds: string[] }
	| { op: "create"; name: string; description?: string }
	| { op: "remove"; playlistId: string; trackIds: string[] };

/** Runs inside osascript (JXA). Must stay fully self-contained. */
function musicScript(a: Op): unknown {
	const app = Application("Music");

	// Only "play" may launch Music; everything else reports notRunning instead.
	const mayLaunch = a.op === "play" || (a.op === "transport" && a.action === "play");
	if (!mayLaunch && !app.running()) return { notRunning: true };

	const lib = () => app.libraryPlaylists[0];
	const eq = (s: string) => ({ _equals: s });
	const num = (v: any, d = 0) => {
		const n = Number(v);
		return isNaN(n) ? d : n;
	};
	const trackRows = (spec: any, max: number) => {
		const ids = spec.persistentID();
		const names = spec.name();
		const artists = spec.artist();
		const albums = spec.album();
		const out: any[] = [];
		for (let i = 0; i < ids.length && i < max; i++) {
			out.push({ id: ids[i], name: names[i], artist: artists[i], album: albums[i] });
		}
		return out;
	};
	const trackById = (id: string) => {
		const found = lib().tracks.whose({ persistentID: id });
		return found.length > 0 ? found[0] : null;
	};
	const playlistInfo = (p: any) => {
		let count = 0;
		try {
			count = p.tracks().length;
		} catch (e) {
			count = 0;
		}
		let smart = false;
		try {
			smart = Boolean(p.smart());
		} catch (e) {
			smart = false;
		}
		return {
			id: p.persistentID(),
			name: p.name(),
			trackCount: count,
			smart,
			specialKind: String(p.specialKind()),
		};
	};
	const isPlain = (kind: string, smart: boolean) =>
		!smart && (kind === "none" || kind === "");
	const userPlaylistsPlain = () => {
		const out: any[] = [];
		const pls = app.userPlaylists;
		const ids = pls.persistentID();
		const kinds = pls.specialKind();
		const smarts = pls.smart();
		for (let i = 0; i < ids.length; i++) {
			if (isPlain(String(kinds[i]), Boolean(smarts[i]))) out.push(pls[i]);
		}
		return out;
	};

	const now = () => {
		let track: any = null;
		const state = String(app.playerState());
		if (state !== "stopped") {
			try {
				const t = app.currentTrack;
				track = {
					id: t.persistentID(),
					name: t.name(),
					artist: t.artist(),
					album: t.album(),
					durationSeconds: num(t.duration()),
					positionSeconds: num(app.playerPosition()),
				};
			} catch (e) {
				track = null; // e.g. streaming radio without a library track
			}
		}
		return {
			state,
			volume: num(app.soundVolume()),
			shuffle: Boolean(app.shuffleEnabled()),
			repeat: String(app.songRepeat()),
			track,
		};
	};

	switch (a.op) {
		case "now":
			return now();

		case "transport": {
			if (a.action === "play") app.play();
			else if (a.action === "pause") app.pause();
			else if (a.action === "next") app.nextTrack();
			else app.previousTrack();
			return now();
		}

		case "volume": {
			const cur = num(app.soundVolume());
			const target = "level" in a.change ? a.change.level : cur + a.change.delta;
			const v = Math.max(0, Math.min(100, Math.round(target)));
			app.soundVolume = v;
			return { volume: v };
		}

		case "search": {
			// Batch-read once and filter in JS: `whose({_or: …})` fails with "Can't convert
			// types", and any batched read on an empty track list throws "Can't get object".
			const tracks = lib().tracks;
			const empty = a.kind === "track"
				? { kind: "track", tracks: [], truncated: false }
				: { kind: a.kind, truncated: false, [a.kind === "album" ? "albums" : "artists"]: [] };
			if (tracks.length === 0) return empty;
			const ids = tracks.persistentID();
			const names = tracks.name();
			const artists = tracks.artist();
			const albums = tracks.album();
			const albumArtists = tracks.albumArtist();
			const needle = a.query.toLowerCase();
			const has = (v: any) => String(v || "").toLowerCase().indexOf(needle) !== -1;
			const hits: number[] = [];
			for (let i = 0; i < ids.length; i++) {
				const ok =
					a.kind === "album"
						? has(albums[i])
						: a.kind === "artist"
							? has(artists[i]) || has(albumArtists[i])
							: has(names[i]) || has(artists[i]) || has(albums[i]);
				if (ok) hits.push(i);
			}
			if (a.kind === "track") {
				const rows = hits.slice(0, a.limit).map((i) => ({
					id: ids[i],
					name: names[i],
					artist: artists[i],
					album: albums[i],
				}));
				return { kind: "track", tracks: rows, truncated: hits.length > a.limit };
			}
			const groups: { [k: string]: any } = {};
			const order: string[] = [];
			for (const i of hits) {
				const artist = albumArtists[i] || artists[i];
				const key = a.kind === "album" ? albums[i] + "\u0000" + artist : artists[i];
				if (!groups[key]) {
					groups[key] =
						a.kind === "album"
							? { album: albums[i], artist, trackCount: 0 }
							: { artist: artists[i], trackCount: 0 };
					order.push(key);
				}
				groups[key].trackCount++;
			}
			const list = order.slice(0, a.limit).map((k) => groups[k]);
			const res: any = { kind: a.kind, truncated: order.length > a.limit };
			if (a.kind === "album") res.albums = list;
			else res.artists = list;
			return res;
		}

		case "playlists": {
			const pls = app.userPlaylists;
			const ids = pls.persistentID();
			const kinds = pls.specialKind();
			const smarts = pls.smart();
			const out: any[] = [];
			for (let i = 0; i < ids.length; i++) {
				const kind = String(kinds[i]);
				const smart = Boolean(smarts[i]);
				if (a.includeAll || isPlain(kind, smart)) out.push(playlistInfo(pls[i]));
			}
			return out;
		}

		case "findPlaylists": {
			const out: any[] = [];
			for (const p of userPlaylistsPlain()) {
				if (p.persistentID() === a.ref || p.name().toLowerCase() === a.ref.toLowerCase()) {
					out.push(playlistInfo(p));
				}
			}
			return out;
		}

		case "getTracks": {
			const out: any[] = [];
			for (const id of a.ids) {
				const t = trackById(id);
				if (t) {
					out.push({
						id: t.persistentID(),
						name: t.name(),
						artist: t.artist(),
						album: t.album(),
					});
				}
			}
			return out;
		}

		case "find": {
			const q = a.q;
			const out: any[] = [];
			const wants = (k: string) => !q.kind || q.kind === k;
			const sameArtist = (s: string) =>
				!q.artist || String(s).toLowerCase() === q.artist.toLowerCase();
			if (q.id) {
				if (wants("track")) {
					const t = trackById(q.id);
					if (t) {
						out.push({
							kind: "track",
							id: t.persistentID(),
							name: t.name(),
							artist: t.artist(),
							album: t.album(),
						});
					}
				}
				if (wants("playlist")) {
					for (const p of app.userPlaylists.whose({ persistentID: q.id })()) {
						out.push({
							kind: "playlist",
							id: p.persistentID(),
							name: p.name(),
							trackCount: p.tracks().length,
						});
					}
				}
				return out;
			}
			const name = q.name as string;
			if (wants("track")) {
				const spec = lib().tracks.whose({ name: eq(name) });
				const artists = spec.artist();
				const rows = trackRows(spec, 20);
				for (let i = 0; i < rows.length; i++) {
					if (sameArtist(artists[i])) out.push({ kind: "track", ...rows[i] });
				}
			}
			if (wants("playlist") && !q.artist) {
				for (const p of userPlaylistsPlain()) {
					if (p.name().toLowerCase() === name.toLowerCase()) {
						out.push({
							kind: "playlist",
							id: p.persistentID(),
							name: p.name(),
							trackCount: p.tracks().length,
						});
					}
				}
			}
			if (wants("album")) {
				const spec = lib().tracks.whose({ album: eq(name) });
				const albums = spec.album();
				const artists = spec.artist();
				const albumArtists = spec.albumArtist();
				const seen: { [k: string]: any } = {};
				for (let i = 0; i < albums.length; i++) {
					const who = albumArtists[i] || artists[i];
					if (!sameArtist(who) && !sameArtist(artists[i])) continue;
					const key = albums[i] + "\u0000" + who;
					if (!seen[key]) {
						seen[key] = { kind: "album", name: albums[i], artist: who, trackCount: 0 };
						out.push(seen[key]);
					}
					seen[key].trackCount++;
				}
			}
			if (wants("artist") && !q.artist) {
				const spec = lib().tracks.whose({ artist: eq(name) });
				const artists = spec.artist();
				if (artists.length > 0) {
					out.push({ kind: "artist", name: artists[0], trackCount: artists.length });
				}
			}
			return out;
		}

		case "play": {
			const it = a.item;
			if (it.kind === "track") {
				const t = trackById(it.id);
				if (!t) throw new Error("Track not found in the library.");
				app.play(t);
			} else if (it.kind === "playlist") {
				const found = app.userPlaylists.whose({ persistentID: it.id });
				if (found.length === 0) throw new Error("Playlist not found.");
				app.play(found[0]);
			} else {
				// Album / artist: play the first track in album order; Music continues from
				// there in its current context (there is no scripting "album object").
				const spec =
					it.kind === "album"
						? lib().tracks.whose({ album: eq(it.name) })
						: lib().tracks.whose({ artist: eq(it.name) });
				const ids = spec.persistentID();
				if (ids.length === 0) throw new Error("Nothing found in the library.");
				const discs = spec.discNumber();
				const nums = spec.trackNumber();
				const artists = spec.artist();
				const albumArtists = spec.albumArtist();
				let best = -1;
				let bestOrder = 0;
				for (let i = 0; i < ids.length; i++) {
					if (it.kind === "album" && it.artist) {
						if (String(artists[i]).toLowerCase() !== it.artist.toLowerCase()) {
							if (String(albumArtists[i]).toLowerCase() !== it.artist.toLowerCase()) continue;
						}
					}
					const order = num(discs[i]) * 1000 + num(nums[i]);
					if (best < 0 || order < bestOrder) {
						best = i;
						bestOrder = order;
					}
				}
				if (best < 0) throw new Error("Nothing found in the library.");
				app.play(trackById(ids[best]));
			}
			return now();
		}

		case "add": {
			const found = app.userPlaylists.whose({ persistentID: a.playlistId });
			if (found.length === 0) throw new Error("Playlist not found.");
			const pl = found[0];
			let added = 0;
			for (const id of a.trackIds) {
				const t = trackById(id);
				if (!t) continue;
				app.duplicate(t, { to: pl });
				added++;
			}
			return { count: added };
		}

		case "create": {
			const props: { [k: string]: string } = { name: a.name };
			if (a.description) props.description = a.description;
			const p = app.make({ new: "playlist", withProperties: props });
			return playlistInfo(p);
		}

		case "remove": {
			const found = app.userPlaylists.whose({ persistentID: a.playlistId });
			if (found.length === 0) throw new Error("Playlist not found.");
			const pl = found[0];
			let removed = 0;
			for (const id of a.trackIds) {
				const inList = pl.tracks.whose({ persistentID: id });
				if (inList.length === 0) continue;
				app.delete(inList[0]); // removes from the playlist only, not the library
				removed++;
			}
			return { count: removed };
		}
	}
	return null;
}

async function run<R>(op: Op): Promise<R | null> {
	const out = await runJxa(musicScript, op, { app: "Music", timeoutMs: 30_000 });
	if (out && typeof out === "object" && (out as { notRunning?: boolean }).notRunning) {
		if (op.op === "now") return null;
		throw new Error("Music is not running. Open Music first (or call music_play).");
	}
	return out as R;
}

export const musicBridge: MusicBridge = {
	nowPlaying: () => run<NowPlaying>({ op: "now" }),
	transport: (action) => run<NowPlaying>({ op: "transport", action }),
	async setVolume(change) {
		const r = await run<{ volume: number }>({ op: "volume", change });
		return (r as { volume: number }).volume;
	},
	async search(q) {
		return (await run<SearchResult>({ op: "search", ...q })) as SearchResult;
	},
	async listPlaylists(includeAll) {
		return (await run<PlaylistInfo[]>({ op: "playlists", includeAll })) ?? [];
	},
	async findPlayable(q) {
		return (await run<Playable[]>({ op: "find", q })) ?? [];
	},
	play: (item) => run<NowPlaying>({ op: "play", item }),
	async findPlaylists(ref) {
		return (await run<PlaylistInfo[]>({ op: "findPlaylists", ref })) ?? [];
	},
	async getTracks(ids) {
		return (await run<TrackInfo[]>({ op: "getTracks", ids })) ?? [];
	},
	async addToPlaylist(playlistId, trackIds) {
		const r = await run<{ count: number }>({ op: "add", playlistId, trackIds });
		return (r as { count: number }).count;
	},
	async createPlaylist(name, description) {
		const r = await run<PlaylistInfo>({
			op: "create",
			name,
			...(description !== undefined && { description }),
		});
		return r as PlaylistInfo;
	},
	async removeFromPlaylist(playlistId, trackIds) {
		const r = await run<{ count: number }>({ op: "remove", playlistId, trackIds });
		return (r as { count: number }).count;
	},
};
