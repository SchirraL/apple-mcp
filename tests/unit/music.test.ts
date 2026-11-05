import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolModule } from "../../src/lib/types.js";
import type {
	MusicBridge,
	NowPlaying,
	Playable,
	PlayableQuery,
	PlaylistInfo,
	SearchResult,
	TrackInfo,
	VolumeChange,
} from "../../src/tools/music/bridge.js";
import { createMusicModule } from "../../src/tools/music/handler.js";

const track: TrackInfo = { id: "T1", name: "Song", artist: "Band", album: "LP" };
const pl = (id: string, name: string): PlaylistInfo => ({
	id,
	name,
	trackCount: 3,
	smart: false,
	specialKind: "none",
});

class FakeBridge implements MusicBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;
	now: NowPlaying | null = null;
	playable: Playable[] = [];
	playlists: PlaylistInfo[] = [pl("P1", "Mix")];

	private rec(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.error) throw this.error;
	}
	callsOf(m: string): unknown[][] {
		return this.calls.filter((c) => c.method === m).map((c) => c.args);
	}
	async nowPlaying() {
		this.rec("nowPlaying");
		return this.now;
	}
	async transport(a: "play" | "pause" | "next" | "previous") {
		this.rec("transport", a);
		return this.now;
	}
	async setVolume(c: VolumeChange) {
		this.rec("setVolume", c);
		return "level" in c ? c.level : 50 + c.delta;
	}
	async search(q: { query: string; kind: "track" | "album" | "artist"; limit: number }) {
		this.rec("search", q);
		return { kind: q.kind, tracks: [track], truncated: false } as SearchResult;
	}
	async listPlaylists(all: boolean) {
		this.rec("listPlaylists", all);
		return this.playlists;
	}
	async findPlayable(q: PlayableQuery) {
		this.rec("findPlayable", q);
		return this.playable;
	}
	async play(item: Playable) {
		this.rec("play", item);
		return this.now;
	}
	async findPlaylists(ref: string) {
		this.rec("findPlaylists", ref);
		return this.playlists.filter((p) => p.id === ref || p.name === ref);
	}
	async getTracks(ids: string[]) {
		this.rec("getTracks", ids);
		return [track];
	}
	async addToPlaylist(id: string, ids: string[]) {
		this.rec("addToPlaylist", id, ids);
		return ids.length - 1;
	}
	async createPlaylist(name: string, d?: string) {
		this.rec("createPlaylist", name, d);
		return pl("P9", name);
	}
	async removeFromPlaylist(id: string, ids: string[]) {
		this.rec("removeFromPlaylist", id, ids);
		return ids.length;
	}
}

const text = (r: { content: unknown }): string =>
	(r.content as { text: string }[])[0]?.text ?? "";

