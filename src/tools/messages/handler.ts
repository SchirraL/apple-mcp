import { z } from "zod";
import { confirmField, withConfirm } from "../../lib/safety.js";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import {
	type ChatSummary,
	type MessagesBridge,
	messagesBridge,
	parseHandle,
	type Recipient,
} from "./bridge.js";

const chatIdField = z
	.string()
	.min(1)
	.describe('Chat id as returned by list_message_chats (e.g. "iMessage;-;+4915…")');
const handleField = z
	.string()
	.min(1)
	.describe("Phone number (any common format, ideally with +country code) or email address");
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date");

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describeChat(c: ChatSummary): string {
	const who = c.handles.join(", ") || "unknown participants";
	return c.name ? `"${c.name}" (${who})` : who;
}

export function createMessagesModule(bridge: MessagesBridge = messagesBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "list_message_chats",
			effect: "read",
			description:
				"List recent Messages (iMessage/SMS) conversations, newest first: chat id, display " +
				"name (groups), participant handles, last message date and unread count. Use the " +
				"chat id with read_messages, search_messages or send_message. Contact names are " +
				"not resolved: handles are phone numbers or emails.",
			schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
			async run({ limit }) {
				const chats = await bridge.listChats({ limit });
				return dataResult(`${plural(chats.length, "chat")}.`, chats);
			},
		}),

		defineTool({
			name: "read_messages",
			effect: "read",
			description:
				"Read messages of one conversation, newest first. Identify it by chatId (from " +
				"list_message_chats) or by handle (phone number or email, one-to-one chats only). " +
				"Optionally restrict to before/after an ISO date.",
			schema: z
				.object({
					chatId: chatIdField.optional(),
					handle: handleField.optional(),
					limit: z.number().int().min(1).max(200).default(30),
					before: isoDate.optional().describe("Only messages before this ISO date"),
					after: isoDate.optional().describe("Only messages after this ISO date"),
				})
				.refine(
					(a) => (a.chatId === undefined) !== (a.handle === undefined),
					"provide exactly one of chatId or handle",
				),
			async run(args) {
				if (args.handle !== undefined && !parseHandle(args.handle)) {
					throw new Error("handle must be a phone number or an email address.");
				}
				const { messages } = await bridge.readMessages({
					...(args.chatId !== undefined && { chatId: args.chatId }),
					...(args.handle !== undefined && { handle: args.handle }),
					limit: args.limit,
					...(args.before !== undefined && { before: args.before }),
					...(args.after !== undefined && { after: args.after }),
				});
				const capped = messages.length === args.limit ? ` (limit ${args.limit} reached)` : "";
				return dataResult(`${plural(messages.length, "message")}${capped}.`, messages);
			},
		}),

		defineTool({
			name: "search_messages",
			effect: "read",
			description:
				"Search message text (case-insensitive substring) across all chats or within one " +
				"chat, newest first. Scans the most recent ~5000 messages.",
			schema: z.object({
				query: z.string().trim().min(1).describe("Text to look for"),
				chatId: chatIdField.optional().describe("Restrict to this chat"),
				limit: z.number().int().min(1).max(100).default(20),
			}),
			async run(args) {
				const { messages, scanLimited } = await bridge.searchMessages({
					query: args.query,
					...(args.chatId !== undefined && { chatId: args.chatId }),
					limit: args.limit,
				});
				const note = scanLimited ? " Only the most recent ~5000 messages were scanned." : "";
				return dataResult(`${plural(messages.length, "match")}.${note}`, messages);
			},
		}),

		defineTool({
			name: "list_unread_messages",
			effect: "read",
			description: "List unread incoming messages across all chats, newest first.",
			schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
			async run({ limit }) {
				const { messages } = await bridge.listUnread(limit);
				return dataResult(`${plural(messages.length, "unread message")}.`, messages);
			},
		}),

		defineTool({
			name: "send_message",
			effect: "external",
			description:
				"Send an iMessage/SMS via the Messages app to a handle (phone number or email) " +
				"or an existing chat (chatId, needed for group chats). Provide exactly one of " +
				"`to` or `chatId`. Requires confirm: true; without it only a preview of the " +
				"recipient and exact text is returned and nothing is sent.",
			schema: z
				.object({
					to: handleField.optional(),
					chatId: chatIdField.optional(),
					text: z.string().min(1).describe("Message text, sent exactly as given"),
					confirm: confirmField,
				})
				.refine(
					(a) => (a.to === undefined) !== (a.chatId === undefined),
					"provide exactly one of to or chatId",
				),
			async run({ to, chatId, text, confirm }) {
				let recipient: Recipient;
				let label: string;
				if (chatId !== undefined) {
					const chat = await bridge.getChat(chatId);
					if (!chat) throw new Error(`No chat with id "${chatId}". Use list_message_chats.`);
					recipient = { chatId };
					label = `chat ${describeChat(chat)}${chat.isGroup ? " [group]" : ""}`;
				} else {
					const parsed = parseHandle(to as string);
					if (!parsed) throw new Error("`to` must be a phone number or an email address.");
					recipient = { handle: parsed.value };
					label = parsed.value;
				}
				return withConfirm(
					confirm,
					() => `Would send a message to ${label}:\n---\n${text}\n---`,
					async () => {
						await bridge.sendMessage(recipient, text);
						return dataResult(`Message sent to ${label}.`, { to: label, text });
					},
				);
			},
		}),
	]);
}
