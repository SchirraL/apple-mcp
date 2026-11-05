import { z } from "zod";
import { confirmField, withConfirm } from "../../lib/safety.js";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import { type MailBridge, type NewEmail, mailBridge } from "./bridge.js";

const emailId = z
	.string()
	.min(1)
	.describe("Email id as returned by list_emails / search_emails (stable across moves)");
const address = z.string().trim().email();
const addresses = (what: string) => z.array(address).describe(what);
const isoDate = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date, e.g. 2026-11-01");
const accountField = z
	.string()
	.optional()
	.describe("Mail account name, id or email address (see list_email_accounts)");
const folderField = (dflt: string) =>
	z.string().optional().describe(`Folder name or path, e.g. "INBOX" or "[Gmail]/Trash". ${dflt}`);

const composeShape = {
	to: addresses("Recipient email addresses").min(1),
	cc: addresses("Cc addresses").optional(),
	bcc: addresses("Bcc addresses").optional(),
	subject: z.string().trim().min(1),
	body: z.string().min(1).describe("Plain-text body"),
	from: z
		.string()
		.optional()
		.describe("Sender: one of the account email addresses (list_email_accounts)"),
};
const composeSchema = z.object(composeShape);

const TRASH_OR_JUNK =
	/^(trash|bin|deleted( messages| items)?|junk( e-?mail)?|spam|papierkorb|gel(ö|o|oe)scht\w*|gelöschte\w*|müll\w*|corbeille|poubelle|courrier ind[ée]sirable|papelera|correo no deseado|cestino|lixeira)$/i;

export function isTrashOrJunk(path: string): boolean {
	const last = path.split("/").pop() ?? path;
	return TRASH_OR_JUNK.test(last.trim());
}

function toNewEmail(a: z.infer<typeof composeSchema>): NewEmail {
	return {
		to: a.to,
		...(a.cc !== undefined && { cc: a.cc }),
		...(a.bcc !== undefined && { bcc: a.bcc }),
		subject: a.subject,
		body: a.body,
		...(a.from !== undefined && { from: a.from }),
	};
}

