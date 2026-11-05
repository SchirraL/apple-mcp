import { execFile } from "node:child_process";
import { OsaError, runJxa } from "../../lib/applescript.js";

// Implemented with MapKit via the JXA ObjC bridge (MKLocalSearch / MKDirections). Maps.app
// itself has almost no scripting dictionary, so reading anything from it is not possible.
// Measured: place search ~0.7s, driving/walking route with steps ~0.3-3s.
// Limits found while probing: MKLocalSearchRequest.region (a struct) cannot be set from
// JXA, so "near" is best effort (merge plain + city-qualified queries, sort by distance); MKDirections has no
// transit routes on macOS (MKErrorDomain 5), so transit falls back to an ETA (no steps).

export type Transport = "driving" | "walking" | "transit";

export interface Place {
	name: string;
	address: string;
	latitude: number | null;
	longitude: number | null;
	phone: string | null;
	url: string | null;
	category: string | null;
	/** Distance from the `near` area, when that could be located. */
	distanceMeters?: number | null;
}

export interface SearchQuery {
	query: string;
	/** "lat,lon" or free text such as a city name. */
	near?: string;
	limit: number;
}

export interface DirectionsQuery {
	from: string;
	to: string;
	transport: Transport;
}

export interface RouteStep {
	instruction: string;
	distanceMeters: number;
}

export interface Route {
	name: string | null;
	distanceMeters: number;
	travelTimeSeconds: number;
	steps: RouteStep[];
}

export interface DirectionsResult {
	from: Place;
	to: Place;
	transport: Transport;
	/** Best route first. Empty steps means only distance/time are available (transit). */
	routes: Route[];
	note: string | null;
}

export interface MapsBridge {
	searchPlaces(q: SearchQuery): Promise<Place[]>;
	getDirections(q: DirectionsQuery): Promise<DirectionsResult>;
	/** Opens a maps:// URL in Maps.app (UI side effect). */
	openUrl(url: string): Promise<void>;
}

type Op =
	| { op: "search"; q: SearchQuery }
	| { op: "directions"; q: DirectionsQuery };

/**
 * Runs inside osascript (JXA). Must stay fully self-contained: no imports, no outer refs.
 */
