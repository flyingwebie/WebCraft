import type { Database } from "@webcraft/db";
import {
	type FormSender,
	isModuleError,
	type KeptSubmission,
	type Label,
	type LiveConnection,
	labelProblem,
	type ModuleContext,
	type ModuleError,
	type ModuleHttpOptions,
	type ModulePlace,
	ModuleRefusedError,
	type ProcedureContext,
	type SiteRouteContext,
	type SiteVisitor,
	type SubmissionDelivery,
} from "@webcraft/module-sdk";

import { isAdminLanguage } from "../admin-languages.ts";
import type { AuditVia } from "../audit.ts";
import type { Clock } from "../clock.ts";
import { askConfirmation, ConfirmationInvalidError, useConfirmation } from "../confirmations.ts";
import type { Email, Recipient } from "../email/index.ts";
import type { FormUploads } from "../forms/uploads.ts";
import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import type { ModuleActor } from "../permissions/can.ts";
import { redactText, redactValue } from "../redaction.ts";
import { SecretNotSetError } from "../secrets/store.ts";
import type { Access, DataLayer, Site, SiteScope } from "../tenancy/data-layer.ts";
import { type EnsurePartition, moduleData, type PlaceScope } from "./data.ts";
import { discoverImportRoot, importRoute, importRouteUrl } from "./import-http.ts";
import { moduleJob, type QueuedPlace } from "./jobs.ts";
import { type ModuleLogLevel, writeModuleLog } from "./module-log.ts";
import type { RunnableModule } from "./registry.ts";

/** What running Modules needs from the Install. */
export type RuntimeDeps = {
	database: Database;
	data: DataLayer;
	email: Email;
	jobs: JobQueue;
	fetch: GuardedFetch;
	clock: Clock;
	log: Logger;
	/** Makes the month's partition before a row goes into a partitioned table (see `partitions.ts`). */
	ensurePartition?: EnsurePartition;
	/**
	 * What follows a kept Form Submission, for the Module keeping them (`context.submissions`): its
	 * Notifications, Auto-reply and Webhooks, and `form.submitted` when its sender is known.
	 */
	submissions?: {
		kept(site: Site, submission: KeptSubmission, sender: FormSender | null): Promise<void>;
		deliveries(site: Site, submissionId: string): Promise<SubmissionDelivery[]>;
	};
	/**
	 * Form uploads, for the Module keeping Submissions (`context.submissions.removeUploads` and
	 * `uploadUrl`): their files go when it deletes Submissions.
	 */
	uploads?: Pick<FormUploads, "remove" | "url" | "attach" | "removeSite">;
};

/** A Module acting by itself (a job, an event, a Site route) at a place: as `can()` and the Audit log see it. */
export function moduleAccess(module: RunnableModule, place: QueuedPlace): Access {
	const actor: ModuleActor = {
		kind: "module",
		moduleId: module.id,
		permissions: [...module.permissions.values()].map((permission) => permission.key),
		place,
	};
	const via: AuditVia = { kind: "module", name: module.id };
	return { actor, via };
}

/** Opens a Module's place through the data layer, for `access` (a person, or the Module itself). */
export async function openPlace(data: DataLayer, access: Access, place: QueuedPlace): Promise<PlaceScope> {
	return place.level === "site"
		? data.site(access, place.siteId, "site.view")
		: data.workspace(access, place.workspaceId, "workspace.view");
}

export function placeOf(scope: PlaceScope): QueuedPlace {
	return scope.level === "site"
		? { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id }
		: { level: "workspace", workspaceId: scope.workspace.id };
}

/** Writes a line to a Module's log, for its place. */
export async function writeLine(
	deps: Pick<RuntimeDeps, "database" | "clock">,
	module: { id: string },
	place: Partial<QueuedPlace> | null,
	level: ModuleLogLevel,
	message: string,
	details: Record<string, unknown> = {},
): Promise<void> {
	await writeModuleLog(deps.database.db, deps.clock.now(), {
		moduleId: module.id,
		level,
		// The same redaction as the process's log lines: no secret or person's content is kept.
		message: redactText(message.slice(0, 1000)),
		workspaceId: place?.workspaceId ?? null,
		siteId: place && "siteId" in place ? (place.siteId ?? null) : null,
		details: redactValue(details) as Record<string, unknown>,
	});
}

