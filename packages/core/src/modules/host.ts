import type { ModuleSchema } from "@webcraft/db";
import { moduleApprovals, moduleSwitches, people, sites, workspaces } from "@webcraft/db/schema";
import {
	type AddedRule,
	type FormSender,
	type FormSubmission,
	formSenderCounted,
	type ImportedRule,
	type ImportedRuleResult,
	type ImportSource,
	isModuleError,
	type KeptSubmission,
	type Label,
	MODULE_EVENTS,
	type ModuleContext,
	type ModuleDefinition,
	type ModuleEventName,
	type ModuleEvents,
	ModuleRefusedError,
	type ModuleWidget,
	type PageMiss,
	type RedirectRequest,
	type RedirectTarget,
	type SourceFile,
	type SourceItem,
	type WidgetData,
	type WidgetOption,
	type WidgetRequest,
	wordsIn,
} from "@webcraft/module-sdk";
import { and, eq, getTableName, isNull } from "drizzle-orm";

import type { AuditDetails, RecordedAuditEntry } from "../audit.ts";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import type { ComponentSources, ModuleComponent } from "../content/components.ts";
import { clearEveryPageCache, clearPageCache } from "../content/page-cache.ts";
import { canonicalPath, pathSegments } from "../content/url-patterns.ts";
import { isWebCraftCookie, withoutWebCraftCookies } from "../cookies.ts";
import type { Countries } from "../countries.ts";
import type { SubmissionActions } from "../forms/kept.ts";
import { type AddedPermission, can, personIdOf } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import type { RateLimits } from "../rate-limits.ts";
import type { NotedMiss, RedirectPaths } from "../site-pages/redirects.ts";
import type { Access, InstallScope, Site } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError, WorkspaceNotFoundError } from "../tenancy/errors.ts";
import {
	type AdditionsView,
	additionsView,
	type ConsentView,
	consentItems,
	consentView,
	isCovered,
} from "./consent.ts";
import { moduleData, type PlaceScope, placeQueries } from "./data.ts";
import {
	ModuleCannotRunError,
	ModuleChangedError,
	ModuleFailedError,
	ModuleNotApprovedError,
	ModuleNotFoundError,
} from "./errors.ts";
import {
	moduleEventJob,
	moduleJob,
	moduleMissesJob,
	type QueuedEvent,
	type QueuedJob,
	type QueuedMisses,
	type QueuedPlace,
} from "./jobs.ts";
import { listModuleLog, type ModuleLogLine } from "./module-log.ts";
import { createPartitionKeeper, type PartitionView } from "./partitions.ts";
import {
	type CompiledRoute,
	type LoadedModule,
	loadModules,
	type ModuleRegistry,
	type ModuleSiteScriptFile,
	type RunnableModule,
	resolvePermission,
} from "./registry.ts";
import {
	describeError,
	isModuleAnswer,
	moduleAccess,
	moduleContext,
	openPlace,
	placeOf,
	procedureContext,
	type RuntimeDeps,
	routeContext,
	writeLine,
} from "./runtime.ts";
import { schemasOf } from "./schemas.ts";
import { createVisitors, formSenderOf, type SiteRouteRequest } from "./visitors.ts";

/**
 * Where a Module stands on this Install:
 * - `cannot-run`: its definition breaks a rule of the Module SDK; WebCraft never runs it.
 * - `waiting`: the Superadmin hasn't approved it (or withdrew the approval).
 * - `update-waiting`: this version asks for more than the Superadmin approved for an earlier one;
 *   it is off everywhere until they approve it.
 * - `approved`: it runs wherever it is on.
 */
export type ModuleStatus = "cannot-run" | "waiting" | "update-waiting" | "approved";

/** A Module on the Install's Modules screen and its consent screen. */
export type ModuleView = {
	id: string;
	name: string;
	description: string;
	version: string;
	level: "site" | "workspace";
	onByDefault: boolean;
	status: ModuleStatus;
	/** Why WebCraft can't run it, for `cannot-run`. */
	problem: string | null;
	approval: { version: string; approvedAt: Date; approvedBy: string | null } | null;
	asks: ConsentView;
	adds: AdditionsView;
	/** Its tables kept in monthly partitions, with how many months the Install keeps their rows. */
	partitions: PartitionView[];
};

/** A Module where Staff switch it: on a Site (Site-level Modules) or a Workspace (Workspace-level ones). */
export type PlaceModuleView = {
	id: string;
	name: string;
	description: string;
	version: string;
	status: ModuleStatus;
	/** Staff's switch here (the Module's `onByDefault` until they change it). It runs only when also approved. */
	on: boolean;
	onByDefault: boolean;
};

/** What removing a Module's data from a place deletes, by table; asked for first, then confirmed. */
export type ModuleDataRemoval =
	| { removed: false; tables: { table: string; rows: number }[]; secrets: number; confirmation: Confirmation }
	| { removed: true; tables: { table: string; rows: number }[]; secrets: number };

/** One of a Module's admin pages a person may open at a place. */
export type ModulePageView = { moduleId: string; path: string; label: string };

/** An Audit log entry as the Module host hears of it, once its change is saved. */
export type RecordedAction = RecordedAuditEntry;

/** A call to one of a Module's procedures, by a person through the Management API. */
export type ProcedureCall = {
	access: Access;
	person: { id: string; language: string };
	moduleId: string;
	/** Its dotted name, such as `notes.add`. */
	procedure: string;
	/** The Site (Site-level Modules) or Workspace it is called on. */
	placeId: string;
	input: unknown;
};

