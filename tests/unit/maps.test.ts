import { describe, expect, test } from "bun:test";
import type {
	DirectionsQuery,
	DirectionsResult,
	MapsBridge,
	Place,
	SearchQuery,
} from "../../src/tools/maps/bridge.js";
import { buildMapsUrl, createMapsModule } from "../../src/tools/maps/handler.js";

const place: Place = {
	name: "Hbf",
	address: "Somewhere",
	latitude: 1,
	longitude: 2,
	phone: null,
	url: null,
	category: "MKPOICategoryPublicTransport",
};

class FakeBridge implements MapsBridge {
	searches: SearchQuery[] = [];
	directions: DirectionsQuery[] = [];
	opened: string[] = [];
	error: Error | null = null;
	steps = 3;

	async searchPlaces(q: SearchQuery): Promise<Place[]> {
		if (this.error) throw this.error;
		this.searches.push(q);
		return [place];
	}
	async getDirections(q: DirectionsQuery): Promise<DirectionsResult> {
		if (this.error) throw this.error;
		this.directions.push(q);
		return {
			from: place,
			to: place,
			transport: q.transport,
			routes: [
				{
					name: "A7",
					distanceMeters: 12_500,
					travelTimeSeconds: 1_200,
					steps: Array.from({ length: this.steps }, (_, i) => ({
						instruction: `step ${i}`,
						distanceMeters: 10,
					})),
				},
			],
			note: null,
		};
	}
	async openUrl(url: string): Promise<void> {
		if (this.error) throw this.error;
		this.opened.push(url);
	}
}

function setup() {
	const bridge = new FakeBridge();
	return { bridge, mod: createMapsModule(bridge) };
}

const text = (r: { content: { type: string; text?: string }[] }): string => r.content[0]?.text ?? "";

describe("maps tools", () => {
	test("registers the three tools with schemas", () => {
		const { mod } = setup();
		expect(mod.tools.map((t) => t.name)).toEqual([
			"search_places",
			"get_directions",
			"open_in_maps",
		]);
	});

	test("search_places passes query, near and default limit", async () => {
		const { bridge, mod } = setup();
		const r = await mod.handle("search_places", { query: "Bahnhof", near: "53.5,9.9" });
		expect(r.isError).toBeFalsy();
		expect(bridge.searches).toEqual([{ query: "Bahnhof", near: "53.5,9.9", limit: 5 }]);
		expect(text(r)).toContain("1 places");
	});

	test("search_places rejects empty query and bad limit", async () => {
		const { mod } = setup();
		expect((await mod.handle("search_places", { query: " " })).isError).toBe(true);
		expect((await mod.handle("search_places", { query: "x", limit: 100 })).isError).toBe(true);
	});

	test("get_directions defaults to driving and caps steps", async () => {
		const { bridge, mod } = setup();
		const r = await mod.handle("get_directions", { from: "A", to: "B", maxSteps: 2 });
		expect(bridge.directions[0]?.transport).toBe("driving");
		const body = text(r);
		expect(body).toContain("12.5 km");
		expect(body).toContain("20 min");
		expect(body).toContain('"stepCount": 3');
		expect(body).toContain("step 1");
		expect(body).not.toContain("step 2");
	});

	test("get_directions rejects unknown transport", async () => {
		const { mod } = setup();
		const r = await mod.handle("get_directions", { from: "A", to: "B", transport: "boat" });
		expect(r.isError).toBe(true);
	});

	test("bridge errors surface as error results", async () => {
		const { bridge, mod } = setup();
		bridge.error = new Error("Could not find start");
		const r = await mod.handle("get_directions", { from: "A", to: "B" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("Could not find start");
	});

	test("open_in_maps opens a place URL without confirmation", async () => {
		const { bridge, mod } = setup();
		const r = await mod.handle("open_in_maps", { query: "Café & Bar" });
		expect(r.isError).toBeFalsy();
		expect(bridge.opened).toEqual(["maps://?q=Caf%C3%A9%20%26%20Bar"]);
	});

	test("open_in_maps builds route URLs", () => {
		expect(buildMapsUrl({ from: "A B", to: "C", transport: "walking" })).toBe(
			"maps://?saddr=A%20B&daddr=C&dirflg=w",
		);
		expect(buildMapsUrl({ to: "C", transport: "transit" })).toBe("maps://?daddr=C&dirflg=r");
	});

	test("open_in_maps validates argument combinations", async () => {
		const { bridge, mod } = setup();
		expect((await mod.handle("open_in_maps", {})).isError).toBe(true);
		expect((await mod.handle("open_in_maps", { query: "a", to: "b" })).isError).toBe(true);
		expect((await mod.handle("open_in_maps", { from: "a", query: "b" })).isError).toBe(true);
		expect(bridge.opened).toEqual([]);
	});
});
