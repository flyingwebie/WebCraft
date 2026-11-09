/**
 * The Widgets Site analytics adds to Dashboards (SDK 1.8): the fixed catalog Staff build Dashboards
 * from. Every one reads through the query interface (`query.ts`), so Dashboards count exactly as the
 * `stats` procedures do: unfiltered totals, series and tables from the rollups where they are built
 * (back forever), anything filtered, Goals and Funnels from the raw events (back as far as they are
 * kept, which `countedFrom` says when a range reaches further).
 */
import {
	type Label,
	type ModuleContext,
	ModuleError,
	type ModuleWidget,
	type WidgetData,
	type WidgetFilterName,
	type WidgetRequest,
	widget,
} from "@webcraft/module-sdk";

import type { Filters } from "./filters.ts";
import { funnelCounts, listFunnels, requireFunnel } from "./funnels.ts";
import { listGoals, requireGoal } from "./goals.ts";
import type { Dimension, Measures } from "./measures.ts";
import { breakdown, countedRange, coverage, goalCounts, series, totals } from "./query.ts";

const ALL_FILTERS: readonly WidgetFilterName[] = ["page", "source", "country", "device", "goal"];
const BUT_GOAL: readonly WidgetFilterName[] = ["page", "source", "country", "device"];

const MEASURE_LABELS: Record<keyof Measures, Label> = {
	pageviews: { en: "Page views", it: "Visualizzazioni" },
	visitors: { en: "Visitors", it: "Visitatori" },
	visits: { en: "Visits", it: "Visite" },
	events: { en: "Events", it: "Eventi" },
};
const MEASURES = Object.keys(MEASURE_LABELS) as (keyof Measures)[];

const measureOptions = MEASURES.map((measure) => ({ value: measure, label: MEASURE_LABELS[measure] }));

/** The measures a Widget's `measures` setting chose, in their usual order (all of them when none). */
function chosenMeasures(request: WidgetRequest, fallback: readonly (keyof Measures)[]): (keyof Measures)[] {
	const given = request.settings.measures;
	const wanted = new Set(typeof given === "string" ? [given] : (given ?? []));
	const chosen = MEASURES.filter((measure) => wanted.has(measure));
	return chosen.length > 0 ? chosen : [...fallback];
}

/** One setting's single value, or a refusal when Staff haven't chosen it. */
function required(request: WidgetRequest, key: string, what: string): string {
	const value = request.settings[key];
	const one = typeof value === "string" ? value : value?.[0];
	if (!one) throw new ModuleError("WIDGET_SETTING_MISSING", `Choose the ${what} this Widget shows.`, 400);
	return one;
}

/** The filters, as the query interface takes them. */
function filtersOf(request: WidgetRequest): Filters | undefined {
	const { page, source, country, device, goal } = request.filters;
	const filters: Filters = {
		...(page ? { page } : {}),
		...(source !== undefined ? { source } : {}),
		...(country !== undefined ? { country } : {}),
		...(device !== undefined ? { device } : {}),
		...(goal !== undefined ? { goal } : {}),
	};
	return Object.keys(filters).length > 0 ? filters : undefined;
}

/** When counts read the raw events only and the range reaches back before the oldest still kept: where they start. */
async function countedFrom(context: ModuleContext, request: WidgetRequest, rawOnly: boolean): Promise<Date | null> {
	if (!rawOnly) return null;
	const { rawEventsFrom } = await coverage(context);
	return rawEventsFrom && rawEventsFrom.getTime() > request.range.from.getTime() ? rawEventsFrom : null;
}

/** A table of one dimension's values: the value, then page views and visitors (or events and visitors). */
function breakdownWidget(options: {
	kind: string;
	label: Label;
	description: Label;
	dimension: Dimension | ((request: WidgetRequest) => Dimension);
	column: { label: Label; kind: "text" | "path" | "source" | "country" | "device" };
	first: { measure: keyof Measures; label: Label };
	settings?: ModuleWidget["settings"];
}): ModuleWidget {
	return widget({
		kind: options.kind,
		label: options.label,
		description: options.description,
		shape: "table",
		filters: ALL_FILTERS,
		settings: options.settings,
		async query(request, context): Promise<WidgetData> {
			const dimension = typeof options.dimension === "function" ? options.dimension(request) : options.dimension;
			const filters = filtersOf(request);
			const rows = await breakdown(context, request.range, dimension, request.limit, filters);
			return {
				shape: "table",
				columns: [
					{ key: "value", label: options.column.label, kind: options.column.kind },
					{ key: options.first.measure, label: options.first.label, kind: "count" },
					{ key: "visitors", label: MEASURE_LABELS.visitors, kind: "count" },
				],
				rows: rows.map((row) => ({
					key: row.value,
					cells: { value: row.value, [options.first.measure]: row[options.first.measure], visitors: row.visitors },
				})),
				countedFrom: await countedFrom(context, request, filters !== undefined),
			};
		},
	});
}

const pageviews = { measure: "pageviews" as const, label: MEASURE_LABELS.pageviews };

