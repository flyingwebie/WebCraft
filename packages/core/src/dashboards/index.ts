/**
 * Dashboards (#103, GLOSSARY.md): grids of Widgets showing a Site's analytics, or a Workspace's Sites
 * added together (`services.dashboards`). Staff build them (`dashboard.manage`); Staff and Owners see
 * them all (`dashboard.view`); everyone else who works on the Site (Editors, Authors) sees those Staff
 * show to everyone, and only those. Dashboards are WebCraft's; the Widgets on them come from the
 * catalog Modules add (SDK 1.8, `ModuleHost.widgetKinds`), plus WebCraft's own note. A Widget's data
 * is worked out when someone looks: its Module's `query` on the Site (on each Site the person sees,
 * added up, for a Workspace Dashboard), for the Widget's own range or the Dashboard's.
 *
 * Dashboard templates keep a Dashboard's Widgets and range in its Workspace, to start Dashboards
 * from on any Site (or Workspace) of a Workspace the person builds Dashboards in. Widgets name Goals
 * and Funnels by their names, so a template finds the Goals of the same names wherever it is used.
 *
 * Seam for Reports and Share links (#104): `widgetAnswers` works out every Widget of a Dashboard as
 * plain data for one range, the read-only rendering both start from.
 */
import type { Database } from "@webcraft/db";
import { dashboards, dashboardTemplates, sites as sitesTable, workspaceDashboards } from "@webcraft/db/schema";
import { type Label, type WidgetData, type WidgetFilters, type WidgetSetting, wordsIn } from "@webcraft/module-sdk";
import { asc, desc, eq } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { ModuleHost, WidgetKind } from "../modules/host.ts";
import { can, personIdOf, type Resource } from "../permissions/can.ts";
import type {
	Access,
	BackgroundScope,
	BackgroundWorkspaceScope,
	DataLayer,
	Site,
	SiteScope,
	WorkspaceScope,
} from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { listSites } from "../tenancy/sites.ts";
import { visibleWorkspaces } from "../tenancy/workspaces.ts";
import { csvFilename, dashboardCsv, widgetCsv } from "./csv.ts";
import {
	DashboardInvalidError,
	DashboardNotFoundError,
	DashboardTemplateNotFoundError,
	WidgetNotFoundError,
} from "./errors.ts";
import {
	addUp,
	clampRect,
	type DashboardRange,
	DEFAULT_RANGE,
	freePlace,
	funnelStepsDiffer,
	MAX_DASHBOARDS,
	MAX_TEMPLATES,
	MAX_WIDGETS,
	NOTE_KIND,
	NOTE_MAX_LENGTH,
	placeWidget,
	type Rect,
	rangeProblem,
	resolveRange,
	type StoredWidget,
	storedRange,
	storedWidgets,
	WIDGET_ROWS,
} from "./model.ts";
import type {
	CatalogKind,
	CatalogSetting,
	DashboardPlace,
	DashboardSummary,
	DashboardView,
	WidgetAnswerView,
	WidgetDataView,
	WidgetView,
	WidgetViewShape,
} from "./views.ts";

export { csvCell } from "./csv.ts";
export * from "./errors.ts";
export * from "./model.ts";
export * from "./views.ts";

/** What a new Widget or a change to one gives. */
export type WidgetInput = {
	title?: string | null;
	range?: DashboardRange | null;
	filters?: StoredWidget["filters"];
	settings?: StoredWidget["settings"];
	rows?: number;
};

/** A Dashboard template, in a list. */
export type DashboardTemplateView = {
	id: string;
	workspaceId: string;
	workspace: string;
	name: string;
	madeFrom: string;
	widgets: number;
	createdAt: Date;
};

