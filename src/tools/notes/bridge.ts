import { runJxa } from "../../lib/applescript.js";

// Notes has no public framework, so this uses the Notes scripting dictionary via JXA.
// Batched property reads per folder keep it at ~0.2s for small/medium libraries.

export interface NoteFolder {
	id: string;
	name: string;
	account: string;
	noteCount: number;
}

export interface NoteSummary {
	id: string;
	title: string;
	folder: string;
	account: string;
	modified: string;
	created: string;
	locked: boolean;
	/** First ~200 chars of plain text (null for locked notes). */
	snippet: string | null;
}

export interface Note extends NoteSummary {
	/** Full plain text (null for locked notes). */
	text: string | null;
	/** Raw Notes HTML, only when requested (null for locked notes). */
	html: string | null;
	shared: boolean;
	attachments: string[];
}

export interface NoteQuery {
	folder?: string;
	query?: string;
	limit: number;
}

export type BodyFormat = "text" | "html";

export interface NewNote {
	title: string;
	body?: string;
	format: BodyFormat;
	folder?: string;
}

export interface NotePatch {
	title?: string;
	/** Replaces everything below the title. */
	body?: string;
	/** Appended to the end of the note. */
	append?: string;
	format: BodyFormat;
}

export interface NotesBridge {
	listFolders(): Promise<NoteFolder[]>;
	listNotes(q: NoteQuery): Promise<NoteSummary[]>;
	getNote(id: string, includeHtml: boolean): Promise<Note>;
	createNote(n: NewNote): Promise<Note>;
	updateNote(id: string, patch: NotePatch): Promise<Note>;
	/** Moves the note to "Recently Deleted". */
	deleteNote(id: string): Promise<void>;
}

type Op =
	| { op: "folders" }
	| { op: "list"; q: NoteQuery }
	| { op: "get"; id: string; html: boolean }
	| { op: "create"; n: NewNote }
	| { op: "update"; id: string; patch: NotePatch }
	| { op: "delete"; id: string };

/**
 * Runs inside osascript (JXA). Must stay fully self-contained: no imports, no outer refs.
 */