/** The Module host: what WebCraft knows about Modules and runs for them (`services.modules`). */
export type ModuleHost = {
	readonly registry: ModuleRegistry;
	/** What the `migrate` step and the schema check need to know about this Install's Modules. */
	readonly schemas: ModuleSchema[];
	/** The Components Modules declare: their names, and those that may be placed on a Site (where the Module runs). */
	readonly components: ComponentSources;
	/** Every Module of this build, for the Superadmin (open the Install with `module.approve`). */
	list(scope: InstallScope, language: string): Promise<ModuleView[]>;
	/**
	 * Approves everything `version` of a Module asks for (a Sensitive action: it grants access).
	 * Refuses another version than this Install runs, which the consent screen would have shown.
	 */
	approve(scope: InstallScope, moduleId: string, version: string): Promise<void>;
	/** Withdraws a Module's approval: it stops everywhere, keeping its data, until approved again. */
	withdraw(scope: InstallScope, moduleId: string): Promise<void>;
	/** A Module's newest Module log lines, for the Superadmin. */
	log(scope: InstallScope, moduleId: string, options: { limit: number }): Promise<ModuleLogLine[]>;
	/** The Modules Staff switch at a place (open it with `module.manage`). */
	placeList(scope: PlaceScope, language: string): Promise<PlaceModuleView[]>;
	/** Switches a Module on or off at a place (`module.manage`). Off keeps its data; only approved Modules switch on. */
	setOn(scope: PlaceScope, moduleId: string, on: boolean, language: string): Promise<PlaceModuleView>;
	/**
	 * Removes a Module's data from a place, in two steps (`module.manage`): the first call deletes
	 * nothing and answers how many rows of each table and how many secrets would go, with a
	 * confirmation id; the second, with the id, deletes them and switches the Module off there.
	 */
	removeData(scope: PlaceScope, moduleId: string, confirmation?: string): Promise<ModuleDataRemoval>;
	/** The admin pages of the Modules running at a place that the scope's person may open. */
	pages(scope: PlaceScope, language: string): Promise<ModulePageView[]>;
	/**
	 * The Permissions Modules add that the scope's person holds at the place, of the Modules running
	 * there (`forms.submissions.view`): the admin shows what they allow, such as a Form's Submissions.
	 */
	permissionsAt(scope: PlaceScope): Promise<string[]>;
	/** Runs one of a Module's procedures for a person, where the Module runs and they hold its Permission. */
	callProcedure(call: ProcedureCall): Promise<unknown>;
	/**
	 * The outside hosts the Site-level Modules running on a Site declare, with each Module's id and name
	 * (in `language`): the Site's Content Security Policy allows them there, and nowhere else.
	 */
	outsideHostsAt(
		site: { id: string; workspaceId: string },
		language: string,
	): Promise<{ host: string; moduleId: string; module: string }[]>;
	/**
	 * The Site scripts of the Site-level Modules running on a Site (SDK 1.3), each with its Module's id,
	 * the file it is served as and the Consent category its manifest declares.
	 */
	siteScriptsAt(site: { id: string; workspaceId: string }): Promise<ModuleSiteScriptOnSite[]>;
	/** Answers a request under `/_wc/m/<prefix>/` on a Site, or null when no running Module answers it. */
	answerSiteRoute(route: SiteRouteRequest, request: Request): Promise<Response | null>;
	/** Queues the event an Audit log entry stands for, for each Module that reacts to it. Never throws. */
	afterAudit(entry: RecordedAction): Promise<void>;
	/** Runs a queued event (the `modules.event` job). */
	runEvent(payload: QueuedEvent): Promise<void>;
	/** Runs a queued job of a Module's (the `modules.job` job). */
	runJob(payload: QueuedJob): Promise<void>;
	/** Queues the Modules' jobs scheduled `every` hour or day, once in each place where their Module runs. */
	runSchedules(every: "hour" | "day"): Promise<void>;
	/**
	 * The Module that keeps Form Submissions on a Site, when one runs there: Forms render, and take
	 * posts, only then. Null otherwise.
	 */
	submissionsKeptBy(site: { id: string; workspaceId: string }): Promise<string | null>;
	/**
	 * Hands a checked Submission to the Module that keeps them on the Site, at once, and answers its
	 * id. Throws `ModuleNotFoundError` where none runs, and `ModuleFailedError` when it fails (in the
	 * Module log). A kept Submission that isn't spam then sets off what follows (its Notifications,
	 * Auto-reply and Webhooks), and is told to Modules as `form.submitted`, with what WebCraft knows of
	 * its sender (`FormSender`), worked out from `sender` (the post) and handed to the Module with it.
	 */
	receiveSubmission(
		site: Site,
		submission: Omit<FormSubmission, "sender">,
		sender: { route: SiteRouteRequest; request: Request },
	): Promise<{ id: string }>;
	/** Changes how many months the Install keeps a Module's partitioned table's rows (`module.approve`). */
	setKeepMonths(scope: InstallScope, moduleId: string, table: string, months: number): Promise<void>;
	/** Makes Modules' partitions ahead of time and drops the months past keeping (the daily job). */
	maintainPartitions(): Promise<void>;
	/** Deletes the salts of visitors' ids of days that ended (the daily job). */
	purgeSalts(): Promise<number>;
	/**
	 * Where the Redirect rules of the Module keeping them send a request for a Site path (SDK 1.5),
	 * following a target that is itself a Site path through the rules again (at most
	 * `MAX_REDIRECT_HOPS` rules; a 302 anywhere makes the whole a 302; a longer chain sends visitors on
	 * from the last of them, said in the Module log). A rule made to step aside where a page answers
	 * does so. Null when no Module keeping rules runs on the Site, no rule applies, or the rules go
	 * round in a circle (said once in the Module log, the Site's pages then answering). Never throws: a `find` that fails or takes longer than `FIND_TIMEOUT_MS` is "no rule".
	 */
	redirectFor(
		site: Site,
		request: RedirectRequest,
		paths: RedirectPaths,
	): Promise<Pick<RedirectTarget, "to" | "status"> | null>;
	/**
	 * Which of many Site paths a rule (not one made to step aside where a page answers) would send
	 * elsewhere, first hop only, for lists of a Site's pages (its sitemaps): the Module's `findMany`
	 * (SDK 1.10) in one go, else its `find` for each path. Follow each with `redirectFor` for the
	 * whole answer (chains, circles, targets that no longer exist). Never throws: a Module that fails
	 * or takes longer than `FIND_MANY_TIMEOUT_MS` answers "no rule" for every path, said in the
	 * Module log.
	 */
	pathsWithRules(site: Site, requests: readonly RedirectRequest[]): Promise<Set<string>>;
	/** Whether this build has a Module keeping the 404 log (SDK 1.5). */
	readonly keepsNotFoundLog: boolean;
	/**
	 * Notes a request a Site's 404 page answered, for the Module keeping the 404 log. Nothing waits
	 * for it: misses are gathered (one entry per path, language and referring host) and handed to the
	 * Module in the background, a batch per Site, by `flushMisses`: every few seconds in the web
	 * process, at once past `MISS_BATCH_SIZE` entries, and by the test harness before it drains jobs.
	 */
	noteMiss(site: Site, miss: NotedMiss): void;
	/** Queues the gathered misses, one job per Site where the Module keeping the 404 log runs. */
	flushMisses(): Promise<void>;
	/** Runs a batch of misses (the `modules.notFound` job). */
	runMisses(payload: QueuedMisses): Promise<void>;
	/** The import sources of the Modules running on a Site (SDK 1.7), in `language`. */
	importSourcesAt(site: { id: string; workspaceId: string }, language: string): Promise<ImportSourceView[]>;
	/** One import source (`<module id>.<key>`) where its Module runs on the Site; null otherwise. */
	importSource(site: { id: string; workspaceId: string }, sourceId: string): Promise<RunningSource | null>;
	/**
	 * Whether a Module adding Redirect rules for Import runs runs on the Site (SDK 1.7): without one,
	 * a run makes no Redirect rules.
	 */
	importRedirectsOn(site: { id: string; workspaceId: string }): Promise<boolean>;
	/**
	 * Adds an Import run's Redirect rules through the Module keeping them on the Site; null when none
	 * that adds them runs there. A failure goes to the Module log and is thrown on.
	 */
	addImportedRules(
		site: { id: string; workspaceId: string },
		rules: readonly ImportedRule[],
	): Promise<ImportedRuleResult[] | null>;
	/** Removes Redirect rules an Import run added (Undo); 0 when no Module keeping them runs there. */
	removeImportedRules(site: { id: string; workspaceId: string }, rules: readonly AddedRule[]): Promise<number>;
	/**
	 * The Widget kinds Modules add to Dashboards (SDK 1.8): each runnable Site-level Module's, with its
	 * id and name in `language`, whether or not it runs anywhere.
	 */
	widgetKinds(language: string): WidgetKind[];
	/** Whether a Site-level Module runs on a Site (approved and switched on there). */
	runsOn(site: { id: string; workspaceId: string }, moduleId: string): Promise<boolean>;
	/**
	 * Runs a Widget kind's query on a Site, as its Module acting by itself, once the caller checked
	 * that the person may see the Dashboard. A refusal (`ModuleError`), a Module that doesn't run on
	 * the Site, and a failure (written to the Module log) come back as the Widget's problem.
	 */
	runWidget(
		site: { id: string; workspaceId: string },
		moduleId: string,
		kind: string,
		request: WidgetRequest,
	): Promise<WidgetAnswer>;
	/** The options a Widget setting offers on a Site (worked out there for some, such as its Goals); none where the Module doesn't run. */
	widgetOptions(
		site: { id: string; workspaceId: string },
		moduleId: string,
		kind: string,
		setting: string,
	): Promise<readonly WidgetOption[]>;
	/** The names of the Goals a Module's Widgets can be filtered by on a Site; none where it doesn't run. */
	widgetGoals(site: { id: string; workspaceId: string }, moduleId: string): Promise<readonly string[]>;
};