export type Dashboards = {
	/** The Widget kinds Staff can add here, in `language`, with whether each one's Module runs here. */
	catalog(access: Access, place: DashboardPlace, language: string): Promise<CatalogKind[]>;
	/**
	 * What a Widget kind's setting offers here (`goal`: the Goals its filter offers): worked out on the
	 * Site, or on each of the Workspace's Sites the person sees, by value.
	 */
	options(
		access: Access,
		place: DashboardPlace,
		kind: string,
		setting: string,
		language: string,
	): Promise<{ value: string; label: string }[]>;
	list(access: Access, place: DashboardPlace): Promise<DashboardSummary[]>;
	get(access: Access, place: DashboardPlace, dashboardId: string, language: string): Promise<DashboardView>;
	/** A new Dashboard, empty or from a template: `unmatched` names its Goals and Funnels this place lacks. */
	create(
		access: Access,
		place: DashboardPlace,
		input: { name: string; template?: { workspaceId: string; templateId: string } },
		language: string,
	): Promise<{ dashboard: DashboardView; unmatched: string[] }>;
	update(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		input: { name?: string; range?: DashboardRange; sharedWithEveryone?: boolean },
		language: string,
	): Promise<DashboardView>;
	delete(access: Access, place: DashboardPlace, dashboardId: string): Promise<void>;
	addWidget(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		input: WidgetInput & { kind: string; at?: Partial<Rect> },
		language: string,
	): Promise<{ dashboard: DashboardView; widgetId: string }>;
	updateWidget(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		widgetId: string,
		input: WidgetInput,
		language: string,
	): Promise<DashboardView>;
	/** Moves and resizes a Widget; the Widgets it would cover move down below it. */
	moveWidget(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		widgetId: string,
		rect: Rect,
		language: string,
	): Promise<DashboardView>;
	removeWidget(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		widgetId: string,
		language: string,
	): Promise<DashboardView>;
	/** What one Widget shows now: for its own range, else `range` when given (exploring), else the Dashboard's. */
	widgetData(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		widgetId: string,
		options: { range?: DashboardRange; language: string },
	): Promise<WidgetAnswerView>;
	/** Every Widget of a Dashboard, worked out as `widgetData` does (the seam for Reports and Share links, #104). */
	widgetAnswers(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		options: { range?: DashboardRange; language: string },
	): Promise<{ name: string; answers: WidgetAnswerView[] }>;
	/**
	 * Every Widget of a Dashboard as a Report or a Share link shows it (#104), with nobody signed in: the
	 * Dashboard's own Widgets, a Workspace Dashboard's added up over every Site of its Workspace. `range`
	 * is explored as in `widgetData`; `filters` narrow every Widget that takes them and has none of its
	 * own. Null when the Dashboard (or its place) is gone. Only Reports' jobs and a Share link's page,
	 * which checked who may see it, call it.
	 */
	shown(
		place: DashboardPlace,
		dashboardId: string,
		options: { range?: DashboardRange; filters?: WidgetFilters; language: string },
	): Promise<{ name: string; range: DashboardRange; answers: WidgetAnswerView[] } | null>;
	/** One Widget as a CSV file, recorded in the Audit log. */
	exportWidget(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		widgetId: string,
		options: { range?: DashboardRange; language: string },
	): Promise<{ filename: string; csv: string }>;
	/** Every Widget of a Dashboard as one CSV file, recorded in the Audit log. */
	export(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		options: { range?: DashboardRange; language: string },
	): Promise<{ filename: string; csv: string }>;
	/** Keeps a Dashboard's Widgets and range as a template in its Workspace. */
	saveAsTemplate(
		access: Access,
		place: DashboardPlace,
		dashboardId: string,
		name: string,
	): Promise<DashboardTemplateView>;
	/** The templates of every Workspace where the person builds Dashboards. */
	templates(access: Access): Promise<DashboardTemplateView[]>;
	deleteTemplate(access: Access, workspaceId: string, templateId: string): Promise<void>;
};

/** A Dashboard row, a Site's or a Workspace's. */
type Row = {
	id: string;
	name: string;
	range: unknown;
	sharedWithEveryone: boolean;
	widgets: unknown;
	createdAt: Date;
	updatedAt: Date;
};

/** A place opened for a person: its scope, its Dashboards' table, and the Sites a Widget counts on. */
type Opened = {
	level: "site" | "workspace";
	/** The person's scope, or a background one for a Report or Share link (`shown`), where nobody is signed in. */
	scope: SiteScope | WorkspaceScope | BackgroundScope | BackgroundWorkspaceScope;
	table: typeof dashboards | typeof workspaceDashboards;
	resource: Resource;
	/** The Site (a Site Dashboard), or the Workspace's Sites the person sees (a Workspace Dashboard). */
	sites(): Promise<Site[]>;
};

/** A Widget kind, as Dashboards know it: WebCraft's note, or a Module's. */
type KindInfo = {
	kind: string;
	moduleId: string | null;
	module: string | null;
	languages: readonly string[];
	label: Label;
	description: Label;
	shape: WidgetViewShape;
	filters: readonly string[];
	settings: readonly WidgetSetting[];
};

const NOTE: KindInfo = {
	kind: NOTE_KIND,
	moduleId: null,
	module: null,
	languages: ["en", "it"],
	label: { en: "Note", it: "Nota" },
	description: {
		en: "Your own words on the Dashboard, such as what a campaign changed.",
		it: "Parole vostre nella dashboard, come cosa ha cambiato una campagna.",
	},
	shape: "note",
	filters: [],
	settings: [],
};

/** The size a new Widget of a shape takes. */
const SIZES: Record<WidgetViewShape, { w: number; h: number }> = {
	note: { w: 4, h: 2 },
	number: { w: 6, h: 2 },
	series: { w: 8, h: 4 },
	table: { w: 6, h: 5 },
	funnel: { w: 6, h: 4 },
};

/** What `options` is asked for the Goals a Widget's Goal filter offers. */
export const GOAL_FILTER = "filter:goal";

/** How many rows each Site answers for a Workspace Dashboard's table, before they are added up and cut. */
const ROWS_PER_SITE = 1000;