function previewMail(m: NewEmail): string {
	return [
		`From: ${m.from ?? "(Mail's default account)"}`,
		`To: ${m.to.join(", ")}`,
		...(m.cc?.length ? [`Cc: ${m.cc.join(", ")}`] : []),
		...(m.bcc?.length ? [`Bcc: ${m.bcc.join(", ")}`] : []),
		`Subject: ${m.subject}`,
		"",
		m.body,
	].join("\n");
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function createMailModule(bridge: MailBridge = mailBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "list_email_accounts",
			effect: "read",
			description: "List the accounts configured in Apple Mail, with their email addresses.",
			schema: z.object({}),
			async run() {
				const accounts = await bridge.listAccounts();
				return dataResult(`${plural(accounts.length, "account")}.`, accounts);
			},
		}),

		defineTool({
			name: "list_email_folders",
			effect: "read",
			description:
				"List Apple Mail folders (mailboxes) with unread and total message counts, " +
				"optionally for one account.",
			schema: z.object({ account: accountField }),
			async run({ account }) {
				const folders = await bridge.listFolders(account);
				return dataResult(`${plural(folders.length, "folder")}.`, folders);
			},
		}),

		defineTool({
			name: "list_emails",
			effect: "read",
			description:
				"List emails in a folder, newest first, with sender, date, read/flagged state and " +
				"a short snippet. Defaults to the INBOX of all accounts. Use read_email for the full " +
				"text and search_emails to look for something.",
			schema: z.object({
				account: accountField,
				folder: folderField("Default INBOX."),
				unreadOnly: z.boolean().default(false),
				limit: z.number().int().min(1).max(100).default(20),
			}),
			async run(args) {
				const emails = await bridge.listEmails({
					...(args.account !== undefined && { account: args.account }),
					...(args.folder !== undefined && { folder: args.folder }),
					unreadOnly: args.unreadOnly,
					limit: args.limit,
				});
				const capped = emails.length === args.limit ? ` (limit ${args.limit} reached)` : "";
				return dataResult(`${plural(emails.length, "email")}${capped}.`, emails);
			},
		}),

		defineTool({
			name: "search_emails",
			effect: "read",
			description:
				"Search emails, newest first. Each word of query must appear (case-insensitive) in " +
				"the subject, sender name/address or the message preview text; full bodies are not " +
				"searched. Searches the INBOX unless a folder is given. Optional date range.",
			schema: z.object({
				query: z.string().trim().min(1).describe("Words to look for, e.g. an invoice number"),
				account: accountField,
				folder: folderField("Default INBOX."),
				since: isoDate.optional().describe("Only emails received on/after this date"),
				before: isoDate.optional().describe("Only emails received before this date"),
				unreadOnly: z.boolean().default(false),
				limit: z.number().int().min(1).max(100).default(20),
			}),
			async run(args) {
				const emails = await bridge.searchEmails({
					query: args.query,
					...(args.account !== undefined && { account: args.account }),
					...(args.folder !== undefined && { folder: args.folder }),
					...(args.since !== undefined && { since: args.since }),
					...(args.before !== undefined && { before: args.before }),
					unreadOnly: args.unreadOnly,
					limit: args.limit,
				});
				const capped = emails.length === args.limit ? ` (limit ${args.limit} reached)` : "";
				return dataResult(`${plural(emails.length, "match")}${capped}.`, emails);
			},
		}),

		defineTool({
			name: "read_email",
			effect: "read",
			description:
				"Read one email in full: plain-text body, recipients (to/cc) and attachment names.",
			schema: z.object({ id: emailId }),
			async run({ id }) {
				const email = await bridge.getEmail(id);
				return dataResult(`Email "${email.subject}" from ${email.from}.`, email);
			},
		}),

		defineTool({
			name: "create_draft",
			effect: "write",
			description:
				"Save a new email as a draft in Apple Mail's Drafts folder without sending it and " +
				"without opening a compose window. No confirmation needed. It lands in the Drafts " +
				"folder of the sending account and can take a minute to show up in list_emails / " +
				"search_emails (Mail indexes it after syncing).",
			schema: composeSchema,
			async run(args) {
				const m = toNewEmail(args);
				await bridge.createDraft(m);
				return dataResult(`Saved draft "${m.subject}" to ${m.to.join(", ")}.`, {
					drafted: true,
				});
			},
		}),

		defineTool({
			name: "send_email",
			effect: "external",
			description:
				"Send a new email. Requires confirm: true; without it only a preview of " +
				"from/to/cc/bcc/subject/body is returned and nothing is sent.",
			schema: composeSchema.extend({ confirm: confirmField }),
			async run({ confirm, ...rest }) {
				const m = toNewEmail(rest);
				return withConfirm(
					confirm,
					() => `Would SEND this email:\n\n${previewMail(m)}`,
					async () => {
						await bridge.sendEmail(m);
						return dataResult(`Sent "${m.subject}" to ${m.to.join(", ")}.`, { sent: true });
					},
				);
			},
		}),

		defineTool({
			name: "reply_email",
			effect: "external",
			description:
				"Reply to an email. By default only saves a reply DRAFT (quoting the original) " +
				"that the user can review in Mail. With send: true the reply is sent, which " +
				"requires confirm: true (otherwise a preview is returned).",
			schema: z.object({
				id: emailId,
				body: z.string().min(1).describe("Your reply text, placed above the quoted original"),
				replyAll: z.boolean().default(false).describe("Also address all other recipients"),
				send: z.boolean().default(false).describe("Send instead of saving a draft"),
				confirm: confirmField,
			}),
			async run({ id, body, replyAll, send, confirm }) {
				const perform = async () => {
					const r = await bridge.replyEmail(id, { body, replyAll, send });
					return dataResult(r.sent ? "Reply sent." : "Saved reply draft.", r);
				};
				if (!send) return perform();
				const original = await bridge.getEmail(id);
				return withConfirm(
					confirm,
					() =>
						`Would SEND a reply to "${original.subject}" from ${original.from}` +
						`${replyAll ? " (reply all)" : ""}:\n\n${body}`,
					perform,
				);
			},
		}),

		defineTool({
			name: "move_email",
			effect: "write",
			description:
				"Move an email to another folder of its account (use list_email_folders for names; " +
				'"Account/Folder" targets another account). The id stays valid. Moving to ' +
				"Trash/Deleted/Junk/Spam requires confirm: true (otherwise previews); other " +
				"moves apply directly.",
			schema: z.object({
				id: emailId,
				folder: z.string().trim().min(1).describe("Destination folder name or path"),
				confirm: confirmField,
			}),
			async run({ id, folder, confirm }) {
				const target = await bridge.resolveMoveTarget(id, folder);
				const apply = async () => {
					await bridge.moveEmail(id, target);
					return dataResult(`Moved email to "${target.path}" (${target.accountName}).`, {
						id,
						folder: target.path,
						account: target.accountName,
					});
				};
				if (!isTrashOrJunk(target.path)) return apply();
				const email = await bridge.getEmail(id);
				return withConfirm(
					confirm,
					() =>
						`Would move email "${email.subject}" from ${email.from} out of ` +
						`"${email.folder}" to "${target.path}" (${target.accountName}), ` +
						"which may delete it permanently after a while.",
					apply,
				);
			},
		}),

		defineTool({
			name: "mark_email_read",
			effect: "write",
			description: "Mark an email as read (default) or unread.",
			schema: z.object({ id: emailId, read: z.boolean().default(true) }),
			async run({ id, read }) {
				await bridge.setRead(id, read);
				return dataResult(`Marked email as ${read ? "read" : "unread"}.`, { id, read });
			},
		}),

		defineTool({
			name: "flag_email",
			effect: "write",
			description: "Flag (default) or unflag an email.",
			schema: z.object({ id: emailId, flagged: z.boolean().default(true) }),
			async run({ id, flagged }) {
				await bridge.setFlagged(id, flagged);
				return dataResult(`${flagged ? "Flagged" : "Unflagged"} email.`, { id, flagged });
			},
		}),
	]);
}
