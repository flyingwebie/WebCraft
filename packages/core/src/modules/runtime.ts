import type { Database } from "@webcraft/db";
import {
	type Label,
	labelProblem,
	type ModuleContext,
	ModuleError,
	type ModuleHttpOptions,
	type ModulePlace,
	ModuleRefusedError,
	type ProcedureContext,
	type SiteRouteContext,
} from "@webcraft/module-sdk";

import { isAdminLanguage } from "../admin-languages.ts";
import type { AuditVia } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { Email, Recipient } from "../email/index.ts";
import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import type { ModuleActor } from "../permissions/can.ts";
import { SecretNotSetError } from "../secrets/store.ts";
import type { Access, DataLayer } from "../tenancy/data-layer.ts";
import { moduleData, type PlaceScope } from "./data.ts";
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
		message: message.slice(0, 1000),
		workspaceId: place?.workspaceId ?? null,
		siteId: place && "siteId" in place ? (place.siteId ?? null) : null,
		details,
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

/** The context a Module's code runs with at a place opened for it (see `ModuleContext` in the SDK). */
export function moduleContext(module: RunnableModule, scope: PlaceScope, deps: RuntimeDeps): ModuleContext {
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

	return {
		module: { id: module.id, version: manifest.version },
		place: place as ModulePlace,
		now: () => scope.now(),
		data: moduleData(module, scope),
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
				await deps.jobs.send(
					moduleJob,
					{ moduleId: module.id, job: name, place, payload: parsed.data },
					delay > 0 ? { startAfter: delay } : {},
				);
			},
		},
		log: { info: log("info"), warn: log("warn"), error: log("error") },
		transaction: (work) => scope.transaction((tx) => work(moduleContext(module, tx, deps))),
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
	};
}

export function routeContext(
	module: RunnableModule,
	scope: PlaceScope,
	deps: RuntimeDeps,
	params: Record<string, string>,
): SiteRouteContext {
	return { ...moduleContext(module, scope, deps), params };
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
): Promise<Response> {
	const hosts = module.manifest.outsideHosts;
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
	const texts = [target.toString(), ...Object.values(headers), body ?? ""];
	const names = [...new Set(texts.flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "")))];

	const call = async (values: ReadonlyMap<string, string>) => {
		const fill = (text: string) => text.replace(PLACEHOLDER, (_, name: string) => values.get(name) ?? "");
		const request = new Request(fill(target.toString()), {
			method: options.method ?? "GET",
			headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, fill(value)])),
			body: body === undefined ? undefined : fill(body),
		});
		try {
			return await deps.fetch(request, {
				allowedHosts: hosts,
				timeoutMs: options.timeoutMs,
				maxBytes: options.maxBytes,
				// A call that carries a secret never follows a redirect: the secret stays with the declared host.
				maxRedirects: values.size > 0 ? 0 : undefined,
			});
		} catch (error) {
			if (error instanceof GuardedFetchError && ["host", "address", "scheme"].includes(error.problem)) {
				throw new ModuleRefusedError("host", error.message);
			}
			throw error;
		}
	};

	const withSecrets = async (remaining: readonly string[], values: Map<string, string>): Promise<Response> => {
		const [name, ...rest] = remaining;
		if (name === undefined) return call(values);
		try {
			return await scope.secrets.useWith(`module:${module.id}:${name}`, (value) =>
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

/** Whether an error is a Module's own answer (`ModuleError`), which isn't a failure. */
export function isModuleAnswer(error: unknown): error is ModuleError {
	return error instanceof ModuleError;
}