/** An error as the Module log keeps it: its kind and message, never a stack. */
export function describeError(error: unknown): Record<string, unknown> {
	if (error instanceof ModuleRefusedError) return { name: error.name, reason: error.reason, message: error.message };
	if (error instanceof Error) return { name: error.name, message: error.message };
	return { name: "Error", message: String(error) };
}

const AUDIT_ACTION = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PLACEHOLDER = /\{\{wc-secret:([a-z0-9][a-z0-9._-]{0,99})\}\}/g;
/** A placeholder as it reads in a URL's path, where the braces are percent-encoded. */
const ENCODED_PLACEHOLDER = /%7B%7Bwc-secret:([a-z0-9][a-z0-9._-]{0,99})%7D%7D/gi;

/**
 * The context a Module's code runs with at a place opened for it (see `ModuleContext` in the SDK).
 * Inside `transaction`, `afterCommit` holds what waits for the commit: jobs the Module queued, which
 * never run when the transaction rolls back.
 */
export function moduleContext(
	module: RunnableModule,
	scope: PlaceScope,
	deps: RuntimeDeps,
	afterCommit: (() => Promise<void>)[] | null = null,
): ModuleContext {
	const { manifest } = module;
	const place = placeOf(scope);
	const refuse = (reason: ConstructorParameters<typeof ModuleRefusedError>[0], message: string): never => {
		throw new ModuleRefusedError(reason, message);
	};
	const secretName = (name: string) => {
		if (typeof name !== "string" || !SECRET_NAME.test(name)) {
			refuse(
				"secret",
				`A secret name is lower-case letters, digits, ".", "_" and "-", at most 100: not ${String(name)}.`,
			);
		}
		return `module:${module.id}:${name}`;
	};
	const log = (level: ModuleLogLevel) => (message: string, details?: Record<string, unknown>) =>
		writeLine(deps, module, place, level, message, details);
	/** The Site of the Module keeping Form Submissions: anything else is refused. */
	const keepingSite = (): Site => {
		if (!module.receiver || scope.level !== "site") {
			return refuse("submissions", `The Module ${module.id} doesn't keep Form Submissions here.`);
		}
		return scope.site;
	};

	return {
		module: { id: module.id, version: manifest.version },
		place: place as ModulePlace,
		now: () => scope.now(),
		data: moduleData(module, scope, {
			inTransaction: afterCommit !== null,
			ensurePartition: deps.ensurePartition,
		}),
		async audit(action, details) {
			if (!AUDIT_ACTION.test(action)) {
				throw new TypeError(`An Audit log action is <noun>.<verb>, such as note.add: not ${action}.`);
			}
			await scope.audit(`${module.id}.${action}`, details);
		},
		email: {
			async send(message) {
				if (!manifest.uses.includes("email")) {
					refuse("use", `The Module ${module.id} doesn't declare that it uses email.`);
				}
				const languages = manifest.adminLanguages;
				const labels: [string, Label][] = [
					["subject", message.subject],
					["heading", message.heading],
					...message.paragraphs.map((paragraph, index): [string, Label] => [`paragraph ${index + 1}`, paragraph]),
					...(message.action ? [["button", message.action.label] as [string, Label]] : []),
				];
				for (const [where, words] of labels) {
					const problem = labelProblem(words ?? {}, languages);
					if (problem) refuse("email", `The email's ${where}: ${problem}`);
				}
				const to = (Array.isArray(message.to) ? message.to : [message.to]).map(
					(recipient): Recipient =>
						"personId" in recipient
							? { personId: recipient.personId }
							: {
									email: recipient.email,
									...(recipient.language && isAdminLanguage(recipient.language)
										? { language: recipient.language }
										: {}),
								},
				);
				let results: Awaited<ReturnType<Email["send"]>>;
				try {
					// A Site-level Module's email is the Site's mail (SDK 1.6): it goes as the Site's mail does,
					// through the Site's own SMTP when it has one, else the Install SMTP under the Site's name.
					const site =
						scope.level === "site" ? { id: scope.site.id, route: await deps.email.siteMail.route(scope) } : undefined;
					results = await deps.email.send({
						type: "module-message",
						to,
						data: {
							moduleName: manifest.name,
							languages: [...languages],
							subject: message.subject,
							heading: message.heading,
							paragraphs: [...message.paragraphs],
							action: message.action ?? null,
						},
						related: { kind: "module", id: module.id },
						...(site ? { site } : {}),
					});
				} catch (error) {
					if (error instanceof Error && error.name === "ZodError")
						refuse("email", `The email isn't one WebCraft sends: ${error.message}`);
					throw error;
				}
				return results.map(({ recipient, status }) => ({ recipient, status }));
			},
		},
		http: (url, options) => moduleHttp(module, scope, deps, url, options),
		secrets: {
			set: (name, value) => scope.secrets.set(secretName(name), value),
			describe: (name) => scope.secrets.describe(secretName(name)),
			remove: (name) => scope.secrets.remove(secretName(name)),
			placeholder: (name) => {
				secretName(name);
				return `{{wc-secret:${name}}}`;
			},
		},
		jobs: {
			async send(name, payload, options = {}) {
				const job = module.jobs.get(name);
				if (!job) throw new ModuleRefusedError("job", `The Module ${module.id} has no job ${name}.`);
				const parsed = job.payload.safeParse(payload);
				if (!parsed.success) refuse("job", `The job ${name} doesn't take that payload: ${parsed.error.message}`);
				const delay = options.delaySeconds ?? 0;
				const send = () =>
					deps.jobs
						.send(
							moduleJob,
							{ moduleId: module.id, job: name, place, payload: parsed.data },
							delay > 0 ? { startAfter: delay } : {},
						)
						.then(() => {});
				if (afterCommit) afterCommit.push(send);
				else await send();
			},
		},
		log: { info: log("info"), warn: log("warn"), error: log("error") },
		submissions: {
			async kept(submission) {
				const site = keepingSite();
				await deps.submissions?.kept(site, submission, submission.sender ?? null);
			},
			async deliveries(submissionId) {
				const site = keepingSite();
				if (typeof submissionId !== "string") return [];
				return (await deps.submissions?.deliveries(site, submissionId)) ?? [];
			},
			async removeUploads(submissionIds) {
				const site = keepingSite();
				if (!deps.uploads || !Array.isArray(submissionIds)) return 0;
				const ids = submissionIds.filter((id): id is string => typeof id === "string");
				// The rows go in the Module's transaction; the files once it commits (at once outside one).
				const later = afterCommit ? (work: () => Promise<void>) => afterCommit.push(work) : undefined;
				return deps.uploads.remove(scope as SiteScope, site, ids, later);
			},
			uploadUrl(uploadId) {
				const site = keepingSite();
				if (!deps.uploads || typeof uploadId !== "string") return "";
				return deps.uploads.url(site, uploadId);
			},
		},
		async transaction(work) {
			if (afterCommit) return scope.transaction((tx) => work(moduleContext(module, tx, deps, afterCommit)));
			const pending: (() => Promise<void>)[] = [];
			const result = await scope.transaction((tx) => work(moduleContext(module, tx, deps, pending)));
			for (const send of pending) await send();
			return result;
		},
	};
}

