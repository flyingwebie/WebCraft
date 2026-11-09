import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { z } from "zod";

import type { ModuleComponent } from "./component.ts";
import type { ModuleContext, ModuleTable, ProcedureContext, SiteRouteContext } from "./context.ts";
import type { ModuleEvent, ModuleEventName } from "./events.ts";
import type { ImportSource } from "./imports.ts";
import type { Label, ModuleManifestInput } from "./manifest.ts";
import type { NotFoundLog, RedirectRules } from "./redirects.ts";
import type { ModuleSchedule, SubmissionReceiver } from "./submissions.ts";
import type { ModuleMigration } from "./tables.ts";

/**
 * Everything a Module is: its manifest and what it adds to WebCraft. Export one from the Module's
 * package with `defineModule`:
 *
 *     export default defineModule({
 *       manifest: { id: "sample", version: "1.0.0", sdk: "^1.0.0", level: "site", … },
 *       tables: [notes],
 *       migrations: [{ name: "0001-notes", sql: "CREATE TABLE notes (…)" }],
 *       procedures: { notes: { list: procedure({ … }) } },
 *       siteRoutes: [siteRoute({ method: "GET", path: "/notes", … })],
 *       adminPages: [{ path: "notes", label: { en: "Notes" }, permission: "notes.view" }],
 *       events: { "entry.published": async (event, context) => { … } },
 *       jobs: { remind: job({ payload: z.object({ … }), run: async (payload, context) => { … } }) },
 *       components: [component({ name: "NoteCard", label: { en: "Note card" }, markup: "<aside>…</aside>" })],
 *     });
 *
 * WebCraft checks a definition when it loads it and never runs a Module whose definition breaks a
 * rule (it is listed with the reason on the Modules screen).
 */
export type ModuleDefinition = {
	manifest: ModuleManifestInput;
	/** The Module's tables, parents before the tables that point at them (see `moduleSchema`). */
	tables?: readonly ModuleTable[];
	/** The SQL that creates and changes its tables, oldest first (see `ModuleMigration`). */
	migrations?: readonly ModuleMigration[];
	/**
	 * Its procedures in the Management API, by name, nested in groups: `{ notes: { list } }` is
	 * `m.sample.notes.list`. Each takes the Site (`siteId`) or Workspace (`workspaceId`) besides its
	 * own input, and runs only where the Module is on, for people holding its Permission.
	 */
	procedures?: ModuleProcedures;
	/** Requests it answers on Sites, under `/_wc/m/<routePrefix>/`. Never cached. Site-level Modules only. */
	siteRoutes?: readonly SiteRoute[];
	/** Its pages in the admin, at the Site (or Workspace) level, shown where it is on. */
	adminPages?: readonly AdminPage[];
	/** What it does after something happens on a Site, as background jobs. */
	events?: ModuleEventHandlers;
	/** Its own background jobs, queued with `context.jobs.send(name, payload)`. */
	jobs?: Readonly<Record<string, ModuleJob>>;
	/**
	 * Components Staff place with their tags on Sites where it runs (Site-level Modules only); see
	 * `component`. Added in SDK 1.1.
	 */
	components?: readonly ModuleComponent[];
	/**
	 * Its jobs that run on a schedule, in every place where it runs: `{ job: "purge", every: "day" }`.
	 * Added in SDK 1.2.
	 */
	schedules?: readonly ModuleSchedule[];
	/**
	 * How it keeps Form Submissions, which WebCraft hands it once it checked them (Site-level Modules
	 * only; at most one Module of a build). Forms render only where such a Module runs. Added in SDK 1.2.
	 */
	formSubmissions?: SubmissionReceiver;
	/**
	 * The script it adds to Site pages where it runs (Site-level Modules only): its code, which WebCraft
	 * serves as a file from the Site's own domain (`/_wc/js/<hash>.js`, never inline) and pages load with
	 * `defer` after the Site's own scripts. The manifest declares its Consent category (`siteScript`),
	 * and the Consent banner holds it back until visitors accept that category; `window.webcraft.consent`
	 * says what they chose. It never runs in Edit mode. Added in SDK 1.3; `beforeConsent` in 1.4.
	 */
	siteScript?: ModuleSiteScript;
	/**
	 * Its tables kept in monthly partitions by a time column (SDK 1.4), for rows that pile up, such
	 * as raw events: WebCraft makes each month's partition ahead of time, and drops a whole month once
	 * all of it is older than the Install keeps it (`keepMonths` until the Superadmin changes it).
	 * Each table must be made `PARTITION BY RANGE (<column>)` in the Module's migrations, with the
	 * column in its primary key; WebCraft makes the partitions themselves.
	 */
	partitions?: readonly ModulePartitioning[];
	/**
	 * How it keeps the Sites' Redirect rules, which the Site pipeline asks before the Site's own pages
	 * (Site-level Modules only; at most one Module of a build). See `redirectRules`. Added in SDK 1.5.
	 */
	redirectRules?: RedirectRules;
	/**
	 * How it keeps the Sites' 404 log: the Site pipeline hands it the paths its 404 page answered, in
	 * the background (Site-level Modules only; at most one Module of a build). See `notFoundLog`.
	 * Added in SDK 1.5.
	 */
	notFoundLog?: NotFoundLog;
	/**
	 * The sources it imports content from (Site-level Modules only): how each reads its file into
	 * items, which WebCraft's Import pipeline maps, previews and writes as Drafts. See `importSource`.
	 * Added in SDK 1.7.
	 */
	importSources?: readonly ImportSource[];
	// Later SDK versions open more extension points; until then a Module can't use them:
	/** Structure presets (#110). */
	structurePresets?: readonly never[];
	/** Declarative Block types: settings made of Fields, output in Template markup (#103). */
	blockTypes?: readonly never[];
	/** Dashboard Widgets. */
	widgets?: readonly never[];
};

