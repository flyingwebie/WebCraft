// The sample Module: a working example of every extension point the Module SDK opens, and the
// Module the Module host's tests drive. It imports nothing from WebCraft but the SDK.
import {
	defineModule,
	desc,
	eq,
	job,
	type ModuleContext,
	ModuleError,
	ModuleRefusedError,
	procedure,
	siteRoute,
	z,
} from "@webcraft/module-sdk";

import { migrations } from "./migrations.ts";
import { elsewhere, notes, stray } from "./tables.ts";

/** The outside host the sample calls when an Entry is published. */
export const SAMPLE_HOOK = "https://hooks.sample.example/published";

/** The things the sample's `probe` procedure tries, each of which WebCraft must refuse. */
export const PROBES = [
	"stray-table",
	"other-module-table",
	"undeclared-host",
	"undeclared-job",
	"undeclared-permission",
	"bad-secret-name",
	"unset-secret",
	"email",
] as const;

const view = (note: typeof notes.$inferSelect) => ({
	id: note.id,
	body: note.body,
	source: note.source,
	createdAt: note.createdAt,
});

async function addNote(context: ModuleContext, body: string, source: "person" | "visitor" | "module") {
	return view(await context.data.insert(notes, { body, source, createdAt: context.now() }));
}

export const sample = defineModule({
	manifest: {
		id: "sample",
		name: { en: "Sample notes", it: "Note di esempio" },
		description: {
			en: "Keeps notes on each Site: the Module SDK's working example.",
			it: "Tiene note su ogni Sito: l'esempio funzionante dell'SDK dei Moduli.",
		},
		version: "1.0.0",
		sdk: "^1.0.0",
		level: "site",
		onByDefault: true,
		adminLanguages: ["en", "it"],
		permissions: [
			{
				key: "notes.view",
				label: { en: "See the notes", it: "Vedere le note" },
				roles: ["staff", "owner", "editor", "author"],
			},
			{
				key: "notes.edit",
				label: { en: "Write notes and send them by email", it: "Scrivere note e inviarle per email" },
				roles: ["staff", "owner", "editor"],
			},
		],
		uses: ["email"],
		outsideHosts: ["hooks.sample.example"],
		routePrefix: "sample",
	},
	tables: [notes],
	migrations,
	procedures: {
		notes: {
			list: procedure({
				permission: "notes.view",
				input: z.object({}),
				async run(_input, context) {
					const rows = await context.data.select(notes, undefined, { orderBy: [desc(notes.createdAt)] });
					return { notes: rows.map(view) };
				},
			}),
			add: procedure({
				permission: "notes.edit",
				input: z.object({ body: z.string().trim().min(1).max(500) }),
				async run({ body }, context) {
					return context.transaction(async (tx) => {
						const note = await addNote(tx, body, "person");
						await tx.audit("note.add", { noteId: note.id });
						return { note };
					});
				},
			}),
			share: procedure({
				permission: "notes.edit",
				input: z.object({ noteId: z.uuid(), email: z.string().max(320) }),
				async run({ noteId, email }, context) {
					const note = await context.data.first(notes, eq(notes.id, noteId));
					if (!note) throw new ModuleError("note-not-found", "There is no such note.", 404);
					const results = await context.email.send({
						to: { email },
						subject: { en: "A note for you", it: "Una nota per te" },
						heading: { en: "A note for you", it: "Una nota per te" },
						paragraphs: [{ en: note.body, it: note.body }],
					});
					return { results };
				},
			}),
			remind: procedure({
				permission: "notes.edit",
				input: z.object({ noteId: z.uuid(), delaySeconds: z.number().int().min(0).max(86_400) }),
				async run({ noteId, delaySeconds }, context) {
					await context.jobs.send("remind", { noteId }, { delaySeconds });
					return { queued: true };
				},
			}),
		},
		settings: {
			setHookToken: procedure({
				permission: "structure.edit",
				input: z.object({ token: z.string().min(1).max(500) }),
				async run({ token }, context) {
					await context.secrets.set("hook-token", token);
					return { token: await context.secrets.describe("hook-token") };
				},
			}),
		},
		broken: procedure({
			permission: "notes.view",
			input: z.object({}),
			async run() {
				throw new Error("The sample's broken procedure broke, as it should.");
			},
		}),
		probe: procedure({
			permission: "notes.edit",
			input: z.object({ attempt: z.enum(PROBES) }),
			async run({ attempt }, context) {
				try {
					await probe(attempt, context);
					return { refused: null };
				} catch (error) {
					if (error instanceof ModuleRefusedError) return { refused: error.reason };
					throw error;
				}
			},
		}),
	},
	siteRoutes: [
		siteRoute({
			method: "GET",
			path: "/notes",
			async handle(_request, context) {
				const rows = await context.data.select(notes, undefined, { orderBy: [desc(notes.createdAt)] });
				return Response.json({ notes: rows.map((note) => ({ body: note.body, source: note.source })) });
			},
		}),
		siteRoute({
			method: "POST",
			path: "/notes",
			async handle(request, context) {
				const form = await request.formData();
				const body = String(form.get("body") ?? "").trim();
				if (!body) return new Response("A note needs some text.", { status: 400 });
				const note = await addNote(context, body, "visitor");
				return Response.json({ note: { id: note.id, body: note.body } }, { status: 201 });
			},
		}),
		siteRoute({
			method: "GET",
			path: "/notes/:id",
			async handle(_request, context) {
				const id = context.params.id ?? "";
				const note = /^[0-9a-f-]{36}$/.test(id) ? await context.data.first(notes, eq(notes.id, id)) : undefined;
				if (!note) return new Response("Not Found", { status: 404 });
				return Response.json({ body: note.body });
			},
		}),
		siteRoute({
			method: "GET",
			path: "/broken",
			async handle() {
				throw new Error("The sample's broken route broke, as it should.");
			},
		}),
	],
	adminPages: [{ path: "notes", label: { en: "Notes", it: "Note" }, permission: "notes.view" }],
	events: {
		async "entry.published"(event, context) {
			const note = await addNote(context, `Entry ${event.data.entryId} was published.`, "module");
			await context.audit("note.add", { noteId: note.id, entryId: event.data.entryId });
			const token = await context.secrets.describe("hook-token");
			const response = await context.http(SAMPLE_HOOK, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(token.set ? { authorization: `Bearer ${context.secrets.placeholder("hook-token")}` } : {}),
				},
				body: JSON.stringify({ entryId: event.data.entryId, siteId: event.siteId }),
				timeoutMs: 2000,
			});
			if (!response.ok) throw new Error(`The hook answered ${response.status}.`);
		},
	},
	jobs: {
		remind: job({
			payload: z.object({ noteId: z.uuid() }),
			async run({ noteId }, context) {
				const note = await context.data.first(notes, eq(notes.id, noteId));
				await context.log.info("Reminded about a note.", { noteId, found: note !== undefined });
			},
		}),
	},
});

/** Tries one thing the sample never declared; WebCraft must refuse each. */
async function probe(attempt: (typeof PROBES)[number], context: ModuleContext): Promise<void> {
	switch (attempt) {
		case "stray-table":
			await context.data.select(stray);
			return;
		case "other-module-table":
			await context.data.select(elsewhere);
			return;
		case "undeclared-host":
			await context.http("https://elsewhere.example/");
			return;
		case "undeclared-job":
			await context.jobs.send("nope", {});
			return;
		case "undeclared-permission":
			(context as ModuleContext & { can(permission: string): boolean }).can("notes.delete");
			return;
		case "bad-secret-name":
			await context.secrets.set("Not A Name", "value");
			return;
		case "unset-secret":
			await context.http(SAMPLE_HOOK, { headers: { authorization: context.secrets.placeholder("never-set") } });
			return;
		case "email":
			await context.email.send({
				to: { email: "someone@client.example" },
				subject: { en: "Only in English" },
				heading: { en: "Only in English" },
				paragraphs: [],
			});
			return;
	}
}