/** A procedure's context: the place's, plus the person calling and their Permissions there. */
export function procedureContext(
	module: RunnableModule,
	scope: PlaceScope,
	deps: RuntimeDeps,
	person: { id: string; language: string },
	holds: (permission: string) => boolean,
): ProcedureContext {
	const actionOf = (action: string) => {
		if (typeof action !== "string" || !AUDIT_ACTION.test(action)) {
			throw new TypeError(`A confirmation's action is <noun>.<verb>, such as notes.delete: not ${action}.`);
		}
		return `${module.id}.${action}`;
	};
	return {
		...moduleContext(module, scope, deps),
		person,
		can(permission) {
			try {
				return holds(permission);
			} catch {
				throw new ModuleRefusedError("permission", `The Module ${module.id} declares no Permission ${permission}.`);
			}
		},
		confirmations: {
			ask: (action, target, preview) => askConfirmation(scope, { action: actionOf(action), target, preview }),
			use: async (id, action, target, preview) => {
				await useConfirmation(scope, id, { action: actionOf(action), target, preview });
			},
		},
	};
}

export function routeContext(
	module: RunnableModule,
	scope: PlaceScope,
	deps: RuntimeDeps,
	params: Record<string, string>,
	visitor: SiteVisitor,
): SiteRouteContext {
	return { ...moduleContext(module, scope, deps), params, visitor };
}