describe("music module", () => {
	let bridge: FakeBridge;
	let mod: ToolModule;
	beforeEach(() => {
		bridge = new FakeBridge();
		mod = createMusicModule(bridge);
	});

	test("registers the expected tools with unique names", () => {
		const names = mod.tools.map((t) => t.name);
		expect(names).toEqual([
			"music_now_playing",
			"music_play",
			"music_pause",
			"music_next_track",
			"music_previous_track",
			"music_set_volume",
			"music_search_library",
			"music_list_playlists",
			"music_add_to_playlist",
			"music_create_playlist",
			"music_remove_from_playlist",
		]);
		for (const t of mod.tools.filter((t) => /play|pause|track$|volume/.test(t.name))) {
			if (t.name.startsWith("music_") && !/search|list|add|create|remove|now/.test(t.name)) {
				expect(t.description).toContain("audio playback");
			}
		}
	});

	test("now_playing reports not running", async () => {
		const r = await mod.handle("music_now_playing", {});
		expect(text(r)).toBe("Music is not running");
		expect(r.isError).toBeFalsy();
	});

	test("now_playing returns state", async () => {
		bridge.now = {
			state: "playing",
			volume: 40,
			shuffle: false,
			repeat: "off",
			track: { ...track, durationSeconds: 200, positionSeconds: 10 },
		};
		const r = await mod.handle("music_now_playing", {});
		expect(text(r)).toContain('Playing "Song" by Band');
	});

	test("play without args resumes", async () => {
		await mod.handle("music_play", {});
		expect(bridge.callsOf("transport")).toEqual([["play"]]);
		expect(bridge.callsOf("findPlayable")).toHaveLength(0);
	});

	test("play by name: single match plays it", async () => {
		bridge.playable = [{ kind: "playlist", id: "P1", name: "Mix", trackCount: 3 }];
		const r = await mod.handle("music_play", { name: "Mix" });
		expect(r.isError).toBeFalsy();
		expect(bridge.callsOf("play")).toHaveLength(1);
	});

	test("play by name: ambiguous lists candidates and does not play", async () => {
		bridge.playable = [
			{ kind: "album", name: "X", artist: "A", trackCount: 5 },
			{ kind: "playlist", id: "P2", name: "X", trackCount: 2 },
		];
		const r = await mod.handle("music_play", { name: "X" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("Ambiguous");
		expect(text(r)).toContain("P2");
		expect(bridge.callsOf("play")).toHaveLength(0);
	});

	test("play: not found is an error", async () => {
		const r = await mod.handle("music_play", { name: "Nope" });
		expect(r.isError).toBe(true);
	});

	test("play validates argument combinations", async () => {
		expect((await mod.handle("music_play", { id: "a", name: "b" })).isError).toBe(true);
		expect((await mod.handle("music_play", { kind: "album" })).isError).toBe(true);
		expect((await mod.handle("music_play", { id: "a", kind: "album" })).isError).toBe(true);
	});

	test("transport controls need no confirm", async () => {
		await mod.handle("music_pause", {});
		await mod.handle("music_next_track", {});
		await mod.handle("music_previous_track", {});
		expect(bridge.callsOf("transport")).toEqual([["pause"], ["next"], ["previous"]]);
	});

	test("bridge errors surface (e.g. not running)", async () => {
		bridge.error = new Error("Music is not running.");
		const r = await mod.handle("music_pause", {});
		expect(r.isError).toBe(true);
	});

	test("set_volume absolute, relative, and invalid", async () => {
		await mod.handle("music_set_volume", { level: 30 });
		await mod.handle("music_set_volume", { delta: -10 });
		expect(bridge.callsOf("setVolume")).toEqual([[{ level: 30 }], [{ delta: -10 }]]);
		expect((await mod.handle("music_set_volume", {})).isError).toBe(true);
		expect((await mod.handle("music_set_volume", { level: 1, delta: 1 })).isError).toBe(true);
		expect((await mod.handle("music_set_volume", { level: 101 })).isError).toBe(true);
	});

	test("search applies defaults and rejects empty query", async () => {
		await mod.handle("music_search_library", { query: "x" });
		expect(bridge.callsOf("search")[0]).toEqual([{ query: "x", kind: "track", limit: 25 }]);
		expect((await mod.handle("music_search_library", { query: "  " })).isError).toBe(true);
	});

	test("list_playlists passes includeAll", async () => {
		await mod.handle("music_list_playlists", { includeAll: true });
		expect(bridge.callsOf("listPlaylists")).toEqual([[true]]);
	});

	test("add_to_playlist adds without confirm and reports skipped", async () => {
		const r = await mod.handle("music_add_to_playlist", {
			playlist: "Mix",
			trackIds: ["A", "B"],
		});
		expect(r.isError).toBeFalsy();
		expect(bridge.callsOf("addToPlaylist")).toEqual([["P1", ["A", "B"]]]);
		expect(text(r)).toContain("1 id(s) not found");
	});

	test("add_to_playlist: unknown or ambiguous playlist errors", async () => {
		expect((await mod.handle("music_add_to_playlist", { playlist: "Zip", trackIds: ["A"] })).isError).toBe(true);
		bridge.playlists = [pl("P1", "Mix"), pl("P2", "Mix")];
		const r = await mod.handle("music_add_to_playlist", { playlist: "Mix", trackIds: ["A"] });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("P2");
		expect(bridge.callsOf("addToPlaylist")).toHaveLength(0);
	});

	test("create_playlist needs no confirm; adds initial tracks", async () => {
		const r = await mod.handle("music_create_playlist", { name: "New", trackIds: ["A"] });
		expect(r.isError).toBeFalsy();
		expect(bridge.callsOf("createPlaylist")).toHaveLength(1);
		expect(bridge.callsOf("addToPlaylist")).toEqual([["P9", ["A"]]]);
	});

	test("remove_from_playlist previews without confirm", async () => {
		const r = await mod.handle("music_remove_from_playlist", {
			playlist: "Mix",
			trackIds: ["T1"],
		});
		expect(text(r)).toContain("PREVIEW");
		expect(text(r)).toContain('"Song" by Band');
		expect(bridge.callsOf("removeFromPlaylist")).toHaveLength(0);
	});

	test("remove_from_playlist performs with confirm", async () => {
		const r = await mod.handle("music_remove_from_playlist", {
			playlist: "Mix",
			trackIds: ["T1"],
			confirm: true,
		});
		expect(r.isError).toBeFalsy();
		expect(bridge.callsOf("removeFromPlaylist")).toEqual([["P1", ["T1"]]]);
	});
});
