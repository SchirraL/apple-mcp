import { z } from "zod";
import { confirmField, withConfirm } from "../../lib/safety.js";
import {
	dataResult,
	defineTool,
	errorResult,
	textResult,
	type ToolModule,
	toolModule,
} from "../../lib/types.js";
import {
	type MusicBridge,
	musicBridge,
	type NowPlaying,
	type Playable,
	type PlaylistInfo,
	type TrackInfo,
} from "./bridge.js";

const AUDIO = "This affects audio playback on the Mac. ";
const NOT_RUNNING = "Music is not running";

const trackIds = z
	.array(z.string().min(1))
	.min(1)
	.max(100)
	.describe("Persistent track ids as returned by music_search_library (kind track)");
const playlistRef = z
	.string()
	.min(1)
	.describe("Playlist persistent id (from music_list_playlists) or exact name");

function describePlayable(p: Playable): string {
	switch (p.kind) {
		case "track":
			return `track "${p.name}" by ${p.artist} (id ${p.id})`;
		case "playlist":
			return `playlist "${p.name}" (id ${p.id}, ${p.trackCount} tracks)`;
		case "album":
			return `album "${p.name}" by ${p.artist} (${p.trackCount} tracks)`;
		case "artist":
			return `artist "${p.name}" (${p.trackCount} tracks)`;
	}
}

function describeTrack(t: TrackInfo): string {
	return `"${t.name}" by ${t.artist}`;
}

function nowSummary(n: NowPlaying | null): string {
	if (!n) return NOT_RUNNING;
	if (!n.track) return `Player ${n.state}.`;
	return `${n.state === "playing" ? "Playing" : `Player ${n.state}:`} "${n.track.name}" by ${n.track.artist}.`;
}

async function resolvePlaylist(bridge: MusicBridge, ref: string): Promise<PlaylistInfo> {
	const found = await bridge.findPlaylists(ref);
	if (found.length === 0) {
		throw new Error(`No user playlist matches "${ref}". Use music_list_playlists to see ids.`);
	}
	if (found.length > 1) {
		const list = found.map((p) => `"${p.name}" (id ${p.id}, ${p.trackCount} tracks)`);
		throw new Error(`"${ref}" is ambiguous. Use one of these ids: ${list.join("; ")}`);
	}
	return found[0] as PlaylistInfo;
}