/**
 * A Module's outgoing call: only to its declared hosts, through the guarded fetcher, with its
 * secrets filled in where it put their placeholders (never following a redirect then).
 */
async function moduleHttp(
	module: RunnableModule,
	scope: PlaceScope,
	deps: RuntimeDeps,
	url: string | URL,
	options: ModuleHttpOptions = {},
	binding?: { host: string; secretName: string },
): Promise<Response> {
	const hosts = binding ? [binding.host] : module.manifest.outsideHosts;
	let target: URL;
	try {
		target = new URL(String(url));
	} catch {
		throw new ModuleRefusedError("host", `${String(url)} isn't an address.`);
	}
	if (!hosts.includes(target.hostname.toLowerCase())) {
		throw new ModuleRefusedError("host", `The Module ${module.id} doesn't declare the host ${target.hostname}.`);
	}
	const headers = { ...options.headers };
	const body = options.body instanceof URLSearchParams ? options.body.toString() : options.body;
	if (
		options.body instanceof URLSearchParams &&
		!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")
	) {
		headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
	}
	const address = target.toString();
	const texts = [address, ...Object.values(headers), body ?? ""];
	const names = [
		...new Set(
			texts.flatMap((text) =>
				[...text.matchAll(PLACEHOLDER), ...text.matchAll(ENCODED_PLACEHOLDER)].map((match) => match[1] ?? ""),
			),
		),
	];

	const call = async (values: ReadonlyMap<string, string>) => {
		const fill = (text: string) => text.replace(PLACEHOLDER, (_, name: string) => values.get(name) ?? "");
		// In the address a secret is percent-encoded, so no character of it can change where the call goes.
		const fillAddress = (text: string) =>
			text
				.replace(ENCODED_PLACEHOLDER, (_, name: string) => encodeURIComponent(values.get(name) ?? ""))
				.replace(PLACEHOLDER, (_, name: string) => encodeURIComponent(values.get(name) ?? ""));
		try {
			const request = new Request(fillAddress(address), {
				method: options.method ?? "GET",
				headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, fill(value)])),
				body: body === undefined ? undefined : fill(body),
			});
			const response = await deps.fetch(request, {
				allowedHosts: hosts,
				timeoutMs: options.timeoutMs,
				maxBytes: options.maxBytes,
				// A call that carries a secret never follows a redirect: the secret stays with the declared host.
				maxRedirects: binding || values.size > 0 ? 0 : undefined,
			});
			if (!binding) return values.size > 0 ? withoutSecrets(response, [...values.values()]) : response;
			let content = await response.text();
			const clean = (input: string) => {
				let out = input;
				for (const value of values.values()) {
					const encoded = value.replace(/^Basic /, "");
					const decoded = Buffer.from(encoded, "base64").toString("utf8");
					const colon = decoded.indexOf(":");
					for (const secret of [value, encoded, decoded, decoded.slice(colon + 1)]) {
						if (!secret) continue;
						out = out.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
						out = out.split(secret).join("[redacted]");
					}
				}
				return out;
			};
			content = clean(content);
			return new Response([204, 205, 304].includes(response.status) ? null : content, {
				status: response.status,
				headers: Object.fromEntries(
					[...response.headers]
						.filter(([name]) => ["content-type", "x-wp-total", "x-wp-totalpages"].includes(name))
						.map(([name, value]) => [name, clean(value)]),
				),
			});
		} catch (error) {
			// Only WebCraft's own words reach the Module, never the error behind them: an adapter's error
			// can name the address, with a secret filled into it.
			if (error instanceof GuardedFetchError) {
				if (["host", "address", "scheme"].includes(error.problem)) throw new ModuleRefusedError("host", error.message);
				throw new GuardedFetchError(error.problem, error.message);
			}
			throw new GuardedFetchError("unreachable", `The call to ${target.host} couldn't be made.`);
		}
	};

	const withSecrets = async (remaining: readonly string[], values: Map<string, string>): Promise<Response> => {
		const [name, ...rest] = remaining;
		if (name === undefined) return call(values);
		try {
			return await scope.secrets.useWith(binding?.secretName ?? `module:${module.id}:${name}`, (value) =>
				withSecrets(rest, new Map(values).set(name, value)),
			);
		} catch (error) {
			if (error instanceof SecretNotSetError) {
				throw new ModuleRefusedError("secret", `The Module's secret ${name} isn't set.`);
			}
			throw error;
		}
	};
	return withSecrets(names, new Map());
}

