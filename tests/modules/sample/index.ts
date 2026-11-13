// The sample Module: a working example of every extension point the Module SDK opens, and the
// Module the Module host's tests drive. It imports nothing from WebCraft but the SDK.
import {
	component,
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
	"submissions",
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
		sdk: "^1.3.0",
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
		siteScript: "analytics",
	},
	tables: [notes],
	migrations,
	procedures: {
		notes: {
			list: procedure({
				permission: "notes.view",
				kind: "read",
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
				input: z.object({
					noteId: z.uuid(),
					delaySeconds: z.number().int().min(0).max(86_400),
					/** Gives up after queuing the reminder, so the transaction rolls back. */
					giveUp: z.boolean().default(false),
				}),
				async run({ noteId, delaySeconds, giveUp }, context) {
					await context.transaction(async (tx) => {
						await tx.jobs.send("remind", { noteId }, { delaySeconds });
						if (giveUp) throw new ModuleError("gave-up", "The sample gave up on the reminder.", 409);
					});
					return { queued: true };
				},
			}),
		},
		settings: {
			/** Calls the hook with its token in the URL; answers the status, or everything it could read of the failure. */
			checkHook: procedure({
				permission: "structure.edit",
				input: z.object({}),
				async run(_input, context) {
					const token = context.secrets.placeholder("hook-token");
					try {
						const response = await context.http(`https://hooks.sample.example/check/${token}?token=${token}`);
						return { status: response.status, seen: null };
					} catch (error) {
						return { status: null, seen: everythingIn(error) };
					}
				},
			}),
			/** Calls the hook with its token, and answers everything it read back: its body and an echoed header. */
			echoHook: procedure({
				permission: "structure.edit",
				input: z.object({}),
				async run(_input, context) {
					const token = context.secrets.placeholder("hook-token");
					const response = await context.http(`https://hooks.sample.example/echo?token=${token}`, {
						headers: { authorization: `Bearer ${token}` },
					});
					return { status: response.status, body: await response.text(), echoed: response.headers.get("x-echo") };
				},
			}),
			setHookToken: procedure({
				permission: "structure.edit",
				input: z.object({ token: z.string().min(1).max(500) }),
				async run({ token }, context) {
					await context.secrets.set("hook-token", token);
					return { token: await context.secrets.describe("hook-token") };
				},
			}),
		},
		/** Changes a note with whatever the caller sent, as a careless Module might. */
		changeNote: procedure({
			permission: "notes.edit",
			input: z.object({ noteId: z.uuid(), changes: z.record(z.string(), z.unknown()) }),
			async run({ noteId, changes }, context) {
				const [note] = await context.data.update(notes, changes as { body: string }, eq(notes.id, noteId));
				return { note: note ? view(note) : null };
			},
		}),
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
			path: "/cookies",
			async handle(request) {
				// Tries to read and set WebCraft's own cookies on the Site's domain: WebCraft strips both.
				const headers = new Headers({ "content-type": "application/json" });
				headers.append("set-cookie", "webcraft.edit=forged; Path=/");
				headers.append("set-cookie", "sample-seen=1; Path=/");
				return new Response(JSON.stringify({ cookie: request.headers.get("cookie") }), { headers });
			},
		}),
		siteRoute({
			method: "GET",
			path: "/page",
			async handle() {
				// An HTML answer with a script and a policy of the Module's own that would let it run.
				return new Response("<!doctype html><title>Sample</title><script>window.sampleRan = 1</script>", {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"content-security-policy": "script-src 'unsafe-inline'",
					},
				});
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
			await context.log.info("Heard that an Entry was published.", event.data);
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
	components: [
		component({
			name: "NoteCard",
			label: { en: "Note card", it: "Scheda nota" },
			props: [
				{ key: "body", label: { en: "Text", it: "Testo" }, type: "text", required: true },
				{
					key: "tone",
					label: { en: "Tone", it: "Tono" },
					type: "select",
					options: [
						{ value: "calm", label: "Calm" },
						{ value: "loud", label: "Loud" },
					],
					default: "calm",
				},
			],
			markup: '<aside data-tone="{{ props.tone.value }}"><p>{{ props.body }}</p></aside>',
		}),
	],
	jobs: {
		remind: job({
			payload: z.object({ noteId: z.uuid() }),
			async run({ noteId }, context) {
				const note = await context.data.first(notes, eq(notes.id, noteId));
				await context.log.info("Reminded about a note.", { noteId, found: note !== undefined });
			},
		}),
	},
	// Counts a page view once visitors accept Analytics (the manifest's `siteScript` category).
	siteScript: {
		code: 'document.documentElement.dataset.sampleNotes = "counted";\n',
	},
});

/** Every text a Module can read of an error and the errors behind it: what must never hold a secret. */
function everythingIn(error: unknown, depth = 0): string[] {
	if (depth > 4 || error === null || typeof error !== "object") return [String(error)];
	const texts: string[] = [];
	for (const key of Object.getOwnPropertyNames(error)) {
		const value = (error as Record<string, unknown>)[key];
		if (key === "cause") texts.push(...everythingIn(value, depth + 1));
		else texts.push(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
	}
	return [...texts, String(error)];
}

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
		case "submissions":
			// Form Submissions are the Forms Module's, never another Module's (SDK 1.6).
			await context.submissions.deliveries("00000000-0000-4000-8000-000000000001");
			return;
	}
}