export const siteAnalyticsWidgets: readonly ModuleWidget[] = [
	widget({
		kind: "totals",
		label: { en: "Totals", it: "Totali" },
		description: {
			en: "Page views, visitors, visits and events in the range.",
			it: "Visualizzazioni, visitatori, visite ed eventi nel periodo.",
		},
		shape: "number",
		filters: ALL_FILTERS,
		settings: [
			{
				key: "measures",
				label: { en: "Show", it: "Mostra" },
				options: measureOptions,
				multiple: true,
				default: MEASURES,
			},
		],
		async query(request, context) {
			const filters = filtersOf(request);
			const found = await totals(context, request.range, filters);
			return {
				shape: "number",
				values: chosenMeasures(request, MEASURES).map((measure) => ({
					key: measure,
					label: MEASURE_LABELS[measure],
					count: found[measure],
				})),
				countedFrom: await countedFrom(context, request, filters !== undefined),
			};
		},
	}),
	widget({
		kind: "trend",
		label: { en: "Over time", it: "Nel tempo" },
		description: {
			en: "Page views and visitors by hour or by day.",
			it: "Visualizzazioni e visitatori per ora o per giorno.",
		},
		shape: "series",
		filters: ALL_FILTERS,
		settings: [
			{
				key: "measures",
				label: { en: "Lines", it: "Linee" },
				options: measureOptions,
				multiple: true,
				default: ["pageviews", "visitors"],
			},
		],
		async query(request, context) {
			const filters = filtersOf(request);
			const measures = chosenMeasures(request, ["pageviews", "visitors"]);
			const points = await series(context, request.range, request.interval, filters);
			return {
				shape: "series",
				lines: measures.map((measure) => ({ key: measure, label: MEASURE_LABELS[measure] })),
				points: points.map((point) => ({
					start: point.start,
					values: Object.fromEntries(measures.map((measure) => [measure, point[measure]])),
				})),
				countedFrom: await countedFrom(context, request, filters !== undefined),
			};
		},
	}),
	breakdownWidget({
		kind: "top-pages",
		label: { en: "Top pages", it: "Pagine principali" },
		description: { en: "The pages viewed most.", it: "Le pagine più viste." },
		dimension: "page",
		column: { label: { en: "Page", it: "Pagina" }, kind: "path" },
		first: pageviews,
	}),
	breakdownWidget({
		kind: "sources",
		label: { en: "Sources", it: "Sorgenti" },
		description: {
			en: "Where visitors arrived from: campaigns, other sites, or directly.",
			it: "Da dove sono arrivati i visitatori: campagne, altri siti o direttamente.",
		},
		dimension: "source",
		column: { label: { en: "Source", it: "Sorgente" }, kind: "source" },
		first: { measure: "pageviews", label: { en: "Arrivals", it: "Arrivi" } },
	}),
	breakdownWidget({
		kind: "countries",
		label: { en: "Countries", it: "Paesi" },
		description: { en: "Where visitors are.", it: "Dove si trovano i visitatori." },
		dimension: "country",
		column: { label: { en: "Country", it: "Paese" }, kind: "country" },
		first: pageviews,
	}),
	breakdownWidget({
		kind: "devices",
		label: { en: "Devices", it: "Dispositivi" },
		description: { en: "Computers, phones and tablets.", it: "Computer, telefoni e tablet." },
		dimension: "device",
		column: { label: { en: "Device", it: "Dispositivo" }, kind: "device" },
		first: pageviews,
	}),
	breakdownWidget({
		kind: "browsers",
		label: { en: "Browsers", it: "Browser" },
		description: { en: "The browsers visitors use.", it: "I browser che usano i visitatori." },
		dimension: "browser",
		column: { label: { en: "Browser", it: "Browser" }, kind: "text" },
		first: pageviews,
	}),
	breakdownWidget({
		kind: "operating-systems",
		label: { en: "Operating systems", it: "Sistemi operativi" },
		description: {
			en: "The operating systems visitors use.",
			it: "I sistemi operativi che usano i visitatori.",
		},
		dimension: "os",
		column: { label: { en: "Operating system", it: "Sistema operativo" }, kind: "text" },
		first: pageviews,
	}),
	breakdownWidget({
		kind: "links",
		label: { en: "Link clicks", it: "Clic sui link" },
		description: {
			en: "Clicks on outbound, download, phone or email links, by where they go.",
			it: "Clic su link esterni, download, telefono o email, per destinazione.",
		},
		dimension: (request) => {
			const link = request.settings.link;
			return link === "download" || link === "tel" || link === "mailto" ? link : "outbound";
		},
		column: { label: { en: "Link", it: "Link" }, kind: "text" },
		first: { measure: "events", label: { en: "Clicks", it: "Clic" } },
		settings: [
			{
				key: "link",
				label: { en: "Links", it: "Link" },
				options: [
					{ value: "outbound", label: { en: "Outbound links", it: "Link esterni" } },
					{ value: "download", label: { en: "Downloads", it: "Download" } },
					{ value: "tel", label: { en: "Phone links", it: "Link telefonici" } },
					{ value: "mailto", label: { en: "Email links", it: "Link email" } },
				],
				default: "outbound",
			},
		],
	}),
	breakdownWidget({
		kind: "custom-events",
		label: { en: "Custom events", it: "Eventi personalizzati" },
		description: {
			en: "The custom events the Site's own code sends, by name.",
			it: "Gli eventi personalizzati inviati dal codice del sito, per nome.",
		},
		dimension: "event",
		column: { label: { en: "Event", it: "Evento" }, kind: "text" },
		first: { measure: "events", label: { en: "Times", it: "Volte" } },
	}),
	widget({
		kind: "goals",
		label: { en: "Goals", it: "Obiettivi" },
		description: {
			en: "Each Goal's conversions, the visitors who reached it and the conversion rate.",
			it: "Conversioni di ogni obiettivo, i visitatori che lo hanno raggiunto e il tasso di conversione.",
		},
		shape: "table",
		filters: BUT_GOAL,
		settings: [
			{
				key: "goals",
				label: { en: "Goals (all when none is chosen)", it: "Obiettivi (tutti se non se ne sceglie nessuno)" },
				options: async (context) => (await listGoals(context)).map((goal) => ({ value: goal.name, label: goal.name })),
				multiple: true,
			},
		],
		async query(request, context) {
			const given = request.settings.goals;
			const names = typeof given === "string" ? [given] : (given ?? []);
			const chosen =
				names.length > 0
					? await Promise.all(names.map((name) => requireGoal(context, name)))
					: await listGoals(context);
			const found = await goalCounts(context, request.range, chosen, filtersOf(request));
			return {
				shape: "table",
				columns: [
					{ key: "goal", label: { en: "Goal", it: "Obiettivo" }, kind: "text" },
					{ key: "conversions", label: { en: "Conversions", it: "Conversioni" }, kind: "count" },
					{ key: "visitors", label: { en: "Visitors converted", it: "Visitatori convertiti" }, kind: "count" },
					{ key: "rate", label: { en: "Conversion rate", it: "Tasso di conversione" }, kind: "rate" },
				],
				rows: chosen
					.map((goal, index) => {
						const counts = found.goals[index] ?? { conversions: 0, visitors: 0 };
						return {
							key: goal.name.toLowerCase(),
							cells: {
								goal: goal.name,
								conversions: counts.conversions,
								visitors: counts.visitors,
								rate: { count: counts.visitors, of: found.visitors },
							},
						};
					})
					.slice(0, request.limit),
				countedFrom: await countedFrom(context, request, true),
			};
		},
	}),
	widget({
		kind: "goal",
		label: { en: "Goal", it: "Obiettivo" },
		description: {
			en: "One Goal's conversions, the visitors who reached it and its conversion rate.",
			it: "Conversioni di un obiettivo, i visitatori che lo hanno raggiunto e il suo tasso di conversione.",
		},
		shape: "number",
		filters: BUT_GOAL,
		settings: [
			{
				key: "goal",
				label: { en: "Goal", it: "Obiettivo" },
				options: async (context) => (await listGoals(context)).map((goal) => ({ value: goal.name, label: goal.name })),
			},
		],
		async query(request, context) {
			const goal = await requireGoal(context, required(request, "goal", "Goal"));
			const found = await goalCounts(context, request.range, [goal], filtersOf(request));
			const counts = found.goals[0] ?? { conversions: 0, visitors: 0 };
			return {
				shape: "number",
				values: [
					{ key: "conversions", label: { en: "Conversions", it: "Conversioni" }, count: counts.conversions },
					{
						key: "visitors",
						label: { en: "Visitors converted", it: "Visitatori convertiti" },
						count: counts.visitors,
					},
					{
						key: "rate",
						label: { en: "Conversion rate", it: "Tasso di conversione" },
						count: counts.visitors,
						of: found.visitors,
					},
				],
				countedFrom: await countedFrom(context, request, true),
			};
		},
	}),
	widget({
		kind: "funnel",
		label: { en: "Funnel", it: "Funnel" },
		description: {
			en: "How many visitors reached each step of a Funnel, in order, within one day.",
			it: "Quanti visitatori hanno raggiunto ogni passo di un funnel, in ordine, nello stesso giorno.",
		},
		shape: "funnel",
		filters: ["source", "country", "device"],
		settings: [
			{
				key: "funnel",
				label: { en: "Funnel", it: "Funnel" },
				options: async (context) =>
					(await listFunnels(context)).map((funnel) => ({ value: funnel.name, label: funnel.name })),
			},
		],
		async query(request, context) {
			const funnel = await requireFunnel(context, required(request, "funnel", "Funnel"));
			const reached = await funnelCounts(context, countedRange(request.range), funnel, filtersOf(request));
			return {
				shape: "funnel",
				steps: funnel.steps.map((step, index) => ({ label: step.label, count: reached[index] ?? 0 })),
				countedFrom: await countedFrom(context, request, true),
			};
		},
	}),
];