export function createMusicModule(bridge: MusicBridge = musicBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "music_now_playing",
			effect: "read",
			description:
				"Apple Music player state: current track (name, artist, album, duration and " +
				"position in seconds), volume 0-100, shuffle and repeat. Does not launch Music; " +
				'returns "Music is not running" if it is closed.',
			schema: z.object({}),
			async run() {
				const n = await bridge.nowPlaying();
				if (!n) return textResult(NOT_RUNNING);
				return dataResult(nowSummary(n), n);
			},
		}),

		defineTool({
			name: "music_play",
			effect: "write",
			description:
				AUDIO +
				"Starts audio in Apple Music (launches Music if needed). With no arguments it " +
				"resumes playback. To play something specific give an id (track or playlist " +
				"persistent id from music_search_library / music_list_playlists) or an exact " +
				"name plus optional kind (track, playlist, album, artist) and artist. Ambiguous " +
				"matches return an error listing candidates; retry with an id or more detail. " +
				"Albums/artists start at the first matching track.",
			schema: z
				.object({
					kind: z.enum(["track", "playlist", "album", "artist"]).optional(),
					id: z.string().min(1).optional().describe("Persistent id of a track or playlist"),
					name: z.string().min(1).optional().describe("Exact name (case-insensitive)"),
					artist: z.string().min(1).optional().describe("Disambiguates track/album names"),
				})
				.refine(
					(a) => !(a.id !== undefined && a.name !== undefined),
					"give either id or name, not both",
				)
				.refine(
					(a) => a.id !== undefined || a.name !== undefined || (!a.kind && !a.artist),
					"kind/artist need an id or a name; omit everything to resume",
				)
				.refine(
					(a) => !(a.id !== undefined && (a.kind === "album" || a.kind === "artist")),
					"ids work for track and playlist only; use name for album or artist",
				),
			async run(args) {
				if (args.id === undefined && args.name === undefined) {
					const n = await bridge.transport("play");
					return dataResult(nowSummary(n), n);
				}
				const found = await bridge.findPlayable({
					...(args.kind !== undefined && { kind: args.kind }),
					...(args.id !== undefined && { id: args.id }),
					...(args.name !== undefined && { name: args.name }),
					...(args.artist !== undefined && { artist: args.artist }),
				});
				if (found.length === 0) {
					return errorResult(
						"Nothing in the library matches. Use music_search_library or " +
							"music_list_playlists to find exact names or ids.",
					);
				}
				if (found.length > 1) {
					const shown = found.slice(0, 10).map(describePlayable);
					const more = found.length > 10 ? ` (+${found.length - 10} more)` : "";
					return errorResult(
						`Ambiguous: ${found.length} matches${more}. Retry with an id, kind or ` +
							`artist. Candidates: ${shown.join("; ")}`,
					);
				}
				const item = found[0] as Playable;
				const n = await bridge.play(item);
				return dataResult(`Started ${describePlayable(item)}.`, n);
			},
		}),

		defineTool({
			name: "music_pause",
			effect: "write",
			description: AUDIO + "Pauses Apple Music playback. Fails if Music is not running.",
			schema: z.object({}),
			async run() {
				const n = await bridge.transport("pause");
				return dataResult("Paused.", n);
			},
		}),

		defineTool({
			name: "music_next_track",
			effect: "write",
			description: AUDIO + "Skips to the next track in Apple Music.",
			schema: z.object({}),
			async run() {
				const n = await bridge.transport("next");
				return dataResult(nowSummary(n), n);
			},
		}),

		defineTool({
			name: "music_previous_track",
			effect: "write",
			description:
				AUDIO + "Goes to the previous track (or the start of the current one) in Apple Music.",
			schema: z.object({}),
			async run() {
				const n = await bridge.transport("previous");
				return dataResult(nowSummary(n), n);
			},
		}),

		defineTool({
			name: "music_set_volume",
			effect: "write",
			description:
				AUDIO +
				"Sets the Music app volume: level is absolute 0-100, delta is relative (e.g. -10, " +
				"+15); give exactly one. The result is clamped to 0-100.",
			schema: z
				.object({
					level: z.number().min(0).max(100).optional(),
					delta: z.number().min(-100).max(100).optional(),
				})
				.refine(
					(a) => (a.level === undefined) !== (a.delta === undefined),
					"provide exactly one of level or delta",
				),
			async run({ level, delta }) {
				const change = level !== undefined ? { level } : { delta: delta as number };
				const v = await bridge.setVolume(change);
				return dataResult(`Volume is now ${v}.`, { volume: v });
			},
		}),

		defineTool({
			name: "music_search_library",
			effect: "read",
			description:
				"Search the LOCAL Apple Music library (not the streaming catalog) by text in " +
				"name, artist or album. kind track returns songs with persistent ids (use them " +
				"for music_play / music_add_to_playlist); album and artist return grouped names " +
				"with track counts.",
			schema: z.object({
				query: z.string().trim().min(1).describe("Case-insensitive text"),
				kind: z.enum(["track", "album", "artist"]).default("track"),
				limit: z.number().int().min(1).max(100).default(25),
			}),
			async run({ query, kind, limit }) {
				const r = await bridge.search({ query, kind, limit });
				const n = (r.tracks ?? r.albums ?? r.artists ?? []).length;
				const more = r.truncated ? ` (more matches exist, limit ${limit})` : "";
				return dataResult(`${n} ${kind} result${n === 1 ? "" : "s"}${more}.`, r);
			},
		}),

		defineTool({
			name: "music_list_playlists",
			effect: "read",
			description:
				"List Apple Music user playlists with id and track count. Smart playlists, " +
				"folders and system playlists are skipped unless includeAll is true.",
			schema: z.object({ includeAll: z.boolean().default(false) }),
			async run({ includeAll }) {
				const pls = await bridge.listPlaylists(includeAll);
				return dataResult(`${pls.length} playlists.`, pls);
			},
		}),

		defineTool({
			name: "music_add_to_playlist",
			effect: "write",
			description:
				"Add library tracks (by persistent id) to an existing user playlist. Additive, " +
				"no confirmation needed. Smart, folder and system playlists cannot be targeted.",
			schema: z.object({ playlist: playlistRef, trackIds }),
			async run({ playlist, trackIds: ids }) {
				const pl = await resolvePlaylist(bridge, playlist);
				const added = await bridge.addToPlaylist(pl.id, ids);
				const skipped = ids.length - added;
				const note = skipped > 0 ? ` ${skipped} id(s) not found in the library.` : "";
				return dataResult(`Added ${added} track(s) to "${pl.name}".${note}`, {
					playlist: pl.name,
					added,
					skipped,
				});
			},
		}),

		defineTool({
			name: "music_create_playlist",
			effect: "write",
			description:
				"Create a new empty user playlist in Apple Music, optionally with initial " +
				"tracks. No confirmation needed.",
			schema: z.object({
				name: z.string().trim().min(1),
				description: z.string().optional(),
				trackIds: trackIds.optional(),
			}),
			async run({ name, description, trackIds: ids }) {
				const pl = await bridge.createPlaylist(name, description);
				const added = ids ? await bridge.addToPlaylist(pl.id, ids) : 0;
				return dataResult(`Created playlist "${pl.name}" with ${added} track(s).`, {
					...pl,
					trackCount: added,
				});
			},
		}),

		defineTool({
			name: "music_remove_from_playlist",
			effect: "write",
			description:
				"Remove tracks from a user playlist (the tracks stay in the library). " +
				"Requires confirm: true; otherwise returns a preview of what would be removed.",
			schema: z.object({ playlist: playlistRef, trackIds, confirm: confirmField }),
			async run({ playlist, trackIds: ids, confirm }) {
				const pl = await resolvePlaylist(bridge, playlist);
				return withConfirm(
					confirm,
					async () => {
						const tracks = await bridge.getTracks(ids);
						const list = tracks.map(describeTrack).join("; ") || "(none found)";
						return `Would remove ${tracks.length} track(s) from "${pl.name}": ${list}.`;
					},
					async () => {
						const removed = await bridge.removeFromPlaylist(pl.id, ids);
						return dataResult(`Removed ${removed} track(s) from "${pl.name}".`, {
							playlist: pl.name,
							removed,
						});
					},
				);
			},
		}),
	]);
}