export function createDashboards(deps: {
	database: Database;
	data: DataLayer;
	modules: ModuleHost;
	clock: Clock;
}): Dashboards {
	const { database, data, modules, clock } = deps;

	const kinds = (language: string): Map<string, KindInfo> => {
		const found = new Map<string, KindInfo>([[NOTE_KIND, NOTE]]);
		for (const each of modules.widgetKinds(language)) found.set(kindKey(each), infoOf(each));
		return found;
	};

	const open = async (access: Access, place: DashboardPlace, manage: boolean): Promise<Opened> => {
		if ("siteId" in place) {
			const scope = await data.site(access, place.siteId, manage ? "dashboard.manage" : "site.view");
			return {
				level: "site",
				scope,
				table: dashboards,
				resource: { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id },
				sites: async () => [scope.site],
			};
		}
		const scope = await data.workspace(access, place.workspaceId, manage ? "dashboard.manage" : "workspace.view");
		let sites: Promise<Site[]> | undefined;
		return {
			level: "workspace",
			scope,
			table: workspaceDashboards,
			resource: { level: "workspace", workspaceId: scope.workspace.id },
			sites: () => {
				sites ??= listSites(scope);
				return sites;
			},
		};
	};

	const holds = (opened: Opened, permission: "dashboard.view" | "dashboard.manage") =>
		"access" in opened.scope && can(opened.scope.access.actor, permission, opened.resource);

	/** A place opened for a Report or a Share link: nobody signed in, every Site of a Workspace counted. */
	const openShown = async (place: DashboardPlace): Promise<Opened | null> => {
		if ("siteId" in place) {
			const scope = await data.background(place.siteId);
			if (!scope) return null;
			return {
				level: "site",
				scope,
				table: dashboards,
				resource: { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id },
				sites: async () => [scope.site],
			};
		}
		const scope = await data.backgroundWorkspace(place.workspaceId);
		if (!scope) return null;
		let sites: Promise<Site[]> | undefined;
		return {
			level: "workspace",
			scope,
			table: workspaceDashboards,
			resource: { level: "workspace", workspaceId: scope.workspace.id },
			sites: () => {
				sites ??= scope
					.select(sitesTable, undefined, { orderBy: [asc(sitesTable.name), asc(sitesTable.slug)] })
					.then((rows) =>
						rows.map((row) => ({
							id: row.id,
							workspaceId: row.workspaceId,
							name: row.name,
							slug: row.slug,
							createdAt: row.createdAt,
						})),
					);
				return sites;
			},
		};
	};

	const queries = (opened: Opened) =>
		opened.scope as unknown as {
			select(table: Opened["table"], where?: unknown, options?: unknown): Promise<Row[]>;
			first(table: Opened["table"], where?: unknown): Promise<Row | undefined>;
			count(table: Opened["table"]): Promise<number>;
			insert(table: Opened["table"], values: object): Promise<Row>;
			update(table: Opened["table"], set: object, where?: unknown): Promise<Row[]>;
			delete(table: Opened["table"], where?: unknown): Promise<number>;
			transaction<Result>(work: (tx: SiteScope | WorkspaceScope) => Promise<Result>): Promise<Result>;
			audit(action: string, details?: Record<string, unknown>): Promise<void>;
		};

	/** A Dashboard the person sees here: every one with `dashboard.view`, else those shown to everyone. */
	const find = async (opened: Opened, dashboardId: string): Promise<Row> => {
		const row = await queries(opened).first(opened.table, eq(opened.table.id, dashboardId));
		if (!row || !(holds(opened, "dashboard.view") || holds(opened, "dashboard.manage") || row.sharedWithEveryone)) {
			throw new DashboardNotFoundError();
		}
		return row;
	};

	const viewOf = (opened: Opened, row: Row, language: string): DashboardView => {
		const known = kinds(language);
		return {
			id: row.id,
			name: row.name,
			range: storedRange(row.range),
			sharedWithEveryone: row.sharedWithEveryone,
			widgets: storedWidgets(row.widgets).map((widget): WidgetView => {
				const info = known.get(widget.kind);
				return {
					...widget,
					label: info ? wordsIn(info.label, language, info.languages) : widget.kind,
					shape: info?.shape ?? "note",
				};
			}),
			updatedAt: row.updatedAt,
			canManage: holds(opened, "dashboard.manage"),
		};
	};

	/** Changes one Dashboard's row, locked while it changes (two people moving Widgets never lose a move). */
	const change = async (
		opened: Opened,
		dashboardId: string,
		work: (row: Row, widgets: StoredWidget[]) => { widgets?: StoredWidget[]; set?: Partial<Row> },
	): Promise<Row> =>
		await queries(opened).transaction(async (tx) => {
			const scoped = tx as unknown as { db: Database["db"]; where(table: unknown, extra?: unknown): never };
			const [row] = (await scoped.db
				.select()
				.from(opened.table)
				.where(scoped.where(opened.table, eq(opened.table.id, dashboardId)))
				.for("update")) as Row[];
			if (!row) throw new DashboardNotFoundError();
			const { widgets, set } = work(row, storedWidgets(row.widgets));
			const [updated] = await (tx as unknown as ReturnType<typeof queries>).update(
				opened.table,
				{
					...set,
					...(widgets ? { widgets } : {}),
					updatedAt: tx.now(),
					updatedBy: personIdOf(tx.access.actor),
				},
				eq(opened.table.id, dashboardId),
			);
			return updated as Row;
		});

	/** A Widget's settings, filters and the rest, checked against its kind. */
	const checked = (
		info: KindInfo,
		input: WidgetInput,
		current: StoredWidget | null,
	): Omit<StoredWidget, "id" | "kind" | "x" | "y" | "w" | "h"> => {
		const range = input.range === undefined ? (current?.range ?? null) : input.range;
		if (range) {
			const problem = rangeProblem(range);
			if (problem) throw new DashboardInvalidError("range", problem);
		}
		const filters = input.filters ?? current?.filters ?? {};
		for (const [name, value] of Object.entries(filters)) {
			if (value !== undefined && !info.filters.includes(name)) {
				throw new DashboardInvalidError("filter", `This Widget can't be narrowed by ${name}.`);
			}
		}
		const rows = input.rows ?? current?.rows ?? 10;
		if (!(WIDGET_ROWS as readonly number[]).includes(rows)) {
			throw new DashboardInvalidError("setting", `A table shows ${WIDGET_ROWS.join(", ")} rows.`);
		}
		const given = input.settings ?? current?.settings ?? {};
		const settings: Record<string, string | string[]> = {};
		if (info.kind === NOTE_KIND) {
			const text = given.text;
			if (text !== undefined && (typeof text !== "string" || text.length > NOTE_MAX_LENGTH)) {
				throw new DashboardInvalidError("setting", `A note holds at most ${NOTE_MAX_LENGTH} characters.`);
			}
			for (const key of Object.keys(given)) {
				if (key !== "text") throw new DashboardInvalidError("setting", `A note has no setting ${key}.`);
			}
			settings.text = typeof text === "string" ? text : "";
		} else {
			for (const key of Object.keys(given)) {
				if (!info.settings.some((setting) => setting.key === key)) {
					throw new DashboardInvalidError("setting", `This Widget has no setting ${key}.`);
				}
			}
			for (const setting of info.settings) {
				const value = given[setting.key] ?? setting.default;
				if (value === undefined) continue;
				const values = typeof value === "string" ? [value] : [...value];
				if (!setting.multiple && values.length > 1) {
					throw new DashboardInvalidError("setting", `The setting ${setting.key} takes one value.`);
				}
				if (typeof setting.options !== "function") {
					const offered = new Set(setting.options.map((option) => option.value));
					if (values.some((each) => !offered.has(each))) {
						throw new DashboardInvalidError("setting", `The setting ${setting.key} doesn't offer that.`);
					}
				}
				if (values.length > 0) settings[setting.key] = setting.multiple ? values : (values[0] as string);
			}
		}
		const title = input.title === undefined ? (current?.title ?? null) : input.title?.trim() || null;
		return { title, range, filters, settings, rows };
	};

	const requireKind = (known: Map<string, KindInfo>, kind: string): KindInfo => {
		const info = known.get(kind);
		if (!info) throw new DashboardInvalidError("kind", `There is no Widget kind ${kind}.`);
		return info;
	};

	/** One Widget's answer now, on the Site or added up over the Workspace's Sites the person sees. */
	const answer = async (
		opened: Opened,
		row: Row,
		widget: StoredWidget,
		override: DashboardRange | undefined,
		language: string,
		known: Map<string, KindInfo>,
		explore: WidgetFilters = {},
	): Promise<WidgetAnswerView> => {
		const info = known.get(widget.kind);
		const range = resolveRange(widget.range ?? override ?? storedRange(row.range), clock.now());
		const title = widget.title ?? (info ? wordsIn(info.label, language, info.languages) : widget.kind);
		const base = { widgetId: widget.id, title, range, countedFrom: null, sites: null };
		if (widget.kind === NOTE_KIND) {
			const text = typeof widget.settings.text === "string" ? widget.settings.text : "";
			return { ...base, data: { shape: "note", text }, problem: null };
		}
		if (!info?.moduleId) {
			return {
				...base,
				data: null,
				problem: { code: "WIDGET_UNKNOWN", message: "No Module of this Install adds this Widget." },
			};
		}
		const kind = widget.kind.slice(info.moduleId.length + 1);
		// Exploring narrows by the filters the kind takes that the Widget doesn't set itself.
		const filters: WidgetFilters = { ...widget.filters };
		for (const [name, value] of Object.entries(explore) as [keyof WidgetFilters, never][]) {
			if (value !== undefined && filters[name] === undefined && info.filters.includes(name)) filters[name] = value;
		}
		const request = {
			range: { from: range.from, to: range.to },
			interval: range.interval,
			filters,
			settings: widget.settings,
			limit: widget.rows,
		};
		if (opened.level === "site") {
			const [site] = await opened.sites();
			const answered = await modules.runWidget(site as Site, info.moduleId, kind, request);
			if (!answered.data) return { ...base, data: null, problem: answered.problem };
			return {
				...base,
				data: dataView(answered.data, info, language),
				problem: null,
				countedFrom: answered.data.countedFrom ?? null,
			};
		}
		const sites = await opened.sites();
		const found: WidgetData[] = [];
		let problem: { code: string; message: string } | null = null;
		for (const site of sites) {
			if (!(await modules.runsOn(site, info.moduleId))) continue;
			const answered = await modules.runWidget(site, info.moduleId, kind, { ...request, limit: ROWS_PER_SITE });
			if (answered.data) found.push(answered.data);
			else problem ??= answered.problem;
		}
		// A Funnel is matched across Sites by name only, and each Site builds its own steps, so two
		// Sites' Funnel of that name can have different steps: then it can't be added up (model.ts).
		const differs = funnelStepsDiffer(found);
		const sum = differs ? null : addUp(found, widget.rows);
		const counted = { counted: found.length, of: sites.length };
		if (!sum) {
			return {
				...base,
				sites: counted,
				data: null,
				problem:
					problem ??
					(differs
						? {
								code: "FUNNEL_STEPS_DIFFER",
								message: "This Funnel's steps aren't the same on every Site, so they can't be added up.",
							}
						: {
								code: "MODULE_NOT_RUNNING",
								message: "The Module that adds this Widget isn't on for any of these Sites.",
							}),
			};
		}
		return {
			...base,
			sites: counted,
			data: dataView(sum, info, language),
			problem: null,
			countedFrom: sum.countedFrom ?? null,
		};
	};

	const widgetOf = (row: Row, widgetId: string): StoredWidget => {
		const widget = storedWidgets(row.widgets).find((each) => each.id === widgetId);
		if (!widget) throw new WidgetNotFoundError();
		return widget;
	};

	/**
	 * The values a place offers for a setting (or, as `filter:goal`, the Goals a Widget can be
	 * narrowed to), by value, in `language`: a Workspace's Sites' added together, each value once.
	 */
	const offered = async (
		opened: Opened,
		info: KindInfo,
		setting: string,
		language: string,
	): Promise<{ value: string; label: string }[]> => {
		if (!info.moduleId) return [];
		const kind = info.kind.slice(info.moduleId.length + 1);
		const found = new Map<string, { value: string; label: string }>();
		for (const site of await opened.sites()) {
			if (setting === GOAL_FILTER) {
				for (const name of await modules.widgetGoals(site, info.moduleId)) {
					if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { value: name, label: name });
				}
				continue;
			}
			for (const option of await modules.widgetOptions(site, info.moduleId, kind, setting)) {
				if (found.has(option.value)) continue;
				const label = typeof option.label === "string" ? option.label : wordsIn(option.label, language, info.languages);
				found.set(option.value, { value: option.value, label });
			}
		}
		return [...found.values()];
	};

	/** The Goal and Funnel names a Dashboard's Widgets name that this place doesn't have. */
	const unmatchedNames = async (opened: Opened, widgets: readonly StoredWidget[], language: string) => {
		const known = kinds(language);
		const missing = new Set<string>();
		const cache = new Map<string, Promise<Set<string>>>();
		const offeredAt = (info: KindInfo, setting: string) => {
			const key = `${info.kind} ${setting}`;
			let values = cache.get(key);
			if (!values) {
				values = offered(opened, info, setting, language).then(
					(options) => new Set(options.map((option) => option.value.toLowerCase())),
				);
				cache.set(key, values);
			}
			return values;
		};
		for (const widget of widgets) {
			const info = known.get(widget.kind);
			if (!info?.moduleId) continue;
			if (widget.filters.goal && !(await offeredAt(info, GOAL_FILTER)).has(widget.filters.goal.toLowerCase())) {
				missing.add(widget.filters.goal);
			}
			for (const setting of info.settings) {
				if (typeof setting.options !== "function") continue;
				const value = widget.settings[setting.key];
				const values = typeof value === "string" ? [value] : (value ?? []);
				const have = await offeredAt(info, setting.key);
				for (const each of values) if (!have.has(each.toLowerCase())) missing.add(each);
			}
		}
		return [...missing].sort((a, b) => a.localeCompare(b));
	};

	/** The Workspace scope a template is kept in, for someone who builds Dashboards there. */
	const templateScope = (access: Access, workspaceId: string) =>
		data.workspace(access, workspaceId, "dashboard.manage");

	const templateView = (row: typeof dashboardTemplates.$inferSelect, workspace: string): DashboardTemplateView => ({
		id: row.id,
		workspaceId: row.workspaceId,
		workspace,
		name: row.name,
		madeFrom: row.madeFrom,
		widgets: storedWidgets(row.widgets).length,
		createdAt: row.createdAt,
	});

	const service: Dashboards = {
		async catalog(access, place, language) {
			const opened = await open(access, place, false);
			const sites = await opened.sites();
			const catalog: CatalogKind[] = [];
			// Whether each Module runs here (on one of the Workspace's Sites at least), asked once per Module.
			const running = new Map<string, Promise<boolean>>();
			const runsHere = (moduleId: string) => {
				let found = running.get(moduleId);
				if (!found) {
					found = (async () => {
						for (const site of sites) if (await modules.runsOn(site, moduleId)) return true;
						return false;
					})();
					running.set(moduleId, found);
				}
				return found;
			};
			for (const info of kinds(language).values()) {
				const available = info.moduleId === null || (await runsHere(info.moduleId));
				catalog.push({
					kind: info.kind,
					module: info.module,
					label: wordsIn(info.label, language, info.languages),
					description: wordsIn(info.description, language, info.languages),
					shape: info.shape,
					filters: [...info.filters] as CatalogKind["filters"],
					settings: info.settings.map((setting) => settingView(setting, info, language)),
					available,
					size: SIZES[info.shape],
				});
			}
			return catalog;
		},

		async options(access, place, kind, setting, language) {
			const opened = await open(access, place, false);
			if (!holds(opened, "dashboard.manage") && !holds(opened, "dashboard.view")) {
				throw new PermissionDeniedError("dashboard.view");
			}
			const info = requireKind(kinds(language), kind);
			const declared = info.settings.some((each) => each.key === setting);
			if (!declared && !(setting === GOAL_FILTER && info.filters.includes("goal"))) {
				throw new DashboardInvalidError("setting", `This Widget has no setting ${setting}.`);
			}
			return await offered(opened, info, setting, language);
		},

		async list(access, place) {
			const opened = await open(access, place, false);
			const all = holds(opened, "dashboard.view") || holds(opened, "dashboard.manage");
			const rows = await queries(opened).select(opened.table, undefined, {
				orderBy: [asc(opened.table.name), asc(opened.table.createdAt)],
			});
			return rows
				.filter((row) => all || row.sharedWithEveryone)
				.map((row) => ({
					id: row.id,
					name: row.name,
					widgets: storedWidgets(row.widgets).length,
					sharedWithEveryone: row.sharedWithEveryone,
					updatedAt: row.updatedAt,
				}));
		},

		async get(access, place, dashboardId, language) {
			const opened = await open(access, place, false);
			return viewOf(opened, await find(opened, dashboardId), language);
		},

		async create(access, place, input, language) {
			const opened = await open(access, place, true);
			if ((await queries(opened).count(opened.table)) >= MAX_DASHBOARDS) {
				throw new DashboardInvalidError("dashboards", `A place has at most ${MAX_DASHBOARDS} Dashboards.`);
			}
			let range: DashboardRange = DEFAULT_RANGE;
			let widgets: StoredWidget[] = [];
			let template: string | null = null;
			if (input.template) {
				const scope = await templateScope(access, input.template.workspaceId).catch(() => {
					throw new DashboardTemplateNotFoundError();
				});
				const found = await scope.first(dashboardTemplates, eq(dashboardTemplates.id, input.template.templateId));
				if (!found) throw new DashboardTemplateNotFoundError();
				range = storedRange(found.range);
				widgets = storedWidgets(found.widgets).map((widget) => ({ ...widget, id: crypto.randomUUID() }));
				template = found.name;
			}
			const now = clock.now();
			const row = await queries(opened).transaction(async (tx) => {
				const made = await (tx as unknown as ReturnType<typeof queries>).insert(opened.table, {
					name: input.name,
					range,
					widgets,
					sharedWithEveryone: false,
					createdAt: now,
					updatedAt: now,
					updatedBy: personIdOf(access.actor),
				});
				await tx.audit("dashboard.create", {
					dashboardId: made.id,
					name: made.name,
					...(template ? { template } : {}),
				});
				return made;
			});
			return {
				dashboard: viewOf(opened, row, language),
				unmatched: await unmatchedNames(opened, widgets, language),
			};
		},

		async update(access, place, dashboardId, input, language) {
			const opened = await open(access, place, true);
			if (input.range) {
				const problem = rangeProblem(input.range);
				if (problem) throw new DashboardInvalidError("range", problem);
			}
			const row = await change(opened, dashboardId, () => ({
				set: {
					...(input.name !== undefined ? { name: input.name } : {}),
					...(input.range !== undefined ? { range: input.range } : {}),
					...(input.sharedWithEveryone !== undefined ? { sharedWithEveryone: input.sharedWithEveryone } : {}),
				},
			}));
			await queries(opened).audit("dashboard.update", {
				dashboardId,
				name: row.name,
				...(input.range !== undefined ? { range: input.range } : {}),
				...(input.sharedWithEveryone !== undefined ? { sharedWithEveryone: input.sharedWithEveryone } : {}),
			});
			return viewOf(opened, row, language);
		},

		async delete(access, place, dashboardId) {
			const opened = await open(access, place, true);
			const row = await find(opened, dashboardId);
			await queries(opened).transaction(async (tx) => {
				await (tx as unknown as ReturnType<typeof queries>).delete(opened.table, eq(opened.table.id, dashboardId));
				await tx.audit("dashboard.delete", { dashboardId, name: row.name });
			});
		},

		async addWidget(access, place, dashboardId, input, language) {
			const opened = await open(access, place, true);
			const info = requireKind(kinds(language), input.kind);
			const id = crypto.randomUUID();
			const row = await change(opened, dashboardId, (_row, widgets) => {
				if (widgets.length >= MAX_WIDGETS) {
					throw new DashboardInvalidError("widgets", `A Dashboard holds at most ${MAX_WIDGETS} Widgets.`);
				}
				const size = { w: input.at?.w ?? SIZES[info.shape].w, h: input.at?.h ?? SIZES[info.shape].h };
				const rect =
					input.at?.x !== undefined && input.at.y !== undefined
						? clampRect({ x: input.at.x, y: input.at.y, ...size })
						: freePlace(widgets, size);
				const widget: StoredWidget = { id, kind: info.kind, ...rect, ...checked(info, input, null) };
				return { widgets: placeWidget([...widgets, widget], id, rect) };
			});
			return { dashboard: viewOf(opened, row, language), widgetId: id };
		},

		async updateWidget(access, place, dashboardId, widgetId, input, language) {
			const opened = await open(access, place, true);
			const known = kinds(language);
			const row = await change(opened, dashboardId, (_row, widgets) => {
				const current = widgets.find((widget) => widget.id === widgetId);
				if (!current) throw new WidgetNotFoundError();
				const info = requireKind(known, current.kind);
				const next = { ...current, ...checked(info, input, current) };
				return { widgets: widgets.map((widget) => (widget.id === widgetId ? next : widget)) };
			});
			return viewOf(opened, row, language);
		},

		async moveWidget(access, place, dashboardId, widgetId, rect, language) {
			const opened = await open(access, place, true);
			const row = await change(opened, dashboardId, (_row, widgets) => {
				if (!widgets.some((widget) => widget.id === widgetId)) throw new WidgetNotFoundError();
				return { widgets: placeWidget(widgets, widgetId, rect) };
			});
			return viewOf(opened, row, language);
		},

		async removeWidget(access, place, dashboardId, widgetId, language) {
			const opened = await open(access, place, true);
			const row = await change(opened, dashboardId, (_row, widgets) => {
				if (!widgets.some((widget) => widget.id === widgetId)) throw new WidgetNotFoundError();
				return { widgets: widgets.filter((widget) => widget.id !== widgetId) };
			});
			return viewOf(opened, row, language);
		},

		async widgetData(access, place, dashboardId, widgetId, options) {
			const opened = await open(access, place, false);
			const row = await find(opened, dashboardId);
			return await answer(
				opened,
				row,
				widgetOf(row, widgetId),
				options.range,
				options.language,
				kinds(options.language),
			);
		},

		async widgetAnswers(access, place, dashboardId, options) {
			const opened = await open(access, place, false);
			const row = await find(opened, dashboardId);
			const known = kinds(options.language);
			const answers: WidgetAnswerView[] = [];
			const ordered = storedWidgets(row.widgets).sort((a, b) => a.y - b.y || a.x - b.x);
			for (const widget of ordered) {
				answers.push(await answer(opened, row, widget, options.range, options.language, known));
			}
			return { name: row.name, answers };
		},

		async shown(place, dashboardId, options) {
			const opened = await openShown(place);
			if (!opened) return null;
			const row = await queries(opened).first(opened.table, eq(opened.table.id, dashboardId));
			if (!row) return null;
			const known = kinds(options.language);
			const answers: WidgetAnswerView[] = [];
			const ordered = storedWidgets(row.widgets).sort((a, b) => a.y - b.y || a.x - b.x);
			for (const widget of ordered) {
				answers.push(await answer(opened, row, widget, options.range, options.language, known, options.filters));
			}
			return { name: row.name, range: storedRange(row.range), answers };
		},

		async exportWidget(access, place, dashboardId, widgetId, options) {
			const opened = await open(access, place, false);
			const row = await find(opened, dashboardId);
			const answered = await answer(
				opened,
				row,
				widgetOf(row, widgetId),
				options.range,
				options.language,
				kinds(options.language),
			);
			await queries(opened).audit("dashboard.export", {
				dashboardId,
				name: row.name,
				widgetId,
				widget: answered.title,
			});
			return {
				filename: csvFilename(`${row.name} ${answered.title}`, clock.now()),
				csv: widgetCsv(answered, options.language),
			};
		},

		async export(access, place, dashboardId, options) {
			const { name, answers } = await service.widgetAnswers(access, place, dashboardId, options);
			const opened = await open(access, place, false);
			await queries(opened).audit("dashboard.export", { dashboardId, name, widgets: answers.length });
			return { filename: csvFilename(name, clock.now()), csv: dashboardCsv(name, answers, options.language) };
		},

		async saveAsTemplate(access, place, dashboardId, name) {
			const opened = await open(access, place, true);
			const row = await find(opened, dashboardId);
			const scope = await templateScope(access, opened.scope.workspace.id);
			if ((await scope.count(dashboardTemplates)) >= MAX_TEMPLATES) {
				throw new DashboardInvalidError("templates", `A Workspace keeps at most ${MAX_TEMPLATES} Dashboard templates.`);
			}
			const made = await scope.transaction(async (tx) => {
				const inserted = await tx.insert(dashboardTemplates, {
					name,
					range: storedRange(row.range),
					widgets: storedWidgets(row.widgets),
					madeFrom: row.name,
					createdAt: clock.now(),
					createdBy: personIdOf(access.actor),
				});
				await tx.audit("dashboardTemplate.create", { templateId: inserted.id, name, madeFrom: row.name });
				return inserted;
			});
			return templateView(made, scope.workspace.name);
		},

		async templates(access) {
			const found: DashboardTemplateView[] = [];
			for (const workspace of await visibleWorkspaces(database.db, access.actor)) {
				if (!can(access.actor, "dashboard.manage", { level: "workspace", workspaceId: workspace.id })) continue;
				const scope = await templateScope(access, workspace.id);
				const rows = await scope.select(dashboardTemplates, undefined, {
					orderBy: [asc(dashboardTemplates.name), desc(dashboardTemplates.createdAt)],
				});
				found.push(...rows.map((row) => templateView(row, workspace.name)));
			}
			return found;
		},

		async deleteTemplate(access, workspaceId, templateId) {
			const scope = await templateScope(access, workspaceId);
			const row = await scope.first(dashboardTemplates, eq(dashboardTemplates.id, templateId));
			if (!row) throw new DashboardTemplateNotFoundError();
			await scope.transaction(async (tx) => {
				await tx.delete(dashboardTemplates, eq(dashboardTemplates.id, templateId));
				await tx.audit("dashboardTemplate.delete", { templateId, name: row.name });
			});
		},
	};
	return service;
}

