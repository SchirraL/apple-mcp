import { z } from "zod";
import { confirmField, withConfirm } from "../../lib/safety.js";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import {
	type ContactDetail,
	type ContactPatch,
	type ContactsBridge,
	contactsBridge,
	type Labeled,
} from "./bridge.js";

export { normalizePhone, phonesMatch } from "./phone.js";

const labelField = z
	.string()
	.optional()
	.describe('Label such as "mobile", "home", "work", "other", or any custom text');
const labeledValue = z.object({ label: labelField, value: z.string().trim().min(1) });
const phoneItem = labeledValue.describe("Phone number with optional label");
const emailItem = z
	.object({
		label: labelField,
		value: z.string().trim().min(3).refine((v) => v.includes("@"), "must be an email address"),
	})
	.describe("Email address with optional label");

const birthday = z
	.string()
	.regex(/^(\d{4}-|--)\d{2}-\d{2}$/, "use YYYY-MM-DD, or --MM-DD if the year is unknown");
const contactId = z.string().min(1).describe("Contact id as returned by search_contacts");

/** Drop undefined `label` so the objects satisfy exactOptionalPropertyTypes. */
function toLabeled(items: { label?: string | undefined; value: string }[] | undefined) {
	return items?.map(
		(i): Labeled => ({ label: i.label === undefined ? null : i.label, value: i.value }),
	);
}

type ScalarField =
	| "givenName"
	| "familyName"
	| "nickname"
	| "organization"
	| "jobTitle"
	| "department"
	| "birthday";
const SCALARS: ScalarField[] = [
	"givenName",
	"familyName",
	"nickname",
	"organization",
	"jobTitle",
	"department",
	"birthday",
];

function currentValue(c: ContactDetail, f: ScalarField): string | null {
	const v = f === "organization" ? c.organization : c[f];
	return v === "" ? null : v;
}

/** Existing non-empty scalar fields the patch would change or clear. */
function findOverwrites(
	current: ContactDetail,
	patch: ContactPatch,
): { field: ScalarField; from: string; to: string | null }[] {
	const out: { field: ScalarField; from: string; to: string | null }[] = [];
	for (const field of SCALARS) {
		const next = patch[field];
		if (next === undefined) continue;
		const prev = currentValue(current, field);
		if (prev !== null && prev !== next) out.push({ field, from: prev, to: next });
	}
	return out;
}