function notesScript(a: Op): unknown {
	const app = Application("Notes");

	const iso = (d: any) => (d ? new Date(d).toISOString() : "");
	const snippet = (t: string | null) =>
		t === null ? null : t.replace(/\s+/g, " ").trim().slice(0, 200);
	const escHtml = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	// Plain text → Notes HTML: one <div> per line, empty lines as <br>.
	const textToHtml = (s: string) =>
		s
			.split(/\r?\n/)
			.map((l) => (l.trim() === "" ? "<div><br></div>" : `<div>${escHtml(l)}</div>`))
			.join("");
	const toHtml = (s: string, format: string) => (format === "html" ? s : textToHtml(s));
	const titleHtml = (t: string) => `<div><h1>${escHtml(t)}</h1></div>`;

	// "Recently Deleted" is an ordinary folder to scripting (no flag, appears only when
	// non-empty); recognise it by its localised name. Hidden unless named explicitly.
	const trash = [
		"recently deleted",
		"zuletzt gelöscht",
		"supprimés récemment",
		"eliminado recientemente",
		"eliminati di recente",
		"recent verwijderd",
	];
	const isTrash = (name: string) => trash.indexOf(name.toLowerCase()) !== -1;

	const folders = (includeTrash = false) => {
		const out: { f: any; account: string }[] = [];
		for (const acc of app.accounts()) {
			const accName = acc.name();
			for (const f of acc.folders()) {
				if (includeTrash || !isTrash(f.name())) out.push({ f, account: accName });
			}
		}
		return out;
	};

	const findFolder = (name: string) => {
		const all = folders(true);
		const wanted = name.toLowerCase();
		// Accept "Folder" or "Account/Folder".
		const hits = all.filter(
			({ f, account }) =>
				f.name().toLowerCase() === wanted ||
				`${account}/${f.name()}`.toLowerCase() === wanted,
		);
		if (hits.length === 0) {
			const names = all.map(({ f, account }) => `${account}/${f.name()}`).join(", ");
			throw new Error(`No Notes folder named "${name}". Folders: ${names}`);
		}
		if (hits.length > 1) {
			const names = hits.map(({ f, account }) => `${account}/${f.name()}`).join(", ");
			throw new Error(`Folder name "${name}" is ambiguous: ${names}. Use Account/Folder.`);
		}
		return hits[0];
	};

	const byId = (id: string) => {
		const n = app.notes.byId(id);
		try {
			n.name();
		} catch (e) {
			throw new Error(`No note with id ${id}`);
		}
		return n;
	};

	const full = (n: any, includeHtml: boolean) => {
		const locked = Boolean(n.passwordProtected());
		const text = locked ? null : String(n.plaintext());
		const c = n.container();
		let account = "";
		try {
			account = c.container().name();
		} catch (e) {
			account = "";
		}
		return {
			id: n.id(),
			title: n.name(),
			folder: c.name(),
			account,
			modified: iso(n.modificationDate()),
			created: iso(n.creationDate()),
			locked,
			snippet: snippet(text),
			text,
			html: includeHtml && !locked ? String(n.body()) : null,
			shared: Boolean(n.shared()),
			attachments: n.attachments.name(),
		};
	};

	const writable = (n: any) => {
		if (n.passwordProtected()) throw new Error("Note is password-protected; unlock it in Notes first");
	};

	switch (a.op) {
		case "folders":
			return folders().map(({ f, account }) => ({
				id: f.id(),
				name: f.name(),
				account,
				noteCount: f.notes.length,
			}));
		case "list": {
			const q = a.q;
			const scope = q.folder ? [findFolder(q.folder)] : folders();
			const needle = q.query ? q.query.toLowerCase() : null;
			const out: any[] = [];
			for (const { f, account } of scope) {
				const notes = f.notes;
				// Batched property reads: one Apple event per property, not per note.
				const ids = notes.id();
				if (ids.length === 0) continue;
				const names = notes.name();
				const mods = notes.modificationDate();
				const creates = notes.creationDate();
				const locks = notes.passwordProtected();
				const texts = notes.plaintext();
				const folderName = f.name();
				for (let i = 0; i < ids.length; i++) {
					const text = locks[i] ? null : String(texts[i] ?? "");
					if (
						needle &&
						!String(names[i]).toLowerCase().includes(needle) &&
						!(text && text.toLowerCase().includes(needle))
					) {
						continue;
					}
					out.push({
						id: ids[i],
						title: names[i],
						folder: folderName,
						account,
						modified: iso(mods[i]),
						created: iso(creates[i]),
						locked: Boolean(locks[i]),
						snippet: snippet(text),
					});
				}
			}
			out.sort((x, y) => (x.modified < y.modified ? 1 : x.modified > y.modified ? -1 : 0));
			return out.slice(0, q.limit);
		}
		case "get":
			return full(byId(a.id), a.html);
		case "create": {
			const n = a.n;
			const target = n.folder ? findFolder(n.folder).f : app.defaultAccount().defaultFolder();
			const body = titleHtml(n.title) + (n.body ? toHtml(n.body, n.format) : "");
			const note = app.Note({ body });
			target.notes.push(note);
			return full(note, false);
		}
		case "update": {
			const n = byId(a.id);
			writable(n);
			const p = a.patch;
			if (p.body !== undefined) {
				n.body = titleHtml(p.title ?? n.name()) + toHtml(p.body, p.format);
			} else if (p.title !== undefined) {
				// Title is the first line of the body; replace only that line.
				const html = String(n.body());
				const rest = html.replace(/^\s*<div>(?:(?!<\/div>).)*<\/div>/s, "");
				n.body = titleHtml(p.title) + rest;
			}
			if (p.append !== undefined) {
				n.body = String(n.body()) + toHtml(p.append, p.format);
			}
			return full(n, false);
		}
		case "delete": {
			const n = byId(a.id);
			writable(n);
			app.delete(n);
			return null;
		}
	}
}

const run = <R>(op: Op): Promise<R> => runJxa(notesScript, op, { app: "Notes" }) as Promise<R>;

export const notesBridge: NotesBridge = {
	listFolders: () => run({ op: "folders" }),
	listNotes: (q) => run({ op: "list", q }),
	getNote: (id, includeHtml) => run({ op: "get", id, html: includeHtml }),
	createNote: (n) => run({ op: "create", n }),
	updateNote: (id, patch) => run({ op: "update", id, patch }),
	deleteNote: (id) => run<null>({ op: "delete", id }).then(() => undefined),
};
