import { z } from "zod";
import { dataResult, defineTool, textResult, type ToolModule, toolModule } from "../../lib/types.js";
import { type MapsBridge, mapsBridge, type Transport } from "./bridge.js";

const transport = z
	.enum(["driving", "walking", "transit"])
	.default("driving")
	.describe("Mode of travel");

const place = z.string().trim().min(1);

const DIRFLG: Record<Transport, string> = { driving: "d", walking: "w", transit: "r" };

/** Builds the maps:// URL for open_in_maps. */
export function buildMapsUrl(args: {
	query?: string | undefined;
	from?: string | undefined;
	to?: string | undefined;
	transport: Transport;
}): string {
	const enc = encodeURIComponent;
	if (args.to) {
		const saddr = args.from ? `saddr=${enc(args.from)}&` : "";
		return `maps://?${saddr}daddr=${enc(args.to)}&dirflg=${DIRFLG[args.transport]}`;
	}
	return `maps://?q=${enc(args.query as string)}`;
}

export function createMapsModule(bridge: MapsBridge = mapsBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "search_places",
			effect: "read",
			openWorld: true,
			description:
				"Search Apple Maps for places (businesses, stations, addresses, landmarks) and " +
				"return name, address, coordinates, phone, website and category. Read-only; does " +
				"not open Maps. Without `near`, results come from the Mac's default region. `near` " +
				"is best effort: results are merged and sorted by distance to that area, but " +
				"far-away cities can yield few hits; then search for a specific name instead.",
			schema: z.object({
				query: place.describe('What to look for, e.g. "Bahnhof" or "pharmacy"'),
				near: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe(
						'Area to search around: a place name ("Hamburg") or "lat,lon" ' +
							'("53.55,9.99"; results are then sorted by distance)',
					),
				limit: z.number().int().min(1).max(25).default(5),
			}),
			async run(args) {
				const places = await bridge.searchPlaces({
					query: args.query,
					...(args.near !== undefined && { near: args.near }),
					limit: args.limit,
				});
				return dataResult(`${places.length} places for "${args.query}".`, places);
			},
		}),

		defineTool({
			name: "get_directions",
			effect: "read",
			openWorld: true,
			description:
				"Calculate a route between two places with Apple Maps data: distance, expected " +
				"travel time and (for driving and walking) turn-by-turn steps, plus alternatives. " +
				"Read-only; does not open Maps (use open_in_maps for that). Transit returns only " +
				"an estimate of distance and time. `from` and `to` are place names, addresses or " +
				'"lat,lon"; include the city to avoid ambiguity.',
			schema: z.object({
				from: place.describe('Start, e.g. "Hamburg Hauptbahnhof"'),
				to: place.describe('Destination, e.g. "Berlin Hauptbahnhof"'),
				transport,
				maxSteps: z
					.number()
					.int()
					.min(0)
					.max(200)
					.default(40)
					.describe("Cap on turn-by-turn steps returned per route"),
			}),
			async run(args) {
				const result = await bridge.getDirections({
					from: args.from,
					to: args.to,
					transport: args.transport,
				});
				const routes = result.routes.map((r) => ({
					...r,
					stepCount: r.steps.length,
					steps: r.steps.slice(0, args.maxSteps),
				}));
				const best = routes[0];
				const summary = best
					? `${args.transport} route: ${(best.distanceMeters / 1000).toFixed(1)} km, ` +
						`${Math.round(best.travelTimeSeconds / 60)} min (${routes.length} route(s)).`
					: "No route found.";
				return dataResult(summary, { ...result, routes });
			},
		}),

		defineTool({
			name: "open_in_maps",
			effect: "write",
			description:
				"UI SIDE EFFECT: opens and brings the Maps app to the front, showing a place " +
				"search or a route. Use only when the user wants to see it in Maps; for data use " +
				"search_places or get_directions. Give `query` for a place, or `to` (optionally " +
				"`from`, default current location) for a route. Cannot save favorites, guides or " +
				"pins: Maps offers no API for that.",
			schema: z
				.object({
					query: place.optional().describe("Place or address to show"),
					from: place.optional().describe("Route start (default: current location)"),
					to: place.optional().describe("Route destination"),
					transport,
				})
				.refine((a) => Boolean(a.query) !== Boolean(a.to), {
					message: "Provide either `query` (show a place) or `to` (show a route), not both",
				})
				.refine((a) => !a.from || Boolean(a.to), {
					message: "`from` requires `to`",
				}),
			// Places are personal (home, contacts' addresses): log lengths only.
			auditTarget: (a) => ({
				...(a.query !== undefined && { queryLen: a.query.length }),
				...(a.from !== undefined && { fromLen: a.from.length }),
				...(a.to !== undefined && { toLen: a.to.length }),
			}),
			async run(args) {
				const url = buildMapsUrl(args);
				await bridge.openUrl(url);
				return textResult(`Opened Maps: ${url}`);
			},
		}),
	]);
}
