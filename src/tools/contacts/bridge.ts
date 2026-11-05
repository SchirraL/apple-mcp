import { runJxa } from "../../lib/applescript.js";

// Contacts via the Contacts framework (CNContactStore) through the JXA ObjC bridge.
// Measured on ~400 contacts: full enumeration ~0.65s vs ~3.5s for just counting people via
// the Contacts.app scripting dictionary. The note field (CNContactNoteKey) needs a special
// entitlement: reading it throws under osascript, so it is deliberately not fetched.

export interface Labeled {
	/** Lower-cased well-known label ("mobile", "home", "work", ...) or the custom label. */
	label: string | null;
	value: string;
}

export interface PostalAddress {
	label: string | null;
	street: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
}

export interface Contact {
	id: string;
	name: string;
	organization: string | null;
	phones: Labeled[];
	emails: Labeled[];
}

export interface ContactDetail extends Contact {
	givenName: string;
	familyName: string;
	nickname: string | null;
	jobTitle: string | null;
	department: string | null;
	/** YYYY-MM-DD, or --MM-DD when the year is unknown. */
	birthday: string | null;
	addresses: PostalAddress[];
	urls: Labeled[];
}

export interface NewContact {
	givenName?: string;
	familyName?: string;
	nickname?: string;
	organization?: string;
	jobTitle?: string;
	department?: string;
	birthday?: string;
	phones?: Labeled[];
	emails?: Labeled[];
	urls?: Labeled[];
}

export interface ContactPatch {
	givenName?: string | null;
	familyName?: string | null;
	nickname?: string | null;
	organization?: string | null;
	jobTitle?: string | null;
	department?: string | null;
	birthday?: string | null;
	/** Appended unless the same value already exists. */
	addPhones?: Labeled[];
	addEmails?: Labeled[];
	addUrls?: Labeled[];
}

export interface ContactPage {
	total: number;
	contacts: Contact[];
}

export interface ContactsBridge {
	search(query: string, limit: number): Promise<ContactPage>;
	get(id: string): Promise<ContactDetail>;
	list(limit: number, offset: number): Promise<ContactPage>;
	findByPhone(phone: string, limit: number): Promise<Contact[]>;
	create(c: NewContact): Promise<ContactDetail>;
	update(id: string, patch: ContactPatch): Promise<ContactDetail>;
}

type Op =
	| { op: "search"; query: string; limit: number }
	| { op: "get"; id: string }
	| { op: "list"; limit: number; offset: number }
	| { op: "phone"; phone: string; limit: number }
	| { op: "create"; c: NewContact }
	| { op: "update"; id: string; patch: ContactPatch };

/**
 * Runs inside osascript (JXA). Must stay fully self-contained: no imports, no outer refs.
 */