/**
 * A Module's Site script: its JavaScript, as text (at most `MODULE_SITE_SCRIPT_MAX_LENGTH` characters).
 *
 * With `beforeConsent` (SDK 1.4), the Consent banner doesn't hold the script back: it runs before
 * visitors answer, and after they decline, so it must itself hold back everything that needs its
 * category (reading `webcraft.consent.has(category)` and the `webcraft:consent` event). Pages
 * carrying it still ask visitors for its category. The Superadmin approves that separately.
 */
export type ModuleSiteScript = { code: string; beforeConsent?: boolean };

/** One of a Module's tables kept in monthly partitions (see `ModuleDefinition.partitions`). */
export type ModulePartitioning = {
	table: ModuleTable;
	/** The `timestamp with time zone` column its rows are partitioned by, such as when an event happened. */
	column: AnyPgColumn;
	/** What its rows are, for the Superadmin: "Raw events". */
	label: Label;
	/** How many months its rows are kept until the Superadmin changes it: 1 to 120. */
	keepMonths: number;
};

/** How long a Module's Site script may be, in characters. */
export const MODULE_SITE_SCRIPT_MAX_LENGTH = 200_000;

/** Declares a Module. It only gives the definition back, typed: WebCraft checks it when it loads it. */
export function defineModule<const Definition extends ModuleDefinition>(definition: Definition): Definition {
	return definition;
}

/** A Module procedure's input: an object schema. WebCraft adds `siteId` or `workspaceId` to it. */
export type ProcedureInput = z.ZodObject;

export type ModuleProcedure<Input extends ProcedureInput = ProcedureInput, Output = unknown> = {
	/** The Permission a person needs: one of the Module's (`notes.edit`) or a WebCraft one (`structure.edit`). */
	permission: string;
	input: Input;
	run(input: z.output<Input>, context: ProcedureContext): Promise<Output>;
};

export type ModuleProcedures = { readonly [name: string]: ModuleProcedure | ModuleProcedures };

/** Declares a procedure, typing `run`'s input from the schema. */
export function procedure<Input extends ProcedureInput, Output>(
	definition: ModuleProcedure<Input, Output>,
): ModuleProcedure<Input, Output> {
	return definition;
}

/** A request a Module answers on Sites where it is on. */
export type SiteRoute = {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** The path under the route prefix: `/`, `/notes`, `/notes/:id`. */
	path: string;
	/**
	 * How many requests one visitor's address may send it on a Site, in a window of `perSeconds`
	 * (SDK 1.4): WebCraft answers 429 with `Retry-After` beyond that, before the route runs.
	 */
	limit?: { requests: number; perSeconds: number };
	/**
	 * The largest body it takes, in bytes (SDK 1.4): WebCraft answers 413 to a bigger one, before the
	 * route runs, without reading more of it.
	 */
	maxBodyBytes?: number;
	handle(request: Request, context: SiteRouteContext): Promise<Response>;
};

export function siteRoute(route: SiteRoute): SiteRoute {
	return route;
}

/**
 * A page of the Module's in the admin, in the sidebar of the Sites (or Workspaces) it is on, for
 * people holding `permission`. It opens at `/sites/<id>/m/<module id>/<path>`.
 */
export type AdminPage = {
	/** Lower-case letters, digits and dashes, such as `notes`. */
	path: string;
	label: Label;
	/** One of the Module's Permissions (`notes.view`) or a WebCraft one. */
	permission: string;
};

export type ModuleEventHandlers = {
	readonly [Name in ModuleEventName]?: (event: ModuleEvent<Name>, context: ModuleContext) => Promise<void>;
};

/**
 * One of the Module's background jobs. A failure goes to the Module log; the job is tried twice
 * more, a minute and then a few minutes later.
 */
export type ModuleJob<Payload = unknown> = {
	payload: z.ZodType<Payload>;
	run(payload: Payload, context: ModuleContext): Promise<void>;
};

export function job<Payload>(definition: ModuleJob<Payload>): ModuleJob<Payload> {
	return definition;
}

/**
 * A Module's procedures as a typed client calls them, such as the admin's pages or a test:
 * `(api.m.sample as ModuleApi<typeof sample>).notes.list({ siteId })`.
 */
export type ModuleApi<Definition extends ModuleDefinition> = ProceduresApi<
	NonNullable<Definition["procedures"]>,
	Definition["manifest"]["level"] extends "workspace" ? { workspaceId: string } : { siteId: string }
>;

/** An input with no keys of its own (`z.object({})`) reads as `Record<string, never>`, which would swallow the place's key. */
type OwnInput<Input> = string extends keyof Input ? unknown : Input;

type ProceduresApi<Procedures, Place> = {
	[Name in keyof Procedures]: Procedures[Name] extends ModuleProcedure<infer Input, infer Output>
		? (input: OwnInput<z.input<Input>> & Place) => Promise<Awaited<Output>>
		: ProceduresApi<Procedures[Name], Place>;
};