/** An import source of a Module running on a Site (SDK 1.7), as the Source step offers it. */
export type ImportSourceView = {
	/** `<module id>.<key>`, such as `wordpress-import.export`: an Import's `source`. */
	id: string;
	moduleId: string;
	label: string;
	description: string;
	/** The Permission a person needs besides `import.run`. */
	permission: string;
	maxBytes: number;
	extensions: readonly string[];
};

/** An import source of a Module running on a Site, ready to read a file. */
export type RunningSource = ImportSourceView & {
	/** The Permission as `can()` takes it. */
	needs: AddedPermission | Permission;
	/**
	 * Reads a file into items, as the Module acting by itself on the Site. A `ModuleError` it throws
	 * is its refusal of the file; anything else goes to the Module log before it is thrown on.
	 */
	read(file: SourceFile): AsyncIterable<SourceItem>;
};

/** A Widget kind a Module adds, as Dashboards see it. */
export type WidgetKind = {
	moduleId: string;
	module: string;
	/** The Module's admin languages, the first its fallback: its Widgets' words come in them. */
	languages: readonly string[];
	widget: ModuleWidget;
};

/** What a Widget kind's query answered on one Site: its data, or the problem that kept it from counting. */
export type WidgetAnswer = { data: WidgetData; problem: null } | { data: null; problem: WidgetProblem };

/**
 * Why a Widget shows nothing on a Site: its Module's own refusal (`code` its own, such as
 * `GOAL_NOT_FOUND`), `MODULE_NOT_RUNNING` (switched off there, or waiting for approval),
 * `WIDGET_UNKNOWN` (no Module of this build adds it) or `WIDGET_FAILED` (in the Module log).
 */
export type WidgetProblem = { code: string; message: string };

/** How many Redirect rules the Site pipeline follows in one answer; a longer chain goes on in the next request. */
export const MAX_REDIRECT_HOPS = 5;

/** How long the Site pipeline waits for a Module's `find`, in milliseconds. */
export const FIND_TIMEOUT_MS = 500;

/** How long a list of a Site's pages waits for a Module's rules for a batch of paths, in milliseconds. */
export const FIND_MANY_TIMEOUT_MS = 5_000;

/** How many distinct misses a web process gathers before it hands them over at once. */
export const MISS_BATCH_SIZE = 500;

/** How many distinct misses a web process holds at most; more, between two hand-overs, are dropped. */
const MAX_HELD_MISSES = 5000;

/** A Media library file as a Redirect rule's target (SDK 1.7): `media:<id>`. */
const MEDIA_TARGET = /^media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** An Entry as a Redirect rule's target (SDK 1.7): `entry:<id>`, or `entry:<id>:<language>`. */
const ENTRY_TARGET =
	/^entry:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([a-z]{2,3}(?:-[a-z0-9]{2,8})*))?$/i;

/** A Site path a Redirect rule may send visitors to: `/…`, never `//…` (another host), no backslash or control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const SITE_TARGET = /^\/(?![/\\])[^\\\u0000-\u0020\u007f]*$/;

export type ModuleHostOptions = RuntimeDeps & {
	modules: readonly ModuleDefinition[];
	/** What follows a kept Form Submission (`forms/kept.ts`). */
	submissionActions?: SubmissionActions;
	rateLimits: RateLimits;
	countries: Countries;
	/** The key visitors' daily ids are made with (`visitorIdKey`). */
	visitorIdKey: CryptoKey;
};

/** A Module's Site script on a Site where the Module runs. */
export type ModuleSiteScriptOnSite = ModuleSiteScriptFile & { moduleId: string };

/** The Audit log actions Modules hear of, as SDK events with the data the SDK promises. */
const EVENTS_OF_ACTIONS: Record<
	string,
	{ event: ModuleEventName; data: (details: AuditDetails) => object; when?: (details: AuditDetails) => boolean }
> = {
	"entry.publish": {
		event: "entry.published",
		data: ({ entryId, postTypeId, path, pathChanges }) => ({
			entryId,
			postTypeId,
			path,
			pathChanges: pathChanges ?? [],
		}),
	},
	"entry.delete": { event: "entry.deleted", data: ({ entryId, postTypeId }) => ({ entryId, postTypeId }) },
	"template.publish": { event: "template.published", data: ({ templateId }) => ({ templateId }) },
	"globals.publish": { event: "globals.published", data: () => ({}) },
	"postType.update": {
		event: "paths.changed",
		data: ({ postTypeId, pathChanges }) => ({ reason: "urlPattern", postTypeId, pathChanges }),
		when: ({ pathChanges }) => Array.isArray(pathChanges) && pathChanges.length > 0,
	},
	"defaultLanguage.change": {
		event: "paths.changed",
		data: ({ pathChanges }) => ({ reason: "defaultLanguage", postTypeId: null, pathChanges }),
		when: ({ pathChanges }) => Array.isArray(pathChanges) && pathChanges.length > 0,
	},
};

const PLAIN = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

