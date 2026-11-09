import { createHash } from "node:crypto";
import {
	type AdminPage,
	type ComponentProp,
	type ConsentCategory,
	IMPORT_FILE_MAX_BYTES,
	type ImportSource,
	type Label,
	labelProblem,
	MODULE_EVENTS,
	MODULE_SITE_SCRIPT_MAX_LENGTH,
	type ModuleContext,
	type ModuleDefinition,
	type ModuleEventName,
	type ModuleJob,
	type ModuleManifest,
	type ModuleProcedure,
	type ModuleProcedures,
	type ModuleSchedule,
	type ModuleTable,
	type ModuleWidget,
	moduleManifestSchema,
	moduleSchemaName,
	type NotFoundLog,
	type RedirectRules,
	SDK_VERSION,
	type SiteRoute,
	type SubmissionReceiver,
	WIDGET_FILTERS,
	WIDGET_SHAPES,
	type WidgetOption,
} from "@webcraft/module-sdk";
import { parseTemplateMarkup, TemplateMarkupInvalidError } from "@webcraft/renderer";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import semver from "semver";
import {
	isComponentName,
	type ModuleComponent,
	moduleComponentTreeRules,
	RESERVED_PROP_KEYS,
} from "../content/components.ts";
import type { ContentProblem } from "../content/errors.ts";
import { type FieldInput, parseFields } from "../content/fields.ts";
import type { AddedPermission } from "../permissions/can.ts";
import { isPermission, type Level, PERMISSIONS, type Permission } from "../permissions/roles.ts";
import { isToolset } from "../toolsets.ts";

/**
 * The Modules this build of WebCraft loads, each checked against the rules of the SDK when it is
 * loaded. A Module that breaks one is kept, with the reason, so the Modules screen can say why it
 * doesn't run; WebCraft never runs it.
 */
export type ModuleRegistry = {
	/** Every Module, in the order given: those that run and those that can't. */
	all(): readonly LoadedModule[];
	get(moduleId: string): LoadedModule | undefined;
	/** The Module answering under `/_wc/m/<prefix>/`, if one that runs has that prefix. */
	byRoutePrefix(prefix: string): RunnableModule | undefined;
};

export type LoadedModule = RunnableModule | BrokenModule;

/** A Module WebCraft can't run, and why. */
export type BrokenModule = {
	runnable: false;
	id: string;
	definition: ModuleDefinition;
	/** Its manifest, when that much was right. */
	manifest: ModuleManifest | null;
	problem: string;
};

/** A Module whose definition keeps every rule, ready to run where it is approved and on. */
export type RunnableModule = {
	runnable: true;
	id: string;
	definition: ModuleDefinition;
	manifest: ModuleManifest;
	/** The Postgres schema of its tables, `m_<id>`. */
	schema: string;
	level: Level & ("site" | "workspace");
	/** The Permissions it adds, by key without its id (`notes.edit`). */
	permissions: ReadonlyMap<string, AddedPermission>;
	tables: ReadonlySet<ModuleTable>;
	/** Its procedures by dotted name: `notes.add`. */
	procedures: ReadonlyMap<string, ModuleProcedure>;
	routes: readonly CompiledRoute[];
	pages: readonly AdminPage[];
	events: ReadonlySet<ModuleEventName>;
	jobs: ReadonlyMap<string, ModuleJob>;
	/** The Components it adds, ready to place: Props checked, markup read into a tree. */
	components: readonly ModuleComponent[];
	/** Its jobs that run on a schedule, in every place where it runs. */
	schedules: readonly ModuleSchedule[];
	/** How it keeps Form Submissions, when it does (at most one Module of a build). */
	receiver: SubmissionReceiver | null;
	/** The script it adds to Site pages where it runs, when it adds one (SDK 1.3). */
	siteScript: ModuleSiteScriptFile | null;
	/** Its tables kept in monthly partitions (SDK 1.4). */
	partitions: readonly CompiledPartitioning[];
	/** How it keeps the Sites' Redirect rules, when it does (SDK 1.5; at most one Module of a build). */
	redirects: RedirectRules | null;
	/** How it keeps the Sites' 404 log, when it does (SDK 1.5; at most one Module of a build). */
	notFoundLog: NotFoundLog | null;
	/** The sources it imports content from (SDK 1.7), by key. */
	importSources: ReadonlyMap<string, ImportSource>;
	/** The kinds of Widget it adds to Dashboards (SDK 1.8). */
	widgets: readonly ModuleWidget[];
	/** The names of a Site's Goals its Widgets' `goal` filter offers (SDK 1.8). */
	widgetGoals: ((context: ModuleContext) => Promise<readonly string[]>) | null;
};