export function createContactsModule(bridge: ContactsBridge = contactsBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "search_contacts",
			effect: "read",
			description:
				"Search Apple Contacts by name, organisation, nickname, email or phone number " +
				"(case-insensitive; all words must match). Returns id, name, organisation, " +
				"phones and emails; use get_contact for full details.",
			schema: z.object({
				query: z.string().trim().min(1).describe("Text to look for"),
				limit: z.number().int().min(1).max(200).default(25),
			}),
			async run({ query, limit }) {
				const page = await bridge.search(query, limit);
				const more = page.total > page.contacts.length ? ` of ${page.total} matches` : "";
				return dataResult(`${page.contacts.length} contacts${more}.`, page.contacts);
			},
		}),

		defineTool({
			name: "get_contact",
			effect: "read",
			description:
				"Get one contact in full: all phones and emails with labels, postal addresses, " +
				"organisation, job title, birthday and URLs. The note field is not available.",
			schema: z.object({ id: contactId }),
			async run({ id }) {
				const c = await bridge.get(id);
				return dataResult(`Contact "${c.name}".`, c);
			},
		}),

		defineTool({
			name: "list_contacts",
			effect: "read",
			description:
				"List contacts sorted by name, one page at a time. Use offset to page through; " +
				"the summary line shows the total.",
			schema: z.object({
				limit: z.number().int().min(1).max(200).default(50),
				offset: z.number().int().min(0).default(0),
			}),
			async run({ limit, offset }) {
				const page = await bridge.list(limit, offset);
				const end = offset + page.contacts.length;
				return dataResult(
					`Contacts ${page.contacts.length === 0 ? 0 : offset + 1}-${end} of ${page.total}.`,
					page.contacts,
				);
			},
		}),

		defineTool({
			name: "find_contact_by_phone",
			effect: "read",
			description:
				"Find who a phone number belongs to. Matches regardless of formatting and " +
				'country prefix, so "+49 171 1234567" finds a contact stored as "0171 1234567".',
			schema: z.object({
				phone: z
					.string()
					.refine((p) => p.replace(/\D/g, "").length >= 3, "must contain at least 3 digits"),
				limit: z.number().int().min(1).max(50).default(5),
			}),
			async run({ phone, limit }) {
				const hits = await bridge.findByPhone(phone, limit);
				return dataResult(
					hits.length === 0 ? "No contact has this number." : `${hits.length} contacts.`,
					hits,
				);
			},
		}),

		defineTool({
			name: "create_contact",
			effect: "write",
			description:
				"Create a new contact in the default account. Needs at least a name or an " +
				"organisation. Birthday as YYYY-MM-DD (or --MM-DD).",
			schema: z
				.object({
					givenName: z.string().trim().optional(),
					familyName: z.string().trim().optional(),
					nickname: z.string().trim().optional(),
					organization: z.string().trim().optional(),
					jobTitle: z.string().trim().optional(),
					department: z.string().trim().optional(),
					birthday: birthday.optional(),
					phones: z.array(phoneItem).optional(),
					emails: z.array(emailItem).optional(),
					urls: z.array(labeledValue).optional(),
				})
				.refine(
					(c) => Boolean(c.givenName || c.familyName || c.organization),
					"provide givenName, familyName or organization",
				),
			async run(args) {
				const { phones, emails, urls, ...rest } = args;
				const defined = Object.fromEntries(
					Object.entries(rest).filter(([, v]) => v !== undefined && v !== ""),
				);
				const created = await bridge.create({
					...defined,
					...(phones && { phones: toLabeled(phones) as Labeled[] }),
					...(emails && { emails: toLabeled(emails) as Labeled[] }),
					...(urls && { urls: toLabeled(urls) as Labeled[] }),
				});
				return dataResult(`Created contact "${created.name}".`, created);
			},
		}),

		defineTool({
			name: "update_contact",
			effect: "write",
			description:
				"Change a contact. Adding phones/emails/urls (addPhones, addEmails, addUrls) " +
				"or filling an empty field applies immediately; changing or clearing a field " +
				"that already has a value requires confirm: true, otherwise it previews. " +
				"Pass null to clear a field.",
			schema: z
				.object({
					id: contactId,
					givenName: z.string().trim().nullable().optional(),
					familyName: z.string().trim().nullable().optional(),
					nickname: z.string().trim().nullable().optional(),
					organization: z.string().trim().nullable().optional(),
					jobTitle: z.string().trim().nullable().optional(),
					department: z.string().trim().nullable().optional(),
					birthday: birthday.nullable().optional(),
					addPhones: z.array(phoneItem).optional(),
					addEmails: z.array(emailItem).optional(),
					addUrls: z.array(labeledValue).optional(),
					confirm: confirmField,
				})
				.refine(
					({ id: _i, confirm: _c, ...rest }) => Object.values(rest).some((v) => v !== undefined),
					"provide at least one field to change",
				),
			async run({ id, confirm, addPhones, addEmails, addUrls, ...fields }) {
				const patch: ContactPatch = {
					...(Object.fromEntries(
						Object.entries(fields).filter(([, v]) => v !== undefined),
					) as ContactPatch),
					...(addPhones && { addPhones: toLabeled(addPhones) as Labeled[] }),
					...(addEmails && { addEmails: toLabeled(addEmails) as Labeled[] }),
					...(addUrls && { addUrls: toLabeled(addUrls) as Labeled[] }),
				};
				const current = await bridge.get(id);
				const overwrites = findOverwrites(current, patch);
				const apply = async () => {
					const updated = await bridge.update(id, patch);
					return dataResult(`Updated contact "${updated.name}".`, updated);
				};
				if (overwrites.length === 0) return apply();
				return withConfirm(
					confirm,
					() =>
						`Would change contact "${current.name}":\n` +
						overwrites
							.map((o) => `- ${o.field}: "${o.from}" -> ${o.to === null ? "(cleared)" : `"${o.to}"`}`)
							.join("\n"),
					apply,
				);
			},
		}),
	]);
}