export function createModuleHost(hostOptions: ModuleHostOptions): ModuleHost {
	const { database, modules, data, jobs, log, rateLimits } = hostOptions;
	const registry = loadModules(modules);
	const { db } = database;
	const partitions = createPartitionKeeper({ database, clock: hostOptions.clock, registry });
	const visitors = createVisitors({
		database,
		clock: hostOptions.clock,
		countries: hostOptions.countries,
		idKey: hostOptions.visitorIdKey,
	});
	const options: RuntimeDeps = { ...hostOptions, ensurePartition: partitions.ensure };

	/** What the Superadmin approved for each Module, by id. */
	const approvals = async (moduleId?: string) => {
		const rows = await db
			.select({
				moduleId: moduleApprovals.moduleId,
				version: moduleApprovals.version,
				granted: moduleApprovals.granted,
				approvedAt: moduleApprovals.approvedAt,
				approvedBy: people.name,
			})
			.from(moduleApprovals)
			.leftJoin(people, eq(people.id, moduleApprovals.approvedBy))
			.where(moduleId === undefined ? undefined : eq(moduleApprovals.moduleId, moduleId));
		return new Map(rows.map((row) => [row.moduleId, row]));
	};

	const statusOf = (module: LoadedModule, granted: readonly string[] | undefined): ModuleStatus => {
		if (!module.runnable) return "cannot-run";
		if (granted === undefined) return "waiting";
		return isCovered(module.manifest, granted, module.siteScript?.beforeConsent === true)
			? "approved"
			: "update-waiting";
	};

	const isApproved = async (module: RunnableModule) =>
		statusOf(module, (await approvals(module.id)).get(module.id)?.granted) === "approved";

	const words = (module: LoadedModule, label: Label | undefined, language: string) =>
		label && module.manifest ? wordsIn(label, language, module.manifest.adminLanguages) : "";

	const sourceView = (module: RunnableModule, source: ImportSource, language: string): ImportSourceView => ({
		id: `${module.id}.${source.key}`,
		moduleId: module.id,
		label: words(module, source.label, language),
		description: words(module, source.description, language),
		permission: source.permission,
		maxBytes: source.file.maxBytes,
		extensions: source.file.extensions,
	});

	const find = (moduleId: string): LoadedModule => {
		const module = registry.get(moduleId);
		if (!module) throw new ModuleNotFoundError();
		return module;
	};

	/** A Module of the place's level: Site-level ones on Sites, Workspace-level ones on Workspaces. */
	const atPlace = (scope: PlaceScope, moduleId: string): RunnableModule => {
		const module = registry.get(moduleId);
		if (!module?.runnable || module.level !== scope.level) throw new ModuleNotFoundError();
		return module;
	};

	const switchWhere = (scope: PlaceScope, module: RunnableModule) =>
		scope.level === "site"
			? eq(moduleSwitches.moduleId, module.id)
			: and(eq(moduleSwitches.moduleId, module.id), isNull(moduleSwitches.siteId));

	/** Staff's switch for a Module at a place: their choice, or the Module's default. */
	const switchedOn = async (scope: PlaceScope, module: RunnableModule): Promise<boolean> => {
		const row = await placeQueries(scope).first(moduleSwitches, switchWhere(scope, module));
		return row ? row.on : module.manifest.onByDefault;
	};

	/** Records Staff's switch at a place. */
	const recordSwitch = async (scope: PlaceScope, module: RunnableModule, on: boolean) => {
		const values = { on, changedAt: scope.now(), changedBy: personIdOf(scope.access.actor) };
		const changed = await placeQueries(scope).update(moduleSwitches, values, switchWhere(scope, module));
		if (changed.length > 0) return;
		const row = { moduleId: module.id, ...values };
		if (scope.level === "site") await scope.insert(moduleSwitches, row);
		else await scope.insert(moduleSwitches, { ...row, siteId: null });
	};

	/** Whether a Module runs at a place: approved for this version, and switched on there. */
	const runsAt = async (scope: PlaceScope, module: RunnableModule) =>
		(await isApproved(module)) && (await switchedOn(scope, module));

	/** Whether a Site-level Module runs on a Site, read without opening it (the Site pipeline asks too). */
	const runsOnSite = async (site: { id: string; workspaceId: string }, module: RunnableModule) => {
		if (!(await isApproved(module))) return false;
		const [row] = await db
			.select({ on: moduleSwitches.on })
			.from(moduleSwitches)
			.where(
				and(
					eq(moduleSwitches.moduleId, module.id),
					eq(moduleSwitches.workspaceId, site.workspaceId),
					eq(moduleSwitches.siteId, site.id),
				),
			);
		return row ? row.on : module.manifest.onByDefault;
	};

	/** The Components Modules add: placed on Sites where their Module runs. */
	const components: ComponentSources = {
		allModuleComponents: () => registry.all().flatMap((module) => (module.runnable ? module.components : [])),
		async moduleComponentsAt(site) {
			const found: ModuleComponent[] = [];
			for (const module of registry.all()) {
				if (!module.runnable || module.level !== "site" || module.components.length === 0) continue;
				if (await runsOnSite(site, module)) found.push(...module.components);
			}
			return found;
		},
	};

	/**
	 * Pages show a Module's Components, Forms (where it keeps their Submissions) and Site script, allow
	 * its outside hosts, and follow its Redirect rules, only where it runs: a change to where it runs
	 * clears the pages.
	 */
	const addsComponents = (module: LoadedModule) =>
		module.runnable &&
		(module.components.length > 0 ||
			module.receiver !== null ||
			module.redirects !== null ||
			module.siteScript !== null ||
			module.manifest.outsideHosts.length > 0);

	/** Every place where a Module runs now: each Site (or Workspace) where it is on. */
	const placesOf = async (module: RunnableModule): Promise<QueuedPlace[]> => {
		if (!(await isApproved(module))) return [];
		const switches = await db
			.select({ workspaceId: moduleSwitches.workspaceId, siteId: moduleSwitches.siteId, on: moduleSwitches.on })
			.from(moduleSwitches)
			.where(eq(moduleSwitches.moduleId, module.id));
		const switched = new Map(switches.map((row) => [`${row.workspaceId}:${row.siteId ?? ""}`, row.on]));
		const on = (key: string) => switched.get(key) ?? module.manifest.onByDefault;
		if (module.level === "site") {
			const rows = await db.select({ id: sites.id, workspaceId: sites.workspaceId }).from(sites);
			return rows
				.filter((row) => on(`${row.workspaceId}:${row.id}`))
				.map((row) => ({ level: "site", workspaceId: row.workspaceId, siteId: row.id }));
		}
		const rows = await db.select({ id: workspaces.id }).from(workspaces);
		return rows.filter((row) => on(`${row.id}:`)).map((row) => ({ level: "workspace", workspaceId: row.id }));
	};

	/** The Module keeping Form Submissions, if this build has one that can run. */
	const receiving = (): RunnableModule | undefined =>
		registry.all().find((module): module is RunnableModule => module.runnable && module.receiver !== null);

	/** The Module keeping Redirect rules, if this build has one that can run. */
	const redirecting = registry
		.all()
		.find((module): module is RunnableModule => module.runnable && module.redirects !== null);

	/** The Module keeping the 404 log, if this build has one that can run. */
	const logging = registry
		.all()
		.find((module): module is RunnableModule => module.runnable && module.notFoundLog !== null);

	/** Misses gathered for the 404 log, by Site, then by path, language and referring host. */
	const held = new Map<string, { site: { id: string; workspaceId: string }; misses: Map<string, PageMiss> }>();
	let heldCount = 0;
	let flushing: Promise<void> = Promise.resolve();

	/** Hands the misses held now to the job queue, one job per Site where the 404 log's Module runs. */
	const sendMisses = async () => {
		const batches = [...held.values()];
		held.clear();
		heldCount = 0;
		if (!logging) return;
		for (const batch of batches) {
			try {
				if (!(await runsOnSite(batch.site, logging))) continue;
				const misses = [...batch.misses.values()];
				for (let start = 0; start < misses.length; start += 1000) {
					await jobs.send(moduleMissesJob, {
						moduleId: logging.id,
						workspaceId: batch.site.workspaceId,
						siteId: batch.site.id,
						misses: misses.slice(start, start + 1000).map((miss) => ({
							...miss,
							firstAt: miss.firstAt.toISOString(),
							lastAt: miss.lastAt.toISOString(),
						})),
					});
				}
			} catch (error) {
				// The 404 log is a guide: a batch that can't be queued is lost, and the log says so.
				log.warn("Misses for the 404 log couldn't be queued", { siteId: batch.site.id, error });
			}
		}
	};
	/** Hands the misses over after any hand-over already under way, so a caller waiting for it sees them queued. */
	const flushMisses = (): Promise<void> => {
		flushing = flushing.then(sendMisses, sendMisses);
		return flushing;
	};

	/** The place where a Module acts for an event on a Site: the Site, or its Workspace. */
	const placeFor = (module: RunnableModule, workspaceId: string, siteId: string): QueuedPlace =>
		module.level === "site" ? { level: "site", workspaceId, siteId } : { level: "workspace", workspaceId };

	/**
	 * Opens a place for a Module acting by itself, if it runs there; null when it doesn't (or the
	 * place is gone), and its queued work then does nothing.
	 */
	const openForModule = async (module: RunnableModule, place: QueuedPlace): Promise<PlaceScope | null> => {
		try {
			const scope = await openPlace(data, moduleAccess(module, place), place);
			return (await runsAt(scope, module)) ? scope : null;
		} catch (error) {
			if (error instanceof SiteNotFoundError || error instanceof WorkspaceNotFoundError) return null;
			throw error;
		}
	};

	/**
	 * Runs a Module's queued work. A failure goes to the Module log and is tried again (the job
	 * fails); a refusal is logged and never tried again: the Module must change.
	 */
	const runQueued = async (
		module: RunnableModule,
		place: QueuedPlace,
		what: { event: string; siteId: string } | { job: string },
		work: (scope: PlaceScope) => Promise<void>,
	) => {
		const scope = await openForModule(module, place);
		if (!scope) return;
		try {
			await work(scope);
		} catch (error) {
			const kind = "event" in what ? `event ${what.event}` : `job ${what.job}`;
			await writeLine(options, module, place, "error", `The ${kind} failed.`, { ...what, error: describeError(error) });
			log.warn("A Module's background work failed", { moduleId: module.id, ...what, error });
			if (error instanceof ModuleRefusedError) return;
			throw error;
		}
	};

	/**
	 * Queues an event for each Module that reacts to it (ADR 0024: afterwards, as background jobs; the
	 * job runs only where the Module runs then). Never throws: the change is saved, and a Module that
	 * misses an event has it in its Module log.
	 */
	const queueEvent = async (
		event: ModuleEventName,
		workspaceId: string,
		siteId: string,
		at: Date,
		eventData: Record<string, unknown>,
	) => {
		for (const module of registry.all()) {
			if (!module.runnable || !module.events.has(event)) continue;
			try {
				await jobs.send(moduleEventJob, {
					moduleId: module.id,
					event,
					workspaceId,
					siteId,
					occurredAt: at.toISOString(),
					data: eventData,
				});
			} catch (error) {
				log.error("A Module event couldn't be queued", { moduleId: module.id, event, error });
				await writeLine(
					options,
					module,
					placeFor(module, workspaceId, siteId),
					"error",
					`The event ${event} couldn't be queued.`,
					{ event, error: describeError(error) },
				).catch(() => {});
			}
		}
	};

	/**
	 * What a kept Submission sets off (never spam): its Notifications, Auto-reply and Webhooks, then
	 * `form.submitted` for other Modules, with its sender when known. Never throws.
	 */
	const submissionKept = async (
		site: Site,
		submission: KeptSubmission,
		sender: FormSender | null,
		visitor: string | null = null,
	) => {
		await hostOptions.submissionActions?.kept(site, submission, { autoReply: true });
		if (!sender) return;
		await queueEvent("form.submitted", site.workspaceId, site.id, submission.receivedAt, {
			formId: submission.formId,
			formKey: submission.formKey,
			page: submission.page,
			language: submission.language,
			sender,
			visitor,
		} satisfies ModuleEvents["form.submitted"]);
	};
	options.submissions = {
		kept: submissionKept,
		deliveries: async (site, submissionId) =>
			(await hostOptions.submissionActions?.deliveries(site, submissionId)) ?? [],
	};

	return {
		registry,
		schemas: schemasOf(registry),
		components,

		async list(_scope, language) {
			const approved = await approvals();
			const views: ModuleView[] = [];
			for (const module of registry.all()) {
				const approval = approved.get(module.id);
				const { manifest } = module;
				views.push({
					id: module.id,
					name: words(module, manifest?.name, language) || module.id,
					description: words(module, manifest?.description, language),
					version: manifest?.version ?? "",
					level: manifest?.level ?? "site",
					onByDefault: manifest?.onByDefault ?? false,
					status: statusOf(module, approval?.granted),
					problem: module.runnable ? null : module.problem,
					approval: approval
						? { version: approval.version, approvedAt: approval.approvedAt, approvedBy: approval.approvedBy }
						: null,
					asks: manifest
						? consentView(
								manifest,
								module.runnable && module.siteScript?.beforeConsent === true,
								approval?.granted ?? null,
								language,
							)
						: { permissions: [], uses: [], outsideHosts: [], siteScript: null },
					adds: additionsView(module, language),
					partitions: module.runnable ? await partitions.views(module, language) : [],
				});
			}
			return views;
		},

		async approve(scope, moduleId, version) {
			const module = find(moduleId);
			if (!module.runnable) throw new ModuleCannotRunError(module.problem);
			if (module.manifest.version !== version) throw new ModuleChangedError(module.manifest.version);
			const granted = consentItems(module.manifest, module.siteScript?.beforeConsent === true);
			const values = { version, granted, approvedAt: scope.now(), approvedBy: personIdOf(scope.access.actor) };
			await scope.transaction(async (tx) => {
				await tx.db
					.insert(moduleApprovals)
					.values({ moduleId, ...values })
					.onConflictDoUpdate({ target: moduleApprovals.moduleId, set: values });
				if (addsComponents(module)) await clearEveryPageCache(tx);
				await tx.audit("module.approve", { moduleId, version, granted });
			});
		},

		async withdraw(scope, moduleId) {
			const module = find(moduleId);
			await scope.transaction(async (tx) => {
				await tx.db.delete(moduleApprovals).where(eq(moduleApprovals.moduleId, module.id));
				if (addsComponents(module)) await clearEveryPageCache(tx);
				await tx.audit("module.withdraw", { moduleId: module.id });
			});
		},

		async log(scope, moduleId, logOptions) {
			return listModuleLog(scope.db, find(moduleId).id, logOptions);
		},

		async placeList(scope, language) {
			const approved = await approvals();
			const views: PlaceModuleView[] = [];
			for (const module of registry.all()) {
				if (!module.runnable || module.level !== scope.level) continue;
				views.push({
					id: module.id,
					name: words(module, module.manifest.name, language),
					description: words(module, module.manifest.description, language),
					version: module.manifest.version,
					status: statusOf(module, approved.get(module.id)?.granted),
					on: await switchedOn(scope, module),
					onByDefault: module.manifest.onByDefault,
				});
			}
			return views;
		},

		async setOn(scope, moduleId, on, language) {
			const module = atPlace(scope, moduleId);
			if (on && !(await isApproved(module))) throw new ModuleNotApprovedError();
			await scope.transaction(async (tx) => {
				await recordSwitch(tx, module, on);
				if (tx.level === "site" && addsComponents(module)) await clearPageCache(tx);
				await tx.audit(on ? "module.switchOn" : "module.switchOff", { moduleId: module.id });
			});
			const view = (await this.placeList(scope, language)).find((candidate) => candidate.id === module.id);
			if (!view) throw new ModuleNotFoundError();
			return view;
		},

		async removeData(scope, moduleId, confirmation) {
			const module = atPlace(scope, moduleId);
			return scope.transaction(async (tx) => {
				const tables = [...module.tables];
				const rows = moduleData(module, tx);
				const counts: { table: string; rows: number }[] = [];
				for (const table of tables) counts.push({ table: getTableName(table), rows: await rows.count(table) });
				const secretNames = await tx.secrets.names(`module:${module.id}:`);
				const request = {
					action: "module.removeData",
					target: module.id,
					preview: { tables: counts, secrets: secretNames.length },
				};
				if (confirmation === undefined) {
					return {
						removed: false,
						tables: counts,
						secrets: secretNames.length,
						confirmation: await askConfirmation(tx, request),
					};
				}
				await useConfirmation(tx, confirmation, request);
				// Children before the tables they point at: a definition lists parents first.
				for (const table of tables.reverse()) await rows.delete(table);
				for (const name of secretNames) await tx.secrets.remove(name);
				await recordSwitch(tx, module, false);
				if (tx.level === "site" && addsComponents(module)) await clearPageCache(tx);
				await tx.audit("module.removeData", { moduleId: module.id, tables: counts, secrets: secretNames.length });
				return { removed: true, tables: counts, secrets: secretNames.length };
			});
		},

		async pages(scope, language) {
			const pages: ModulePageView[] = [];
			for (const module of registry.all()) {
				if (!module.runnable || module.level !== scope.level || module.pages.length === 0) continue;
				if (!(await runsAt(scope, module))) continue;
				for (const page of module.pages) {
					if (!holds(scope, module, page.permission)) continue;
					pages.push({ moduleId: module.id, path: page.path, label: words(module, page.label, language) });
				}
			}
			return pages;
		},

		async permissionsAt(scope) {
			const held: string[] = [];
			for (const module of registry.all()) {
				if (!module.runnable || module.level !== scope.level || module.permissions.size === 0) continue;
				if (!(await runsAt(scope, module))) continue;
				for (const permission of module.permissions.values()) {
					if (canAt(scope, permission)) held.push(permission.key);
				}
			}
			return held;
		},

		async callProcedure(call) {
			const module = registry.get(call.moduleId);
			const procedure = module?.runnable ? module.procedures.get(call.procedure) : undefined;
			if (!module?.runnable || !procedure) throw new ModuleNotFoundError();
			const scope =
				module.level === "site"
					? await data.site(call.access, call.placeId, "site.view")
					: await data.workspace(call.access, call.placeId, "workspace.view");
			if (!(await runsAt(scope, module))) throw new ModuleNotFoundError();
			const permission = resolvePermission(module, procedure.permission);
			if (!canAt(scope, permission)) throw new PermissionDeniedError(keyOf(permission));
			const context = procedureContext(module, scope, options, call.person, (name) => holds(scope, module, name));
			try {
				return await procedure.run(call.input as Record<string, unknown>, context);
			} catch (error) {
				if (isModuleAnswer(error)) throw error;
				await writeLine(options, module, placeOf(scope), "error", `The procedure ${call.procedure} failed.`, {
					procedure: call.procedure,
					error: describeError(error),
				});
				log.warn("A Module procedure failed", { moduleId: module.id, procedure: call.procedure, error });
				throw new ModuleFailedError();
			}
		},

		async outsideHostsAt(site, language) {
			const found: { host: string; moduleId: string; module: string }[] = [];
			for (const module of registry.all()) {
				if (!module.runnable || module.level !== "site" || module.manifest.outsideHosts.length === 0) continue;
				if (!(await runsOnSite(site, module))) continue;
				const name = words(module, module.manifest.name, language) || module.id;
				for (const host of module.manifest.outsideHosts) found.push({ host, moduleId: module.id, module: name });
			}
			return found;
		},

		async siteScriptsAt(site) {
			const found: ModuleSiteScriptOnSite[] = [];
			for (const module of registry.all()) {
				if (!module.runnable || module.level !== "site" || module.siteScript === null) continue;
				if (await runsOnSite(site, module)) found.push({ ...module.siteScript, moduleId: module.id });
			}
			return found;
		},

		async answerSiteRoute(siteRoute, request) {
			const { site } = siteRoute;
			const url = new URL(request.url);
			const [, prefix = "", ...rest] = url.pathname.slice("/_wc/m".length).split("/");
			const module = registry.byRoutePrefix(prefix);
			if (!module) return null;
			let segments: string[];
			try {
				segments = rest.filter((part) => part !== "").map((part) => decodeURIComponent(part));
			} catch {
				return null;
			}
			const matches = module.routes.flatMap((compiled) => {
				const params = matchRoute(compiled, segments);
				return params ? [{ compiled, params }] : [];
			});
			if (matches.length === 0) return null;
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const scope = await openForModule(module, place);
			if (!scope) return null;
			const method = request.method === "HEAD" ? "GET" : request.method;
			const match = matches.find(({ compiled }) => compiled.route.method === method);
			if (!match) {
				const allow: string[] = [...new Set(matches.map(({ compiled }) => compiled.route.method))];
				if (allow.includes("GET")) allow.push("HEAD");
				return new Response("Method Not Allowed", { status: 405, headers: { ...PLAIN, allow: allow.join(", ") } });
			}
			const { route } = match.compiled;
			if (route.limit) {
				const key = `module-route:${module.id}:${site.id}:${route.method} ${route.path}:${siteRoute.clientAddress ?? "unknown"}`;
				const rule = { limit: route.limit.requests, windowMs: route.limit.perSeconds * 1000 };
				if (!(await rateLimits.count(key, rule))) {
					return new Response("Too Many Requests", {
						status: 429,
						headers: { ...PLAIN, "retry-after": String(route.limit.perSeconds) },
					});
				}
			}
			let incoming = request;
			if (route.maxBodyBytes !== undefined) {
				const limited = await withLimitedBody(request, route.maxBodyBytes);
				if (!limited) return new Response("Payload Too Large", { status: 413, headers: PLAIN });
				incoming = limited;
			}
			const visitor = visitors.visitorOf(siteRoute, incoming);
			let response: Response;
			try {
				response = await route.handle(forModule(incoming), routeContext(module, scope, options, match.params, visitor));
				if (!(response instanceof Response))
					throw new TypeError("The Site route answered something that isn't a Response.");
			} catch (error) {
				await writeLine(options, module, place, "error", `The Site route ${route.method} ${route.path} failed.`, {
					route: `${route.method} ${route.path}`,
					error: describeError(error),
				});
				log.warn("A Module's Site route failed", { moduleId: module.id, route: route.path, error });
				return new Response("Internal Server Error", { status: 500, headers: PLAIN });
			}
			const headers = withoutWebCraftSetCookies(response.headers);
			// Never cached as a page; a Module lets browsers keep its answer only by saying so itself.
			if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
			headers.set("x-content-type-options", "nosniff");
			return new Response(request.method === "HEAD" ? null : response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		},

		async afterAudit(entry) {
			const mapping = EVENTS_OF_ACTIONS[entry.action];
			const { workspaceId, siteId } = entry;
			if (!mapping || siteId === null || workspaceId === null) return;
			if (mapping.when && !mapping.when(entry.details)) return;
			await queueEvent(
				mapping.event,
				workspaceId,
				siteId,
				entry.at,
				mapping.data(entry.details) as Record<string, unknown>,
			);
		},

		async runEvent(payload) {
			const module = registry.get(payload.moduleId);
			if (!module?.runnable || !(MODULE_EVENTS as readonly string[]).includes(payload.event)) return;
			const name = payload.event as ModuleEventName;
			const handler = module.definition.events?.[name] as
				| ((event: unknown, context: ModuleContext) => Promise<void>)
				| undefined;
			if (!handler) return;
			const place = placeFor(module, payload.workspaceId, payload.siteId);
			await runQueued(module, place, { event: name, siteId: payload.siteId }, (scope) =>
				handler(
					{ name, siteId: payload.siteId, occurredAt: new Date(payload.occurredAt), data: payload.data },
					moduleContext(module, scope, options),
				),
			);
		},

		async runSchedules(every) {
			for (const module of registry.all()) {
				if (!module.runnable) continue;
				const due = module.schedules.filter((schedule) => schedule.every === every);
				if (due.length === 0) continue;
				for (const place of await placesOf(module)) {
					for (const schedule of due) {
						await jobs.send(moduleJob, { moduleId: module.id, job: schedule.job, place, payload: {} });
					}
				}
			}
		},

		async submissionsKeptBy(site) {
			const module = receiving();
			return module && module.level === "site" && (await runsOnSite(site, module)) ? module.id : null;
		},

		async receiveSubmission(site, received, sender) {
			const module = receiving();
			const receiver = module?.receiver;
			if (!module || !receiver) throw new ModuleNotFoundError();
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const scope = await openForModule(module, place);
			if (!scope) throw new ModuleNotFoundError();
			const visitor = visitors.visitorOf(sender.route, sender.request);
			const submission: FormSubmission = { ...received, sender: await formSenderOf(visitor, sender.request) };
			let kept: { id: string };
			try {
				kept = await receiver.receive(submission, moduleContext(module, scope, options));
			} catch (error) {
				await writeLine(options, module, place, "error", "A Form Submission couldn't be kept.", {
					formId: submission.formId,
					error: describeError(error),
				});
				log.error("A Module failed to keep a Form Submission", { moduleId: module.id, error });
				throw new ModuleFailedError();
			}
			// What follows a kept Submission (never spam) is queued afterwards, as background jobs.
			if (submission.spam === null) {
				// The sender's id for the day, only where analytics may count them at all
				// (`formSenderCounted`, the SDK's one rule for it): analytics links the Submission to
				// their visit with it.
				const { sender: known } = submission;
				const dailyId = formSenderCounted(known) ? await visitor.dailyId("analytics") : null;
				await submissionKept(site, { ...submission, id: kept.id }, submission.sender, dailyId);
			}
			return { id: kept.id };
		},

		async pathsWithRules(site, requests) {
			const found = new Set<string>();
			const module = redirecting;
			const rules = module?.redirects;
			if (requests.length === 0 || !module || !rules || !(await runsOnSite(site, module))) return found;
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const scope = await openForModule(module, place);
			if (!scope) return found;
			const context = moduleContext(module, scope, options);
			const answers = await timedModuleCall<(RedirectTarget | null)[] | null>(
				() =>
					rules.findMany
						? rules.findMany(requests, context)
						: (async () => {
								const answers: (RedirectTarget | null)[] = [];
								for (const request of requests) answers.push(await rules.find(request, context));
								return answers;
							})(),
				FIND_MANY_TIMEOUT_MS,
				async () => {
					await writeLine(
						options,
						module,
						place,
						"warn",
						"Its Redirect rules took too long to answer for a list of pages.",
						{
							paths: requests.length,
						},
					).catch(() => {});
					return null;
				},
				async (error) => {
					await writeLine(options, module, place, "warn", "Its Redirect rules failed for a list of pages.", {
						error: describeError(error),
					}).catch(() => {});
					log.warn("A Module's Redirect rules failed", { moduleId: module.id, error });
					return null;
				},
			);
			if (!answers) return found;
			requests.forEach((request, index) => {
				const target = answers[index];
				if (target && !target.whereNoPage) found.add(request.path);
			});
			return found;
		},

		async redirectFor(site, request, paths) {
			const module = redirecting;
			const rules = module?.redirects;
			if (!module || !rules || !(await runsOnSite(site, module))) return null;
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const scope = await openForModule(module, place);
			if (!scope) return null;
			const context = moduleContext(module, scope, options);
			const problem = async (message: string, details: Record<string, unknown>) => {
				await writeLine(options, module, place, "warn", message, details).catch(() => {});
			};
			const ask = async (asked: RedirectRequest): Promise<RedirectTarget | null> =>
				timedModuleCall(
					() => rules.find(asked, context),
					FIND_TIMEOUT_MS,
					async () => {
						await problem("Its Redirect rules took too long to answer; the request went on without them.", {
							path: asked.path,
						});
						return null;
					},
					async (error) => {
						await problem("Its Redirect rules failed; the request went on without them.", {
							path: asked.path,
							error: describeError(error),
						});
						log.warn("A Module's Redirect rules failed", { moduleId: module.id, error });
						return null;
					},
				);
			let path = request.path;
			let result: Pick<RedirectTarget, "to" | "status"> | null = null;
			// One 302 on the way makes the whole a 302: the page is elsewhere for now.
			let temporary = false;
			const seen = new Set([path]);
			for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
				const asked = hop === 0 ? request : { path, language: paths.languageOf(path) };
				const target = await ask(asked);
				if (!target) return result;
				// A Media file goes to where it is served now; nowhere while visitors can't get it.
				const media = typeof target.to === "string" ? MEDIA_TARGET.exec(target.to) : null;
				if (media) {
					const served = await paths.mediaPath(media[1] as string);
					if (!served) return result;
					target.to = served;
				}
				// An Entry goes to where it is published now (a slug changed since included); nowhere before.
				const entry = typeof target.to === "string" ? ENTRY_TARGET.exec(target.to) : null;
				if (entry) {
					const published = await paths.entryPath(entry[1] as string, entry[2] ?? null);
					if (!published) return result;
					target.to = published;
				}
				const to = checkedTarget(target.to);
				const status: number = target.status;
				if (to === null || (status !== 301 && status !== 302)) {
					await problem("A Redirect rule's target isn't a path on the Site or an https:// address; it was left out.", {
						path,
						to: String(target.to).slice(0, 200),
					});
					return result;
				}
				// A rule that only stands where no page is steps aside for a page published since.
				if (target.whereNoPage && (await paths.hasPage(path))) return result;
				if (hop === MAX_REDIRECT_HOPS) {
					// A longer chain: visitors are sent on from where this answer got to, and the browser
					// goes on from there (each answer checks again for a circle).
					await problem(
						`Redirect rules go through more than ${MAX_REDIRECT_HOPS} steps; visitors were sent on from the last of them.`,
						{ path: request.path, through: [...seen] },
					);
					return result;
				}
				if (status === 302) temporary = true;
				result = { to, status: temporary ? 302 : 301 };
				// A chain goes on from a plain Site path; an address elsewhere, a query or a fragment ends it.
				if (!/^\/[^?#]*$/.test(to)) return result;
				if (seen.has(to)) {
					await problem("Redirect rules go round in a circle; the Site's page answered instead.", {
						path: request.path,
						through: [...seen],
					});
					return null;
				}
				seen.add(to);
				path = to;
			}
			return result;
		},

		async importSourcesAt(site, language) {
			const views: ImportSourceView[] = [];
			for (const module of registry.all()) {
				if (!module.runnable || module.importSources.size === 0) continue;
				if (!(await runsOnSite(site, module))) continue;
				for (const source of module.importSources.values()) views.push(sourceView(module, source, language));
			}
			return views;
		},

		async importSource(site, sourceId) {
			const dot = sourceId.indexOf(".");
			const module = dot > 0 ? registry.get(sourceId.slice(0, dot)) : undefined;
			const source = module?.runnable ? module.importSources.get(sourceId.slice(dot + 1)) : undefined;
			if (!module?.runnable || !source || !(await runsOnSite(site, module))) return null;
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const language = module.manifest.adminLanguages[0] ?? "en";
			return {
				...sourceView(module, source, language),
				needs: resolvePermission(module, source.permission),
				async *read(file) {
					const scope = await openForModule(module, place);
					if (!scope) throw new ModuleNotFoundError();
					try {
						yield* source.read(file, moduleContext(module, scope, options));
					} catch (error) {
						if (!isModuleAnswer(error)) {
							await writeLine(options, module, place, "error", `The import source ${source.key} failed.`, {
								file: file.name,
								error: describeError(error),
							}).catch(() => {});
						}
						throw error;
					}
				},
			};
		},

		async importRedirectsOn(site) {
			const module = redirecting;
			return Boolean(module?.redirects?.add) && module !== undefined && (await runsOnSite(site, module));
		},

		async addImportedRules(site, rules) {
			const module = redirecting;
			const add = module?.redirects?.add;
			if (!module || !add || !(await runsOnSite(site, module))) return null;
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const scope = await openForModule(module, place);
			if (!scope) return null;
			try {
				const results = await add(rules, moduleContext(module, scope, options));
				return rules.map((_, index) => results[index] ?? { skipped: "invalid" });
			} catch (error) {
				await writeLine(options, module, place, "error", "Redirect rules for an Import couldn't be added.", {
					error: describeError(error),
				}).catch(() => {});
				throw error;
			}
		},

		async removeImportedRules(site, rules) {
			const module = redirecting;
			const remove = module?.redirects?.remove;
			if (!module || !remove || rules.length === 0) return 0;
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const scope = await openForModule(module, place);
			if (!scope) return 0;
			return remove(rules, moduleContext(module, scope, options));
		},

		keepsNotFoundLog: logging !== undefined,

		noteMiss(site, miss) {
			if (!logging) return;
			let batch = held.get(site.id);
			if (!batch) {
				batch = { site: { id: site.id, workspaceId: site.workspaceId }, misses: new Map() };
				held.set(site.id, batch);
			}
			const key = `${miss.path}\n${miss.language}\n${miss.referrerHost ?? ""}`;
			const known = batch.misses.get(key);
			if (known) {
				known.hits++;
				if (miss.at > known.lastAt) known.lastAt = miss.at;
				return;
			}
			if (heldCount >= MAX_HELD_MISSES) return;
			batch.misses.set(key, {
				path: miss.path,
				language: miss.language,
				referrerHost: miss.referrerHost,
				hits: 1,
				firstAt: miss.at,
				lastAt: miss.at,
			});
			heldCount++;
			if (heldCount >= MISS_BATCH_SIZE) flushMisses().catch(() => {});
		},

		flushMisses,

		async runMisses(payload) {
			const module = registry.get(payload.moduleId);
			const keeper = module?.runnable ? module.notFoundLog : null;
			if (!module?.runnable || !keeper) return;
			const place: QueuedPlace = { level: "site", workspaceId: payload.workspaceId, siteId: payload.siteId };
			await runQueued(module, place, { job: "notFound" }, async (scope) => {
				const misses = payload.misses.map((miss) => ({
					...miss,
					firstAt: new Date(miss.firstAt),
					lastAt: new Date(miss.lastAt),
				}));
				await keeper.record(misses, moduleContext(module, scope, options));
			});
		},
		setKeepMonths: (scope, moduleId, table, months) => partitions.setKeepMonths(scope, moduleId, table, months),
		maintainPartitions: () => partitions.maintain(),
		purgeSalts: () => visitors.purgeSalts(),

		widgetKinds(language) {
			return registry.all().flatMap((module) =>
				module.runnable && module.level === "site"
					? module.widgets.map((widget) => ({
							moduleId: module.id,
							module: words(module, module.manifest.name, language) || module.id,
							languages: module.manifest.adminLanguages,
							widget,
						}))
					: [],
			);
		},

		async runsOn(site, moduleId) {
			const module = registry.get(moduleId);
			return module?.runnable === true && module.level === "site" && (await runsOnSite(site, module));
		},

		async runWidget(site, moduleId, kind, request) {
			const module = registry.get(moduleId);
			const widget = module?.runnable ? module.widgets.find((each) => each.kind === kind) : undefined;
			if (!module?.runnable || !widget) {
				return {
					data: null,
					problem: { code: "WIDGET_UNKNOWN", message: "No Module of this Install adds this Widget." },
				};
			}
			const place: QueuedPlace = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			const scope = await openForModule(module, place);
			if (!scope) {
				return {
					data: null,
					problem: { code: "MODULE_NOT_RUNNING", message: "The Module that adds this Widget isn't on here." },
				};
			}
			try {
				const data = await widget.query(request, moduleContext(module, scope, options));
				if (data?.shape !== widget.shape)
					throw new TypeError(`It answered a ${String(data?.shape)}, not a ${widget.shape}.`);
				return { data, problem: null };
			} catch (error) {
				if (isModuleError(error)) return { data: null, problem: { code: error.code, message: error.message } };
				await writeLine(options, module, place, "error", `The Widget ${kind} failed.`, {
					widget: kind,
					error: describeError(error),
				});
				log.warn("A Module's Widget failed", { moduleId: module.id, widget: kind, error });
				return {
					data: null,
					problem: { code: "WIDGET_FAILED", message: "This Widget couldn't count. The Module log says why." },
				};
			}
		},

		async widgetOptions(site, moduleId, kind, key) {
			const module = registry.get(moduleId);
			const setting = module?.runnable
				? module.widgets.find((each) => each.kind === kind)?.settings?.find((each) => each.key === key)
				: undefined;
			if (!module?.runnable || !setting) return [];
			if (typeof setting.options !== "function") return setting.options;
			const scope = await openForModule(module, { level: "site", workspaceId: site.workspaceId, siteId: site.id });
			if (!scope) return [];
			return await setting.options(moduleContext(module, scope, options));
		},

		async widgetGoals(site, moduleId) {
			const module = registry.get(moduleId);
			if (!module?.runnable || !module.widgetGoals) return [];
			const scope = await openForModule(module, { level: "site", workspaceId: site.workspaceId, siteId: site.id });
			if (!scope) return [];
			return await module.widgetGoals(moduleContext(module, scope, options));
		},

		async runJob(payload) {
			const module = registry.get(payload.moduleId);
			const job = module?.runnable ? module.jobs.get(payload.job) : undefined;
			if (!module?.runnable || !job) return;
			await runQueued(module, payload.place, { job: payload.job }, async (scope) => {
				const parsed = job.payload.safeParse(payload.payload);
				if (!parsed.success) {
					throw new ModuleRefusedError("job", `The job ${payload.job} doesn't take its queued payload any more.`);
				}
				await job.run(parsed.data, moduleContext(module, scope, options));
			});
		},
	};
}

/**
 * A timed Module call, as `pathsWithRules` and `redirectFor`'s `ask` both need it: `call` raced
 * against a `timeoutMs` timer (a plain `setTimeout` "late" promise), the timer always cleared.
 * `onTimeout` and `onError` log their own warn line and answer the fallback for their caller; a
 * call still running when the timer wins is left to settle on its own, unawaited.
 */
async function timedModuleCall<T>(
	call: () => Promise<T>,
	timeoutMs: number,
	onTimeout: () => Promise<T>,
	onError: (error: unknown) => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const late = new Promise<"late">((resolve) => {
			timer = setTimeout(() => resolve("late"), timeoutMs);
		});
		const answer = await Promise.race([call(), late]);
		return answer === "late" ? await onTimeout() : answer;
	} catch (error) {
		return await onError(error);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A Redirect rule's target, as the Site pipeline may send visitors there: a Site path (made
 * canonical, its query and fragment kept), or an `https://` address without a user name or password.
 * Null for anything else (`javascript:`, `//elsewhere`, …), which no rule may send visitors to.
 */
function checkedTarget(to: unknown): string | null {
	if (typeof to !== "string" || to.length > 4000) return null;
	if (to.startsWith("/")) {
		if (!SITE_TARGET.test(to)) return null;
		const cut = to.search(/[?#]/);
		const segments = pathSegments(cut === -1 ? to : to.slice(0, cut));
		return segments ? `${canonicalPath(segments)}${cut === -1 ? "" : to.slice(cut)}` : null;
	}
	try {
		const url = new URL(to);
		return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
	} catch {
		return null;
	}
}

/** Whether the scope's actor holds a Permission a Module names (its own, or one of WebCraft's) at the place. */
export function holds(scope: PlaceScope, module: RunnableModule, name: string): boolean {
	return canAt(scope, resolvePermission(module, name));
}

function canAt(scope: PlaceScope, permission: AddedPermission | Permission): boolean {
	const resource =
		scope.level === "site"
			? ({ level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const)
			: ({ level: "workspace", workspaceId: scope.workspace.id } as const);
	return can(scope.access.actor, permission, resource);
}

function keyOf(permission: AddedPermission | Permission): string {
	return typeof permission === "string" ? permission : permission.key;
}

/**
 * The request as a Module's Site route sees it: without WebCraft's own cookies (Edit mode's, and
 * any other WebCraft sets on the Site's domain), so a Module never acts with them.
 */
function forModule(request: Request): Request {
	const cookie = request.headers.get("cookie");
	if (cookie === null) return request;
	const headers = new Headers(request.headers);
	const kept = withoutWebCraftCookies(cookie);
	if (kept === null) headers.delete("cookie");
	else headers.set("cookie", kept);
	return new Request(request, { headers });
}

/** A Site route's answer headers, without any cookie the Module tried to set under one of WebCraft's names. */
function withoutWebCraftSetCookies(answer: Headers): Headers {
	const headers = new Headers(answer);
	const cookies = headers.getSetCookie();
	headers.delete("set-cookie");
	for (const cookie of cookies) {
		if (!isWebCraftCookie(cookie.split("=")[0] ?? "")) headers.append("set-cookie", cookie);
	}
	return headers;
}

/**
 * The request with its body read, when it is at most `limit` bytes (by what it says first, then by
 * what comes), or null when it is bigger.
 */
async function withLimitedBody(request: Request, limit: number): Promise<Request | null> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > limit) return null;
	if (request.body === null) return request;
	const reader = request.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => {});
			return null;
		}
		parts.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.byteLength;
	}
	const copied = new Request(request.url, { method: request.method, headers: request.headers, body });
	return copied;
}

/** A Site route's parameters when its parts match the path's segments, or null. */
function matchRoute({ parts }: CompiledRoute, segments: readonly string[]): Record<string, string> | null {
	if (parts.length !== segments.length) return null;
	const params: Record<string, string> = {};
	for (const [index, part] of parts.entries()) {
		const segment = segments[index] ?? "";
		if ("fixed" in part) {
			if (part.fixed !== segment) return null;
		} else {
			params[part.param] = segment;
		}
	}
	return params;
}