/**
 * What a host answered a Module's own call that carried secrets, with every one of them taken out
 * (as written, JSON-escaped, or percent-encoded as the address carries it) from its body and its
 * headers: a host that repeats the request it got must not hand a secret to the Module's code. The
 * body is worked on as bytes, so an answer that isn't text arrives as it was sent.
 */
async function withoutSecrets(response: Response, secrets: readonly string[]): Promise<Response> {
	const forms = [
		...new Set(
			secrets.flatMap((secret) =>
				secret ? [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)] : [],
			),
		),
	].sort((a, b) => b.length - a.length);
	const clean = (text: string) => forms.reduce((out, form) => out.split(form).join("[redacted]"), text);
	// One Latin-1 character per byte: a secret is found by its UTF-8 bytes, and other bytes stay as they are.
	let bytes = Buffer.from(await response.arrayBuffer()).toString("latin1");
	for (const form of forms) bytes = bytes.split(Buffer.from(form, "utf8").toString("latin1")).join("[redacted]");
	const headers = new Headers();
	for (const [name, value] of response.headers) {
		// The body was read (and decoded) here: its length and encoding are no longer the host's.
		if (name === "content-length" || name === "content-encoding") continue;
		headers.append(name, clean(value));
	}
	return new Response([204, 205, 304].includes(response.status) ? null : Buffer.from(bytes, "latin1"), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Whether an error is a Module's own answer (`ModuleError`), which isn't a failure. */
export function isModuleAnswer(error: unknown): error is ModuleError | ConfirmationInvalidError {
	return isModuleError(error) || error instanceof ConfirmationInvalidError;
}

/** Core-only binding: a live source can GET only beneath the authorized REST root. */
export function importSourceHttp(
	module: RunnableModule,
	scope: SiteScope,
	deps: RuntimeDeps,
	config: { address: string; secretName: string },
): LiveConnection["http"] {
	let root: Promise<URL> | undefined;
	return async (path, { anonymous = false } = {}) => {
		if (!module.manifest.uses.includes("importSourceHttp"))
			throw new ModuleRefusedError("host", "Source requests were not approved.");
		// Refuse an escaped route before doing even unauthenticated discovery.
		const route = importRoute(config.address, path);
		root ??= discoverImportRoot(config.address, deps.fetch);
		const target = importRouteUrl(await root, route);
		if (!anonymous) await scope.audit("import.credentials.use", { source: module.id, host: target.host });
		return moduleHttp(
			module,
			scope,
			deps,
			target,
			{ headers: anonymous ? {} : { authorization: "{{wc-secret:login}}" }, maxBytes: 5 * 1024 * 1024 },
			{ host: target.hostname, secretName: config.secretName },
		);
	};
}
