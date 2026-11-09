import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Label } from "./manifest.ts";

/**
 * What a Module's code gets when it runs: in a procedure, a Site route, an event or a job. It is
 * the Module's only way to WebCraft. Everything it reaches is limited to one place (the Site or
 * Workspace it is acting in) and to what its manifest declares; anything else is refused with
 * `ModuleRefusedError`. Secrets never reach Module code: WebCraft fills them into outgoing calls.
 */
export type ModuleContext = {
	readonly module: { readonly id: string; readonly version: string };
	/** Where the Module is acting: one Site (Site-level Modules) or one Workspace. */
	readonly place: ModulePlace;
	/** The time, from WebCraft's clock. */
	now(): Date;
	/** The Module's own tables, limited to this place. */
	readonly data: ModuleData;
	/**
	 * Records an action in the Audit log, named under the Module's id: `audit("note.add", { … })` is
	 * `sample.note.add`. Who, when, how, the Workspace and the Site are filled in. Never put a
	 * secret's value in `details`.
	 */
	audit(action: string, details?: Record<string, unknown>): Promise<void>;
	/** Sends an email (needs `uses: ["email"]`). */
	readonly email: ModuleEmail;
	/**
	 * Calls an outside host the manifest declares, over HTTP or HTTPS. Refused for any other host,
	 * for addresses inside the server's network (checked after DNS and after every redirect), after
	 * 3 redirects, after `timeoutMs` (10 s, at most 30 s) and above `maxBytes` (5 MB, at most 20 MB).
	 * The answer's body is read in full before it is handed back.
	 */
	http(url: string | URL, options?: ModuleHttpOptions): Promise<Response>;
	/** The Module's own secrets in this place. */
	readonly secrets: ModuleSecrets;
	/** The Module's own background jobs. */
	readonly jobs: {
		/** Queues one of the Module's jobs to run in this place, after `delaySeconds` if given. */
		send(job: string, payload: unknown, options?: { delaySeconds?: number }): Promise<void>;
	};
	/** Writes to the Module log, which the Superadmin reads on the Modules screen. */
	readonly log: ModuleLog;
	/** Runs `work` in one transaction: its table changes and Audit log entries are saved together or not at all. */
	transaction<Result>(work: (context: ModuleContext) => Promise<Result>): Promise<Result>;
};

/** A Module procedure's context: the place, plus the person calling it. */
export type ProcedureContext = ModuleContext & {
	readonly person: { readonly id: string; readonly language: string };
	/** Whether the person holds one of the Module's Permissions (its key: `notes.edit`), or a WebCraft one, here. */
	can(permission: string): boolean;
};

/** A Site route's context: the place, plus the route's parameters (`/notes/:id` gives `params.id`). */
export type SiteRouteContext = ModuleContext & { readonly params: Readonly<Record<string, string>> };

export type ModulePlace =
	| { readonly level: "site"; readonly workspaceId: string; readonly siteId: string }
	| { readonly level: "workspace"; readonly workspaceId: string };

/** A table of the Module's: a Site table or a Workspace table in its schema (see `moduleSchema`). */
export type ModuleTable = PgTable & { workspaceId: AnyPgColumn };

/**
 * The values of a new row. WebCraft fills in `workspaceId`, and `siteId` in a Site place; a
 * Workspace-level Module names the Site of a Site table's row itself.
 */
export type NewModuleRow<Table extends ModuleTable> = Omit<InferInsertModel<Table>, "workspaceId" | "siteId"> & {
	siteId?: string;
};

export type ModuleSelectOptions = { orderBy?: readonly (SQL | AnyPgColumn)[]; limit?: number };

/**
 * Queries on the Module's own tables, limited to the place. `where` is an extra condition, built
 * with the operators the SDK exports (`eq`, `and`, …); the place's own condition is always added.
 * Any other table is refused.
 */
export type ModuleData = {
	select<Table extends ModuleTable>(
		table: Table,
		where?: SQL,
		options?: ModuleSelectOptions,
	): Promise<InferSelectModel<Table>[]>;
	first<Table extends ModuleTable>(
		table: Table,
		where?: SQL,
		options?: Omit<ModuleSelectOptions, "limit">,
	): Promise<InferSelectModel<Table> | undefined>;
	count<Table extends ModuleTable>(table: Table, where?: SQL): Promise<number>;
	insert<Table extends ModuleTable>(table: Table, values: NewModuleRow<Table>): Promise<InferSelectModel<Table>>;
	update<Table extends ModuleTable>(
		table: Table,
		set: Partial<NewModuleRow<Table>>,
		where?: SQL,
	): Promise<InferSelectModel<Table>[]>;
	delete<Table extends ModuleTable>(table: Table, where?: SQL): Promise<number>;
};

/** Who an email goes to: a person with an account, or an address. */
export type ModuleEmailRecipient = { personId: string } | { email: string; language?: string };

/**
 * An email, in the Module's languages. Each recipient gets it in their Admin language when the
 * Module has it, otherwise in its first language, inside WebCraft's email layout under Install
 * branding, recorded in the Email log. People with an account can turn Module emails off.
 */
export type ModuleEmailMessage = {
	to: ModuleEmailRecipient | readonly ModuleEmailRecipient[];
	subject: Label;
	heading: Label;
	paragraphs: readonly Label[];
	/** One button, linking to a path in the admin, such as `/sites/<id>`. */
	action?: { label: Label; path: string };
};

export type ModuleEmail = {
	send(message: ModuleEmailMessage): Promise<{ recipient: string; status: "queued" | "logged" | "turned-off" }[]>;
};

export type ModuleHttpOptions = {
	method?: string;
	headers?: Readonly<Record<string, string>>;
	body?: string | URLSearchParams;
	/** How long to wait for the answer: 10 s unless given, at most 30 s. */
	timeoutMs?: number;
	/** The largest answer accepted: 5 MB unless given, at most 20 MB. */
	maxBytes?: number;
};

/**
 * The Module's secrets in this place, such as an API key Staff typed in: written, described and
 * removed, never read back. To use one, put `placeholder(name)` where its value goes in an
 * outgoing call (`http`: the URL, a header or the body); WebCraft puts the value there itself, only
 * for the hosts the manifest declares. A call that carries a secret never follows a redirect.
 */
export type ModuleSecrets = {
	/** Stores or replaces a secret. Names: lower-case letters, digits, `.`, `_` and `-`, at most 100. */
	set(name: string, value: string): Promise<void>;
	/** Whether it is set, and its last 4 characters (none for secrets under 16 characters). */
	describe(name: string): Promise<{ set: false } | { set: true; lastFour: string | null; updatedAt: Date }>;
	remove(name: string): Promise<void>;
	/** Stands for the secret's value in an outgoing call. */
	placeholder(name: string): string;
};

export type ModuleLog = {
	info(message: string, details?: Record<string, unknown>): Promise<void>;
	warn(message: string, details?: Record<string, unknown>): Promise<void>;
	error(message: string, details?: Record<string, unknown>): Promise<void>;
};