/** One of a Module's tables kept in monthly partitions, as WebCraft keeps it. */
export type CompiledPartitioning = {
	table: ModuleTable;
	/** Its name in the Module's schema, such as `events`. */
	name: string;
	/** The column's name in Postgres, such as `occurred_at`, and its key in the table's rows. */
	column: string;
	columnKey: string;
	label: Label;
	keepMonths: number;
};

/** The fewest and most months an Install may keep a partitioned table's rows. */
export const KEEP_MONTHS = { min: 1, max: 120 } as const;

/**
 * A Module's Site script as Sites serve it: its code, the file name it is served under
 * (`<16 hexadecimal digits of its SHA-256>.js`, at `/_wc/js/`), the Consent category its manifest
 * declares, and whether it runs before visitors accept that category (holding back itself what
 * needs it).
 */
export type ModuleSiteScriptFile = { code: string; name: string; category: ConsentCategory; beforeConsent: boolean };

/** A Site route with its path split into fixed parts and parameters. */
export type CompiledRoute = { route: SiteRoute; parts: readonly ({ fixed: string } | { param: string })[] };

/** The keys a definition may have; anything else is an extension point this SDK version doesn't have. */
const DEFINITION_KEYS = new Set([
	"manifest",
	"tables",
	"migrations",
	"procedures",
	"siteRoutes",
	"adminPages",
	"events",
	"jobs",
	"structurePresets",
	"blockTypes",
	"components",
	"schedules",
	"formSubmissions",
	"siteScript",
	"partitions",
	"redirectRules",
	"notFoundLog",
	"importSources",
	"widgets",
	"widgetGoals",
]);

/** Extension points declared for later SDK versions: a Module can't use them yet. */
const LATER = {
	structurePresets: "Structure presets",
	blockTypes: "Block types",
};

const WIDGET_KIND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const NAME = /^[a-z][a-zA-Z0-9]*$/;
const PAGE_PATH = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROUTE_PART = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*|:[a-zA-Z][a-zA-Z0-9]*)$/;
const MIGRATION_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,99}$/;
const JOB_NAME = /^[a-z][a-zA-Z0-9-]{0,63}$/;
const SOURCE_KEY = /^[a-z]+(?:-[a-z]+)*$/;
const FILE_EXTENSION = /^\.[a-z0-9]{1,10}$/;
const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** Input keys WebCraft adds to every Module procedure. */
const PLACE_KEYS = ["siteId", "workspaceId"];

/** Loads the Modules of this build. Ids and route prefixes are unique: a second one is refused. */
export function loadModules(definitions: readonly ModuleDefinition[]): ModuleRegistry {
	const loaded: LoadedModule[] = [];
	for (const definition of definitions) {
		const module = loadModule(definition);
		const clash = loaded.find(
			(other) =>
				other.id === module.id ||
				(module.runnable &&
					other.runnable &&
					module.manifest.routePrefix !== undefined &&
					other.manifest.routePrefix === module.manifest.routePrefix),
		);
		// Submissions go to one Module: a second one keeping them could never receive any.
		const receiving =
			module.runnable && module.receiver
				? loaded.find((other) => other.runnable && other.receiver !== null)
				: undefined;
		// The Site pipeline asks one Module for a Site's Redirect rules, and hands one its 404 log.
		const redirecting =
			module.runnable && module.redirects
				? loaded.find((other) => other.runnable && other.redirects !== null)
				: undefined;
		const logging =
			module.runnable && module.notFoundLog
				? loaded.find((other) => other.runnable && other.notFoundLog !== null)
				: undefined;
		// A tag names one Component: two Modules can't add Components with the same name.
		const named = module.runnable
			? loaded
					.flatMap((other) => (other.runnable ? other.components.map((added) => ({ other, added })) : []))
					.find(({ added }) => module.components.some((own) => own.name === added.name))
			: undefined;
		loaded.push(
			clash
				? broken(
						definition,
						module.manifest,
						clash.id === module.id
							? `Another Module of this build has the id ${module.id}.`
							: `The Module ${clash.id} already answers under /_wc/m/${clash.manifest?.routePrefix}/.`,
					)
				: named
					? broken(
							definition,
							module.manifest,
							`The Module ${named.other.id} already adds a Component named ${named.added.name}.`,
						)
					: receiving
						? broken(definition, module.manifest, `The Module ${receiving.id} already keeps Form Submissions.`)
						: redirecting
							? broken(definition, module.manifest, `The Module ${redirecting.id} already keeps Redirect rules.`)
							: logging
								? broken(definition, module.manifest, `The Module ${logging.id} already keeps the 404 log.`)
								: module,
		);
	}
	const byId = new Map(loaded.map((module) => [module.id, module]));
	return {
		all: () => loaded,
		get: (moduleId) => byId.get(moduleId),
		byRoutePrefix: (prefix) =>
			loaded.find((module): module is RunnableModule => module.runnable && module.manifest.routePrefix === prefix),
	};
}