/** A Module's Widget kind as Dashboards name it: `<module id>:<kind>`. */
function kindKey(kind: WidgetKind): string {
	return `${kind.moduleId}:${kind.widget.kind}`;
}

function infoOf(kind: WidgetKind): KindInfo {
	return {
		kind: kindKey(kind),
		moduleId: kind.moduleId,
		module: kind.module,
		languages: kind.languages,
		label: kind.widget.label,
		description: kind.widget.description,
		shape: kind.widget.shape,
		filters: kind.widget.filters ?? [],
		settings: kind.widget.settings ?? [],
	};
}

function settingView(setting: WidgetSetting, info: KindInfo, language: string): CatalogSetting {
	return {
		key: setting.key,
		label: wordsIn(setting.label, language, info.languages),
		multiple: setting.multiple === true,
		options:
			typeof setting.options === "function"
				? null
				: setting.options.map((option) => ({
						value: option.value,
						label: typeof option.label === "string" ? option.label : wordsIn(option.label, language, info.languages),
					})),
		default:
			setting.default === undefined
				? null
				: typeof setting.default === "string"
					? setting.default
					: [...setting.default],
	};
}

/** A Module's answer, its labels in the person's language. */
function dataView(data: WidgetData, info: KindInfo, language: string): WidgetDataView {
	const words = (label: Label) => wordsIn(label, language, info.languages);
	switch (data.shape) {
		case "number":
			return {
				shape: "number",
				values: data.values.map((value) => ({
					key: value.key,
					label: words(value.label),
					count: value.count,
					of: value.of ?? null,
				})),
			};
		case "series":
			return {
				shape: "series",
				lines: data.lines.map((line) => ({ key: line.key, label: words(line.label) })),
				points: data.points.map((point) => ({ start: point.start, values: { ...point.values } })),
			};
		case "table":
			return {
				shape: "table",
				columns: data.columns.map((column) => ({ key: column.key, label: words(column.label), kind: column.kind })),
				rows: data.rows.map((row) => ({ key: row.key, cells: { ...row.cells } })),
			};
		case "funnel":
			return { shape: "funnel", steps: data.steps.map((step) => ({ label: step.label, count: step.count })) };
	}
}