function contactsFramework(a: Op): unknown {
	ObjC.import("Contacts");
	const $: any = (globalThis as any).$;

	// Statuses: 0 notDetermined, 1 restricted, 2 denied, 3 authorized, 4 limited
	let status = Number($.CNContactStore.authorizationStatusForEntityType(0));
	const store = $.CNContactStore.alloc.init;
	if (status === 0) {
		let answered = false;
		store.requestAccessForEntityTypeCompletionHandler(0, () => {
			answered = true;
		});
		const until = $.NSDate.dateWithTimeIntervalSinceNow(120);
		while (!answered && $.NSDate.date.compare(until) < 0) {
			$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));
		}
		status = Number($.CNContactStore.authorizationStatusForEntityType(0));
	}
	if (status !== 3) {
		throw new Error(
			"No access to Contacts. Enable it in System Settings > Privacy & Security > " +
				"Contacts for the app running this server, then retry.",
		);
	}

	const str = (x: any): string | null => {
		if (!x || x.isNil()) return null;
		const s = x.js;
		return s === undefined || s === null || s === "" ? null : String(s);
	};
	const s0 = (x: any): string => str(x) ?? "";
	const errMsg = (e: any): string => (e && !e.isNil() ? s0(e.localizedDescription) : "unknown");
	const num = (x: any): number => Number(x);

	// CNContactStore wants real NSArrays of NSString keys (JS arrays raise).
	const keys = $.NSMutableArray.array;
	for (const k of [
		"identifier",
		"givenName",
		"familyName",
		"nickname",
		"organizationName",
		"jobTitle",
		"departmentName",
		"phoneNumbers",
		"emailAddresses",
		"postalAddresses",
		"urlAddresses",
		"birthday",
	]) {
		keys.addObject($(k));
	}

	const label = (l: any): string | null => {
		const s = str(l);
		if (s === null) return null;
		const m = /^_\$!<(.*)>!\$_$/.exec(s);
		return m ? m[1].toLowerCase() : s;
	};
	// Well-known labels map back to the CNLabel constants; anything else is a custom label.
	const WELL_KNOWN: Record<string, string> = {
		mobile: "Mobile",
		iphone: "iPhone",
		home: "Home",
		work: "Work",
		other: "Other",
		main: "Main",
		homepage: "HomePage",
	};
	const toLabel = (l: string | null | undefined): any => {
		if (l === null || l === undefined || l === "") return $();
		const k = WELL_KNOWN[l.toLowerCase()];
		return $(k ? `_$!<${k}>!$_` : l);
	};

	const labeled = (arr: any, valueOf: (v: any) => string | null) => {
		const out: { label: string | null; value: string }[] = [];
		for (let i = 0; i < num(arr.count); i++) {
			const lv = arr.objectAtIndex(i);
			const v = valueOf(lv.value);
			if (v) out.push({ label: label(lv.label), value: v });
		}
		return out;
	};
	const phoneOf = (v: any) => str(v.stringValue);
	const plain = (v: any) => str(v);

	const nameOf = (c: any): string => {
		const full = [s0(c.givenName), s0(c.familyName)].filter((x) => x).join(" ");
		return full || s0(c.nickname) || s0(c.organizationName) || "(no name)";
	};

	const birthdayOf = (c: any): string | null => {
		const b = c.birthday;
		if (!b || b.isNil()) return null;
		const p = (n: number) => (n < 10 ? `0${n}` : String(n));
		const y = num(b.year);
		const md = `${p(num(b.month))}-${p(num(b.day))}`;
		// NSDateComponentUndefined is NSIntegerMax
		return y > 0 && y < 100000 ? `${y}-${md}` : `--${md}`;
	};

	const summary = (c: any) => ({
		id: s0(c.identifier),
		name: nameOf(c),
		organization: str(c.organizationName),
		phones: labeled(c.phoneNumbers, phoneOf),
		emails: labeled(c.emailAddresses, plain),
	});

	const detail = (c: any) => {
		const addrs: any[] = [];
		const pa = c.postalAddresses;
		for (let i = 0; i < num(pa.count); i++) {
			const lv = pa.objectAtIndex(i);
			const v = lv.value;
			addrs.push({
				label: label(lv.label),
				street: s0(v.street),
				city: s0(v.city),
				state: s0(v.state),
				postalCode: s0(v.postalCode),
				country: s0(v.country),
			});
		}
		return {
			...summary(c),
			givenName: s0(c.givenName),
			familyName: s0(c.familyName),
			nickname: str(c.nickname),
			jobTitle: str(c.jobTitle),
			department: str(c.departmentName),
			birthday: birthdayOf(c),
			addresses: addrs,
			urls: labeled(c.urlAddresses, plain),
		};
	};

	const fetchAll = (): any[] => {
		const req = $.CNContactFetchRequest.alloc.initWithKeysToFetch(keys);
		req.unifyResults = true;
		const all: any[] = [];
		const err = (globalThis as any).Ref();
		const ok = store.enumerateContactsWithFetchRequestErrorUsingBlock(req, err, (c: any) => {
			all.push(c);
		});
		if (!ok) throw new Error(`Reading contacts failed: ${errMsg(err[0])}`);
		return all;
	};

	const byName = (x: any, y: any) =>
		nameOf(x).toLowerCase().localeCompare(nameOf(y).toLowerCase());

	const fetchById = (id: string): any => {
		const ids = $.NSMutableArray.array;
		ids.addObject($(id));
		const err = (globalThis as any).Ref();
		const r = store.unifiedContactsMatchingPredicateKeysToFetchError(
			$.CNContact.predicateForContactsWithIdentifiers(ids),
			keys,
			err,
		);
		if (!r || r.isNil() || num(r.count) === 0) {
			throw new Error(`No contact with id ${id}`);
		}
		return r.objectAtIndex(0);
	};

	// --- phone matching: keep in sync with phone.ts ---
	const digitsOf = (s: string) => s.replace(/\D/g, "");
	const phonesMatch = (x: string, y: string): boolean => {
		const dx = digitsOf(x);
		const dy = digitsOf(y);
		if (dx === "" || dy === "") return false;
		if (dx === dy) return true;
		const k = Math.min(dx.length, dy.length, 10);
		return k >= 9 && dx.slice(-k) === dy.slice(-k);
	};

	const parseBirthday = (s: string): any => {
		const m = /^(?:(\d{4})-|--)(\d{2})-(\d{2})$/.exec(s);
		if (!m) throw new Error(`Invalid birthday "${s}": use YYYY-MM-DD or --MM-DD`);
		const dc = $.NSDateComponents.alloc.init;
		if (m[1]) dc.year = Number(m[1]);
		dc.month = Number(m[2]);
		dc.day = Number(m[3]);
		return dc;
	};

	const newLabeled = (items: { label?: string | null; value: string }[], phone: boolean) => {
		const out = $.NSMutableArray.array;
		for (const it of items) {
			const v = phone ? $.CNPhoneNumber.phoneNumberWithStringValue(it.value) : $(it.value);
			out.addObject($.CNLabeledValue.labeledValueWithLabelValue(toLabel(it.label), v));
		}
		return out;
	};

	// Append items not already present (same value; phones compared with phonesMatch).
	const appendLabeled = (
		existing: any,
		items: { label?: string | null; value: string }[],
		phone: boolean,
		valueOf: (v: any) => string | null,
	) => {
		const merged = $.NSMutableArray.arrayWithArray(existing);
		const have = labeled(existing, valueOf).map((x) => x.value);
		const fresh: { label?: string | null; value: string }[] = [];
		for (const it of items) {
			const dup = have.some((h) =>
				phone ? phonesMatch(h, it.value) : h.toLowerCase() === it.value.toLowerCase(),
			);
			if (!dup) {
				fresh.push(it);
				have.push(it.value);
			}
		}
		merged.addObjectsFromArray(newLabeled(fresh, phone));
		return merged;
	};

	const setStr = (m: any, key: string, v: string | null | undefined) => {
		if (v === undefined) return;
		m[key] = v === null ? "" : v;
	};

	const save = (req: any) => {
		const err = (globalThis as any).Ref();
		if (!store.executeSaveRequestError(req, err)) {
			throw new Error(`Saving contact failed: ${errMsg(err[0])}`);
		}
	};

	switch (a.op) {
		case "search": {
			const q = a.query.toLowerCase().trim();
			const tokens = q.split(/\s+/).filter((t) => t);
			const qDigits = digitsOf(q);
			const phoneLike = qDigits.length >= 3 && /^[\d\s+()\-./]+$/.test(q);
			const hits = fetchAll().filter((c) => {
				const s = summary(c);
				const hay = [s.name, s.organization ?? "", s0(c.nickname), ...s.emails.map((e) => e.value)]
					.join("\n")
					.toLowerCase();
				if (tokens.every((t) => hay.includes(t))) return true;
				return phoneLike && s.phones.some((p) => digitsOf(p.value).includes(qDigits));
			});
			hits.sort(byName);
			return { total: hits.length, contacts: hits.slice(0, a.limit).map(summary) };
		}
		case "get":
			return detail(fetchById(a.id));
		case "list": {
			const all = fetchAll();
			all.sort(byName);
			return {
				total: all.length,
				contacts: all.slice(a.offset, a.offset + a.limit).map(summary),
			};
		}
		case "phone": {
			const hits = fetchAll().filter((c) => {
				const n = c.phoneNumbers;
				for (let i = 0; i < num(n.count); i++) {
					const v = str(n.objectAtIndex(i).value.stringValue);
					if (v && phonesMatch(v, a.phone)) return true;
				}
				return false;
			});
			hits.sort(byName);
			return hits.slice(0, a.limit).map(summary);
		}
		case "create": {
			const c = a.c;
			const m = $.CNMutableContact.alloc.init;
			setStr(m, "givenName", c.givenName);
			setStr(m, "familyName", c.familyName);
			setStr(m, "nickname", c.nickname);
			setStr(m, "organizationName", c.organization);
			setStr(m, "jobTitle", c.jobTitle);
			setStr(m, "departmentName", c.department);
			if (c.birthday) m.birthday = parseBirthday(c.birthday);
			if (c.phones?.length) m.phoneNumbers = newLabeled(c.phones, true);
			if (c.emails?.length) m.emailAddresses = newLabeled(c.emails, false);
			if (c.urls?.length) m.urlAddresses = newLabeled(c.urls, false);
			const req = $.CNSaveRequest.alloc.init;
			req.addContactToContainerWithIdentifier(m, $());
			save(req);
			return detail(fetchById(s0(m.identifier)));
		}
		case "update": {
			const p = a.patch;
			const m = fetchById(a.id).mutableCopy;
			setStr(m, "givenName", p.givenName);
			setStr(m, "familyName", p.familyName);
			setStr(m, "nickname", p.nickname);
			setStr(m, "organizationName", p.organization);
			setStr(m, "jobTitle", p.jobTitle);
			setStr(m, "departmentName", p.department);
			if (p.birthday === null) m.birthday = $();
			else if (p.birthday !== undefined) m.birthday = parseBirthday(p.birthday);
			if (p.addPhones?.length) {
				m.phoneNumbers = appendLabeled(m.phoneNumbers, p.addPhones, true, phoneOf);
			}
			if (p.addEmails?.length) {
				m.emailAddresses = appendLabeled(m.emailAddresses, p.addEmails, false, plain);
			}
			if (p.addUrls?.length) {
				m.urlAddresses = appendLabeled(m.urlAddresses, p.addUrls, false, plain);
			}
			const req = $.CNSaveRequest.alloc.init;
			req.updateContact(m);
			save(req);
			return detail(fetchById(a.id));
		}
	}
}

const run = <R>(op: Op): Promise<R> =>
	runJxa(contactsFramework, op, { app: "Contacts", timeoutMs: 30_000 }) as Promise<R>;

export const contactsBridge: ContactsBridge = {
	search: (query, limit) => run({ op: "search", query, limit }),
	get: (id) => run({ op: "get", id }),
	list: (limit, offset) => run({ op: "list", limit, offset }),
	findByPhone: (phone, limit) => run({ op: "phone", phone, limit }),
	create: (c) => run({ op: "create", c }),
	update: (id, patch) => run({ op: "update", id, patch }),
};