function broken(definition: ModuleDefinition, manifest: ModuleManifest | null, problem: string): BrokenModule {
	const id = manifest?.id ?? (typeof definition?.manifest?.id === "string" ? definition.manifest.id : "unknown");
	return { runnable: false, id, definition, manifest, problem };
}

/** Thrown inside `loadModule` with the first rule a definition breaks. */
class DefinitionProblem extends Error {}

function loadModule(definition: ModuleDefinition): LoadedModule {
	const parsed = moduleManifestSchema.safeParse(definition?.manifest);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `manifest.${issue.path.join(".")}` : "manifest";
		return broken(definition, null, `The ${where} is wrong: ${issue?.message ?? "it can't be read"}`);
	}
	const manifest = parsed.data;
	try {
		return checkDefinition(definition, manifest);
	} catch (error) {
		if (error instanceof DefinitionProblem) return broken(definition, manifest, error.message);
		throw error;
	}
}

function problem(message: string): never {
	throw new DefinitionProblem(message);
}

function checkDefinition(definition: ModuleDefinition, manifest: ModuleManifest): RunnableModule {
	if (semver.validRange(manifest.sdk) === null) problem(`The SDK range ${manifest.sdk} can't be read.`);
	if (!semver.satisfies(SDK_VERSION, manifest.sdk)) {
		problem(`It needs the Module SDK ${manifest.sdk}; this version of WebCraft has SDK ${SDK_VERSION}.`);
	}
	for (const key of Object.keys(definition)) {
		if (!DEFINITION_KEYS.has(key)) problem(`The Module SDK ${SDK_VERSION} has no extension point "${key}".`);
	}
	for (const [key, name] of Object.entries(LATER)) {
		const value = (definition as Record<string, unknown>)[key];
		if (Array.isArray(value) && value.length > 0) problem(`${name} come in a later version of the Module SDK.`);
	}

	const level = manifest.level;
	const permissions = new Map<string, AddedPermission>();
	for (const permission of manifest.permissions) {
		if (isPermission(permission.key) || isPermission(`${manifest.id}.${permission.key}`)) {
			problem(`The Permission ${permission.key} has the name of one of WebCraft's.`);
		}
		permissions.set(permission.key, {
			key: `${manifest.id}.${permission.key}`,
			levels: [level],
			roles: ["superadmin", ...permission.roles],
		});
	}
	/** A Permission named by a procedure or page: one the Module adds, or one of WebCraft's checked at its level. */
	const checkPermission = (name: unknown, where: string) => {
		if (typeof name !== "string") problem(`${where} names no Permission.`);
		if (permissions.has(name)) return;
		if (isPermission(name) && (PERMISSIONS[name] as readonly Level[]).includes(level)) return;
		problem(`${where} needs the Permission ${name}, which the manifest doesn't declare.`);
	};

	const schema = moduleSchemaName(manifest.id);
	const tables = new Set<ModuleTable>();
	const tableNames = new Set<string>();
	for (const table of definition.tables ?? []) {
		if (!isTable(table)) problem("Its tables list holds something that isn't a table.");
		const config = getTableConfig(table);
		const name = getTableName(table);
		if (config.schema !== schema) problem(`The table ${name} isn't in the Module's own schema, ${schema}.`);
		if (tableNames.has(name)) problem(`The table ${name} is listed twice.`);
		const columns = new Set(config.columns.map((column) => column.name));
		if (!columns.has("workspace_id")) problem(`The table ${name} has no workspace_id column.`);
		if (level === "site" && !columns.has("site_id")) {
			problem(`The table ${name} has no site_id column: a Site-level Module has Site tables only.`);
		}
		tables.add(table as ModuleTable);
		tableNames.add(name);
	}

	const migrationNames: string[] = [];
	for (const migration of definition.migrations ?? []) {
		if (typeof migration?.name !== "string" || !MIGRATION_NAME.test(migration.name)) {
			problem(`A migration's name, ${String(migration?.name)}, isn't letters, digits, dots, dashes and underscores.`);
		}
		if (typeof migration.sql !== "string" || migration.sql.trim() === "")
			problem(`The migration ${migration.name} has no SQL.`);
		const before = migrationNames.at(-1);
		if (before !== undefined && before >= migration.name) {
			problem(`The migration ${migration.name} doesn't sort after ${before}: name them so they sort oldest first.`);
		}
		migrationNames.push(migration.name);
	}

	const procedures = new Map<string, ModuleProcedure>();
	const walk = (group: ModuleProcedures, path: readonly string[]) => {
		for (const [name, entry] of Object.entries(group)) {
			if (!NAME.test(name))
				problem(`The procedure name ${[...path, name].join(".")} isn't a name (letters and digits).`);
			const at = [...path, name];
			if (isProcedure(entry)) {
				const dotted = at.join(".");
				checkPermission(entry.permission, `The procedure ${dotted}`);
				if (typeof entry.input?.extend !== "function" || typeof entry.input.shape !== "object") {
					problem(`The procedure ${dotted} doesn't take an object.`);
				}
				const taken = PLACE_KEYS.find((key) => key in entry.input.shape);
				if (taken) problem(`The procedure ${dotted} has its own ${taken}: WebCraft adds that.`);
				if (typeof entry.run !== "function") problem(`The procedure ${dotted} has no run function.`);
				if (entry.kind !== undefined && entry.kind !== "read" && entry.kind !== "write") {
					problem(`The procedure ${dotted} is neither a read nor a write.`);
				}
				if (entry.toolset !== undefined && !isToolset(entry.toolset)) {
					problem(`The procedure ${dotted} names the Toolset ${String(entry.toolset)}, which WebCraft doesn't have.`);
				}
				procedures.set(dotted, entry);
			} else if (entry && typeof entry === "object") {
				walk(entry as ModuleProcedures, at);
			} else {
				problem(`The procedure ${at.join(".")} isn't a procedure.`);
			}
		}
	};
	walk(definition.procedures ?? {}, []);

	const routes: CompiledRoute[] = [];
	const routeKeys = new Set<string>();
	for (const route of definition.siteRoutes ?? []) {
		if (level !== "site") problem("Only Site-level Modules answer on Sites.");
		if (manifest.routePrefix === undefined) problem("It has Site routes but no routePrefix in its manifest.");
		if (!ROUTE_METHODS.has(route?.method)) problem(`A Site route has the method ${String(route?.method)}.`);
		const parts = route.path === "/" ? [] : route.path.split("/").slice(1);
		if (!route.path.startsWith("/") || !parts.every((part) => ROUTE_PART.test(part))) {
			problem(`The Site route path ${route.path} isn't a path such as /notes or /notes/:id.`);
		}
		const key = `${route.method} ${parts.map((part) => (part.startsWith(":") ? ":" : part)).join("/")}`;
		if (routeKeys.has(key)) problem(`The Site route ${route.method} ${route.path} is declared twice.`);
		if (typeof route.handle !== "function")
			problem(`The Site route ${route.method} ${route.path} has no handle function.`);
		if (route.limit !== undefined) {
			const { requests, perSeconds } = route.limit ?? {};
			if (!isWhole(requests, 1, 100_000) || !isWhole(perSeconds, 1, 86_400)) {
				problem(`The Site route ${route.method} ${route.path}'s limit isn't whole requests per whole seconds.`);
			}
		}
		if (route.maxBodyBytes !== undefined && !isWhole(route.maxBodyBytes, 1, 10_000_000)) {
			problem(`The Site route ${route.method} ${route.path}'s maxBodyBytes isn't a whole number of bytes.`);
		}
		routeKeys.add(key);
		routes.push({
			route,
			parts: parts.map((part) => (part.startsWith(":") ? { param: part.slice(1) } : { fixed: part })),
		});
	}

	const pages: AdminPage[] = [];
	for (const page of definition.adminPages ?? []) {
		if (typeof page?.path !== "string" || !PAGE_PATH.test(page.path)) {
			problem(`The admin page path ${String(page?.path)} isn't lower-case letters, digits and dashes.`);
		}
		if (pages.some((other) => other.path === page.path)) problem(`The admin page ${page.path} is declared twice.`);
		const words = labelProblem(page.label ?? {}, manifest.adminLanguages);
		if (words) problem(`The admin page ${page.path}'s label: ${words}`);
		checkPermission(page.permission, `The admin page ${page.path}`);
		pages.push(page);
	}

	const events = new Set<ModuleEventName>();
	for (const [name, handler] of Object.entries(definition.events ?? {})) {
		if (!(MODULE_EVENTS as readonly string[]).includes(name)) problem(`There is no event ${name}.`);
		if (typeof handler !== "function") problem(`The event ${name} has no handler function.`);
		events.add(name as ModuleEventName);
	}

	const jobs = new Map<string, ModuleJob>();
	for (const [name, job] of Object.entries(definition.jobs ?? {})) {
		if (!JOB_NAME.test(name)) problem(`The job name ${name} isn't a name (letters, digits and dashes).`);
		if (typeof job?.payload?.safeParse !== "function" || typeof job.run !== "function") {
			problem(`The job ${name} needs a payload schema and a run function.`);
		}
		jobs.set(name, job);
	}

	const schedules: ModuleSchedule[] = [];
	for (const schedule of definition.schedules ?? []) {
		const job = jobs.get(schedule?.job);
		if (!job) problem(`The schedule names the job ${String(schedule?.job)}, which the Module doesn't declare.`);
		if (schedule.every !== "hour" && schedule.every !== "day") {
			problem(`The job ${schedule.job} runs every hour or every day, not every ${String(schedule.every)}.`);
		}
		if (!job.payload.safeParse({}).success) {
			problem(`The job ${schedule.job} runs on a schedule, so it must take an empty payload ({}).`);
		}
		if (schedules.some((other) => other.job === schedule.job)) problem(`The job ${schedule.job} is scheduled twice.`);
		schedules.push({ job: schedule.job, every: schedule.every });
	}

	const receiver = definition.formSubmissions ?? null;
	if (receiver !== null) {
		if (level !== "site") problem("Only Site-level Modules keep Form Submissions: Forms are on Sites.");
		if (typeof receiver.receive !== "function") problem("Its formSubmissions has no receive function.");
	}

	let siteScript: ModuleSiteScriptFile | null = null;
	if (definition.siteScript !== undefined) {
		const { code } = definition.siteScript ?? {};
		if (level !== "site") problem("Only Site-level Modules add a Site script: Workspaces have no pages.");
		if (typeof code !== "string" || code.trim() === "") problem("Its Site script has no code.");
		if (code.length > MODULE_SITE_SCRIPT_MAX_LENGTH) {
			problem(`Its Site script is longer than ${MODULE_SITE_SCRIPT_MAX_LENGTH} characters.`);
		}
		if (manifest.siteScript === null) {
			problem("It adds a Site script without declaring its Consent category: set siteScript in the manifest.");
		}
		const beforeConsent = definition.siteScript?.beforeConsent ?? false;
		if (typeof beforeConsent !== "boolean") problem("Its Site script's beforeConsent is true or false.");
		if (beforeConsent && manifest.siteScript === "necessary") {
			problem("Its Site script is Necessary: it runs before consent anyway, so beforeConsent says nothing.");
		}
		const name = `${createHash("sha256").update(code).digest("hex").slice(0, 16)}.js`;
		siteScript = { code, name, category: manifest.siteScript, beforeConsent };
	}

	const partitions: CompiledPartitioning[] = [];
	for (const partitioning of definition.partitions ?? []) {
		const { table, column } = partitioning ?? {};
		if (!table || !tables.has(table)) problem("A partitioned table isn't one of the Module's tables.");
		const name = getTableName(table);
		if (partitions.some((other) => other.name === name)) problem(`The table ${name} is partitioned twice.`);
		const columnKey = Object.entries(getTableColumns(table)).find(([, own]) => own === column)?.[0];
		if (!columnKey || !column) problem(`The table ${name} is partitioned by a column it doesn't have.`);
		if (column.getSQLType() !== "timestamp with time zone" || !column.notNull) {
			problem(
				`The table ${name} is partitioned by ${column.name}, which isn't a timestamp with time zone that is never null.`,
			);
		}
		const words = labelProblem(partitioning.label ?? {}, manifest.adminLanguages);
		if (words) problem(`The partitioned table ${name}'s label: ${words}`);
		if (!isWhole(partitioning.keepMonths, KEEP_MONTHS.min, KEEP_MONTHS.max)) {
			problem(`The table ${name} keeps its rows ${KEEP_MONTHS.min} to ${KEEP_MONTHS.max} whole months.`);
		}
		partitions.push({
			table,
			name,
			column: column.name,
			columnKey,
			label: partitioning.label,
			keepMonths: partitioning.keepMonths,
		});
	}

	const redirects = definition.redirectRules ?? null;
	if (redirects !== null) {
		if (level !== "site") problem("Only Site-level Modules keep Redirect rules: they are a Site's.");
		if (typeof redirects.find !== "function") problem("Its redirectRules has no find function.");
		if (!Array.isArray(redirects.tables)) problem("Its redirectRules doesn't list the tables find reads.");
		for (const table of redirects.tables) {
			if (!tables.has(table)) problem("Its redirectRules lists a table that isn't one of the Module's.");
		}
	}
	const notFound = definition.notFoundLog ?? null;
	if (notFound !== null) {
		if (level !== "site") problem("Only Site-level Modules keep the 404 log: it is a Site's.");
		if (typeof notFound.record !== "function") problem("Its notFoundLog has no record function.");
	}
	if (redirects !== null) {
		const { add, remove } = redirects;
		if ((add === undefined) !== (remove === undefined)) {
			problem("Its redirectRules adds rules for Imports without removing them for Undo, or the other way round.");
		}
		if ((add !== undefined && typeof add !== "function") || (remove !== undefined && typeof remove !== "function")) {
			problem("Its redirectRules' add and remove are functions.");
		}
	}

	const importSources = new Map<string, ImportSource>();
	for (const source of definition.importSources ?? []) {
		if (level !== "site") problem("Only Site-level Modules import content: an Import brings it into a Site.");
		if (typeof source?.key !== "string" || !SOURCE_KEY.test(source.key)) {
			problem(`The import source key ${String(source?.key)} isn't lower-case letters and dashes.`);
		}
		if (importSources.has(source.key)) problem(`The import source ${source.key} is declared twice.`);
		for (const [what, words] of [
			["label", source.label],
			["description", source.description],
		] as const) {
			const missing = labelProblem(words ?? {}, manifest.adminLanguages);
			if (missing) problem(`The import source ${source.key}'s ${what}: ${missing}`);
		}
		checkPermission(source.permission, `The import source ${source.key}`);
		const { maxBytes, extensions } = source.file ?? {};
		if (!isWhole(maxBytes, 1, IMPORT_FILE_MAX_BYTES)) {
			problem(`The import source ${source.key} takes files of 1 to ${IMPORT_FILE_MAX_BYTES} whole bytes.`);
		}
		if (!Array.isArray(extensions) || extensions.length === 0 || !extensions.every((ext) => FILE_EXTENSION.test(ext))) {
			problem(`The import source ${source.key} names the file endings it takes, such as .xml.`);
		}
		if (typeof source.read !== "function") problem(`The import source ${source.key} has no read function.`);
		importSources.set(source.key, source);
	}

	const widgets = checkWidgets(definition, manifest);

	return {
		runnable: true,
		id: manifest.id,
		definition,
		manifest,
		schema,
		level,
		permissions,
		tables,
		procedures,
		routes,
		pages,
		events,
		jobs,
		components: compileComponents(definition, manifest),
		schedules,
		receiver,
		siteScript,
		partitions,
		redirects,
		notFoundLog: notFound,
		importSources,
		widgets,
		widgetGoals: definition.widgetGoals ?? null,
	};
}