function mapKit(a: Op): unknown {
	ObjC.import("MapKit");
	ObjC.import("CoreLocation");
	const $: any = (globalThis as any).$;

	const spin = (isDone: () => boolean, seconds: number) => {
		const until = $.NSDate.dateWithTimeIntervalSinceNow(seconds);
		while (!isDone() && $.NSDate.date.compare(until) < 0) {
			$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));
		}
	};
	const str = (x: any): string | null => {
		if (!x || x.isNil()) return null;
		const v = ObjC.unwrap(x);
		return v === undefined || v === null || v === "" ? null : String(v);
	};
	const fail = (e: any, what: string): never => {
		const desc = e.localizedDescription ? str(e.localizedDescription) : String(e);
		throw new Error(`${what} failed: ${desc}. Check the network connection.`);
	};

	// Coordinates are a C struct the bridge cannot read; CLLocation.description carries them.
	const coordOf = (loc: any): [number, number] | null => {
		if (!loc || loc.isNil()) return null;
		const m = /<([+-]?\d+(?:\.\d+)?),\s*([+-]?\d+(?:\.\d+)?)>/.exec(String(ObjC.unwrap(loc.description)));
		return m ? [Number(m[1]), Number(m[2])] : null;
	};

	const toPlace = (it: any) => {
		const pm = it.placemark;
		const c = coordOf(pm.location);
		let address: string | null = null;
		try {
			address = str(it.address.fullAddress);
		} catch (_e) {
			address = null;
		}
		const url = it.url && !it.url.isNil() ? str(it.url.absoluteString) : null;
		return {
			name: str(it.name) ?? str(pm.title) ?? "",
			address: address ?? str(pm.title) ?? "",
			latitude: c ? c[0] : null,
			longitude: c ? c[1] : null,
			phone: str(it.phoneNumber),
			url,
			category: str(it.pointOfInterestCategory),
		};
	};

	const localSearch = (query: string): any[] => {
		const req = $.MKLocalSearchRequest.alloc.init;
		req.naturalLanguageQuery = query;
		const search = $.MKLocalSearch.alloc.initWithRequest(req);
		let done = false;
		let res: any = null;
		let err: any = null;
		search.startWithCompletionHandler((r: any, e: any) => {
			res = r;
			err = e;
			done = true;
		});
		spin(() => done, 20);
		if (!done) throw new Error("Place search timed out. Check the network connection.");
		if (err && !err.isNil()) {
			// MKErrorPlacemarkNotFound = 4: no results is not a failure.
			if (Number(err.code) === 4) return [];
			fail(err, "Place search");
		}
		const items = res.mapItems;
		const out: any[] = [];
		for (let i = 0; i < Number(items.count); i++) out.push(items.objectAtIndex(i));
		return out;
	};

	const coordPattern = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

	const reverseGeocode = (lat: number, lon: number): any => {
		const loc = $.NSClassFromString("CLLocation").alloc.initWithLatitudeLongitude(lat, lon);
		const geocoder = $.CLGeocoder.alloc.init;
		let done = false;
		let marks: any = null;
		let err: any = null;
		geocoder.reverseGeocodeLocationCompletionHandler(loc, (p: any, e: any) => {
			marks = p;
			err = e;
			done = true;
		});
		spin(() => done, 20);
		if (!done) throw new Error("Reverse geocoding timed out. Check the network connection.");
		if (err && !err.isNil()) fail(err, "Reverse geocoding");
		if (!marks || Number(marks.count) === 0) {
			throw new Error(`No place found at ${lat},${lon}.`);
		}
		return marks.objectAtIndex(0);
	};

	const haversine = (p: [number, number], q: [number, number]): number => {
		const r = Math.PI / 180;
		const dLat = (q[0] - p[0]) * r;
		const dLon = (q[1] - p[1]) * r;
		const h =
			Math.sin(dLat / 2) ** 2 +
			Math.cos(p[0] * r) * Math.cos(q[0] * r) * Math.sin(dLon / 2) ** 2;
		return 12742000 * Math.asin(Math.sqrt(h));
	};

	/** Free text or "lat,lon" to an MKMapItem. */
	const resolve = (text: string, label: string): any => {
		const m = coordPattern.exec(text);
		if (m) {
			const mark = reverseGeocode(Number(m[1]), Number(m[2]));
			return $.MKMapItem.alloc.initWithPlacemark($.MKPlacemark.alloc.initWithPlacemark(mark));
		}
		const hits = localSearch(text);
		if (hits.length === 0) throw new Error(`Could not find ${label} "${text}".`);
		return hits[0];
	};

	if (a.op === "search") {
		const { query, near, limit } = a.q;
		if (!near) return localSearch(query).map(toPlace).slice(0, limit);

		// MapKit's search region (a struct) cannot be set from JXA, so a plain query only sees
		// the system's default region, while "query + city" collapses to a single geocoder hit.
		// Best effort: run both, merge, and sort by distance to the requested area.
		const m = coordPattern.exec(near);
		let origin: [number, number] | null = null;
		let area: string | null = near;
		if (m) {
			origin = [Number(m[1]), Number(m[2])];
			const mark = reverseGeocode(origin[0], origin[1]);
			area = str(mark.locality) ?? str(mark.administrativeArea);
		} else {
			const hit = localSearch(near)[0];
			if (hit) origin = coordOf(hit.placemark.location);
		}
		const items = localSearch(query);
		if (area) items.push(...localSearch(`${query} ${area}`));
		const seen: Record<string, boolean> = {};
		let places = items.map(toPlace).filter((p: any) => {
			const key = `${p.name}|${p.address}`;
			if (seen[key]) return false;
			seen[key] = true;
			return true;
		});
		if (origin) {
			const o = origin;
			places = places.map((p: any) => ({
				...p,
				distanceMeters:
					p.latitude === null ? null : Math.round(haversine(o, [p.latitude, p.longitude])),
			}));
			places.sort(
				(x: any, y: any) =>
					(x.distanceMeters ?? Infinity) - (y.distanceMeters ?? Infinity),
			);
		}
		return places.slice(0, limit);
	}

	// directions
	const { from, to, transport } = a.q;
	const src = resolve(from, "start");
	const dst = resolve(to, "destination");
	const req = $.MKDirectionsRequest.alloc.init;
	req.source = src;
	req.destination = dst;
	// MKDirectionsTransportType: automobile 1, walking 2, transit 4
	req.transportType = transport === "walking" ? 2 : transport === "transit" ? 4 : 1;
	req.requestsAlternateRoutes = transport !== "transit";
	const directions = $.MKDirections.alloc.initWithRequest(req);
	const result: any = {
		from: toPlace(src),
		to: toPlace(dst),
		transport,
		routes: [],
		note: null,
	};

	let done = false;
	let res: any = null;
	let err: any = null;
	directions.calculateDirectionsWithCompletionHandler((r: any, e: any) => {
		res = r;
		err = e;
		done = true;
	});
	spin(() => done, 40);
	if (!done) throw new Error("Route calculation timed out. Check the network connection.");

	if (err && !err.isNil()) {
		// MKErrorDirectionsNotFound = 5 (also what transit returns on macOS): fall back to ETA.
		if (Number(err.code) !== 5) fail(err, "Route calculation");
		let etaDone = false;
		let eta: any = null;
		let etaErr: any = null;
		directions.calculateETAWithCompletionHandler((r: any, e: any) => {
			eta = r;
			etaErr = e;
			etaDone = true;
		});
		spin(() => etaDone, 30);
		if (!etaDone || (etaErr && !etaErr.isNil())) {
			throw new Error(
				`No ${transport} route available between these places. Try another transport type.`,
			);
		}
		result.routes.push({
			name: null,
			distanceMeters: Math.round(Number(eta.distance)),
			travelTimeSeconds: Math.round(Number(eta.expectedTravelTime)),
			steps: [],
		});
		result.note =
			"Only an estimate (distance and time) is available for this transport type; " +
			"turn-by-turn steps are not. Use open_in_maps to see the full route in Maps.";
		return result;
	}

	const routes = res.routes;
	for (let i = 0; i < Number(routes.count); i++) {
		const rt = routes.objectAtIndex(i);
		const steps: { instruction: string; distanceMeters: number }[] = [];
		for (let j = 0; j < Number(rt.steps.count); j++) {
			const s = rt.steps.objectAtIndex(j);
			const instruction = str(s.instructions);
			if (instruction) {
				steps.push({ instruction, distanceMeters: Math.round(Number(s.distance)) });
			}
		}
		result.routes.push({
			name: str(rt.name),
			distanceMeters: Math.round(Number(rt.distance)),
			travelTimeSeconds: Math.round(Number(rt.expectedTravelTime)),
			steps,
		});
	}
	return result;
}

export const mapsBridge: MapsBridge = {
	searchPlaces(q) {
		return runJxa(mapKit, { op: "search", q } as Op, { app: "MapKit", timeoutMs: 60_000 }) as Promise<
			Place[]
		>;
	},
	getDirections(q) {
		return runJxa(mapKit, { op: "directions", q } as Op, {
			app: "MapKit",
			timeoutMs: 120_000,
		}) as Promise<DirectionsResult>;
	},
	openUrl(url) {
		return new Promise((resolve, reject) => {
			execFile("open", ["-a", "Maps", url], { timeout: 15_000 }, (error, _out, stderr) => {
				if (error) {
					reject(new OsaError(`Could not open Maps: ${String(stderr || error.message)}`, "script"));
				} else {
					resolve();
				}
			});
		});
	},
};