/**
 * Checks the Widget kinds a Module adds (SDK 1.8): Site-level Modules only (a Widget counts one Site
 * at a time; Workspace Dashboards add the Sites up), kinds named once, labels in its languages, a
 * shape the admin draws, filters it knows (`goal` with `widgetGoals`), and settings that are choices.
 */
function checkWidgets(definition: ModuleDefinition, manifest: ModuleManifest): ModuleWidget[] {
	const declared = definition.widgets ?? [];
	const goals = definition.widgetGoals;
	if (goals !== undefined && typeof goals !== "function") problem("Its widgetGoals isn't a function.");
	if (declared.length > 0 && manifest.level !== "site") {
		problem("Only Site-level Modules add Widgets: a Widget counts one Site at a time.");
	}
	const checked: ModuleWidget[] = [];
	for (const widget of declared) {
		const kind = widget?.kind;
		if (typeof kind !== "string" || !WIDGET_KIND.test(kind)) {
			problem(`The Widget kind ${String(kind)} isn't lower-case words joined by dashes.`);
		}
		if (checked.some((other) => other.kind === kind)) problem(`The Widget kind ${kind} is declared twice.`);
		for (const [what, words] of [
			["label", widget.label],
			["description", widget.description],
		] as const) {
			const missing = labelProblem(words ?? {}, manifest.adminLanguages);
			if (missing) problem(`The Widget ${kind}'s ${what}: ${missing}`);
		}
		if (!(WIDGET_SHAPES as readonly string[]).includes(widget.shape)) {
			problem(`The Widget ${kind}'s shape ${String(widget.shape)} isn't one of ${WIDGET_SHAPES.join(", ")}.`);
		}
		for (const filter of widget.filters ?? []) {
			if (!(WIDGET_FILTERS as readonly string[]).includes(filter)) {
				problem(`The Widget ${kind} takes the filter ${String(filter)}, which Dashboards don't have.`);
			}
			if (filter === "goal" && typeof goals !== "function") {
				problem(`The Widget ${kind} takes the goal filter, but the Module has no widgetGoals to offer its Goals.`);
			}
		}
		const keys = new Set<string>();
		for (const setting of widget.settings ?? []) {
			const key = setting?.key;
			if (typeof key !== "string" || !NAME.test(key)) problem(`A setting of the Widget ${kind} has no name.`);
			if (keys.has(key)) problem(`The Widget ${kind}'s setting ${key} is declared twice.`);
			keys.add(key);
			const words = labelProblem(setting.label ?? {}, manifest.adminLanguages);
			if (words) problem(`The Widget ${kind}'s setting ${key}: ${words}`);
			if (typeof setting.options === "function") {
				if (setting.default !== undefined) {
					problem(`The Widget ${kind}'s setting ${key} offers options worked out per Site: it can't have a default.`);
				}
			} else if (Array.isArray(setting.options)) {
				const values = new Set<string>();
				for (const option of setting.options as readonly WidgetOption[]) {
					if (typeof option?.value !== "string" || values.has(option.value)) {
						problem(`The Widget ${kind}'s setting ${key} has an option without a value of its own.`);
					}
					const label =
						typeof option.label === "string" ? null : labelProblem(option.label ?? {}, manifest.adminLanguages);
					if (label) problem(`The Widget ${kind}'s setting ${key}, option ${option.value}: ${label}`);
					values.add(option.value);
				}
				const defaults =
					setting.default === undefined
						? []
						: typeof setting.default === "string"
							? [setting.default]
							: [...setting.default];
				if (defaults.some((value) => !values.has(value))) {
					problem(`The Widget ${kind}'s setting ${key} starts with a value it doesn't offer.`);
				}
				if (!setting.multiple && defaults.length > 1) {
					problem(`The Widget ${kind}'s setting ${key} takes one value, but starts with several.`);
				}
			} else {
				problem(`The Widget ${kind}'s setting ${key} offers no options.`);
			}
		}
		if (typeof widget.query !== "function") problem(`The Widget ${kind} has no query function.`);
		checked.push(widget);
	}
	return checked;
}

function isWhole(value: unknown, least: number, most: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= least && value <= most;
}

/**
 * Checks and reads the Components a Module declares: PascalCase names, labels in its languages,
 * Props declared with the Field types (no Relationships: each Site has its own Post Types), and
 * markup that reads only its Props. Element ids are numbered, so every process reads the same tree.
 */
function compileComponents(definition: ModuleDefinition, manifest: ModuleManifest): ModuleComponent[] {
	const declared = definition.components ?? [];
	if (declared.length > 0 && manifest.level !== "site") {
		problem("Only Site-level Modules add Components: Components are placed on Sites.");
	}
	const compiled: ModuleComponent[] = [];
	for (const component of declared) {
		const name = component?.name;
		if (typeof name !== "string" || !isComponentName(name)) {
			problem(`${String(name)} isn't a Component's name: a PascalCase tag such as NoteCard.`);
		}
		if (compiled.some((other) => other.name === name)) problem(`The Component ${name} is declared twice.`);
		const words = labelProblem(component.label ?? {}, manifest.adminLanguages);
		if (words) problem(`The Component ${name}'s label: ${words}`);
		const problems: ContentProblem[] = [];
		const props = parseFields(propInputs(component.props ?? [], manifest, name), problems, {
			postTypeKeys: new Set(),
			owner: "moduleComponent",
			reservedKeys: RESERVED_PROP_KEYS,
			listName: "props",
		});
		const [first] = problems;
		if (first) problem(`The Component ${name}'s ${first.at}: ${first.message}`);
		if (typeof component.markup !== "string") problem(`The Component ${name} has no markup.`);
		let count = 0;
		try {
			const { tree } = parseTemplateMarkup(component.markup, {
				...moduleComponentTreeRules(props),
				newId: () => `n${++count}`,
			});
			compiled.push({ id: `${manifest.id}:${name}`, moduleId: manifest.id, name, props, tree });
		} catch (error) {
			if (!(error instanceof TemplateMarkupInvalidError)) throw error;
			const where = error.problems
				.map((each) => `line ${each.line}, column ${each.column}: ${each.message}`)
				.join("; ");
			problem(`The Component ${name}'s markup can't be read: ${where}`);
		}
	}
	return compiled;
}

/**
 * A Module Component's Props as Fields are declared: labels and help text in the Module's first
 * language (each checked in all of them).
 */
function propInputs(props: readonly ComponentProp[], manifest: ModuleManifest, component: string): FieldInput[] {
	const first = (words: Label | undefined) => (words ? (words[manifest.adminLanguages[0] ?? ""] ?? "") : undefined);
	return props.map((prop) => {
		for (const [what, words] of [
			["label", prop.label],
			["help", prop.help],
		] as const) {
			const missing =
				words === undefined && what === "help" ? null : labelProblem(words ?? {}, manifest.adminLanguages);
			if (missing) problem(`The Component ${component}'s Prop ${prop.key} ${what}: ${missing}`);
		}
		return {
			...prop,
			label: first(prop.label) ?? "",
			help: first(prop.help),
			options: prop.options ? [...prop.options] : undefined,
			fields: prop.fields ? propInputs(prop.fields, manifest, component) : undefined,
		} as FieldInput;
	});
}

function isProcedure(entry: unknown): entry is ModuleProcedure {
	return typeof entry === "object" && entry !== null && "run" in entry && "input" in entry && "permission" in entry;
}

/** The Permission a procedure or page names, resolved: one the Module adds, or one of WebCraft's. */
export function resolvePermission(module: RunnableModule, name: string): AddedPermission | Permission {
	const added = module.permissions.get(name);
	if (added) return added;
	if (isPermission(name)) return name;
	throw new TypeError(`The Module ${module.id} has no Permission ${name}.`);
}
