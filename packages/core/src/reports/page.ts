import { createHash } from "node:crypto";
import type { WidgetColumnKind, WidgetFilters } from "@webcraft/module-sdk";
import { escapeAttribute, escapeText } from "@webcraft/renderer";

import { RANGE_PRESETS } from "../dashboards/model.ts";
import type { WidgetAnswerView, WidgetDataView } from "../dashboards/views.ts";
import { dayText, fill, numberText, percentText, periodText, type ReportWords, reportWords } from "./words.ts";

/**
 * The one page a Dashboard is shown as outside the admin (spec: "Reports are rendered by headless
 * Chromium from the Share link HTML"): a Share link's page, and the page the worker turns into a
 * Report's PDF. WebCraft's own HTML, complete in itself: every value escaped, no script, its styles in
 * one `<style>` element allowed by its hash (`REPORT_PAGE_POLICY`), images only as `data:` addresses,
 * nothing to fetch. Charts are drawn in SVG with the same numbers as a table beside them, and nothing
 * is said by colour alone. Light and dark follow the device; printing is light.
 */

/** A brand as the page shows it; a logo is a `data:` address (PNG, JPEG or WebP). */
export type ReportBrand = {
	/** The agency brand, or null when it doesn't show. */
	agency: { name: string | null; logo: string | null; accent: string | null } | null;
	/** The client brand (the Site's, or the Workspace's), or null when it doesn't show. */
	client: { name: string; logo: string | null } | null;
	/** Whether "Made with WebCraft" shows at the foot. */
	madeWith: boolean;
};

/** One Widget on the page: its answer, the same Widget's answer for the period before (null: no comparison), and its AI text. */
export type ReportWidget = {
	answer: WidgetAnswerView;
	previous: WidgetAnswerView | null;
	text: string | null;
};

/** The AI text of a Report, or why it has none (`none`: there was nothing to write about). */
export type ReportAiView =
	| {
			status: "written";
			whatHappened: string;
			suggestions: { text: string; service: string | null }[];
	  }
	| { status: "noKey" | "cap" | "failed" | "none" };

/** What a Share link's page lets people explore: the days, and the filters every Widget that takes them is narrowed by. */
export type ReportExplore = {
	range: (typeof RANGE_PRESETS)[number] | null;
	filters: Pick<WidgetFilters, "country" | "device" | "source" | "page">;
};

export type ReportPageInput = {
	/** The language of its words: `en` or `it`. */
	language: string;
	/** The Report's name, or the Dashboard's on a Share link's page. */
	title: string;
	/** What it is about: the Site's (or the Workspace's) name. */
	placeName: string;
	brand: ReportBrand;
	/** The days it shows (null: each Widget says its own, as on a Share link's page). */
	period: { from: Date; to: Date } | null;
	/** The days it compares with. */
	compared: { from: Date; to: Date } | null;
	widgets: readonly ReportWidget[];
	/** A Report's AI text; null on a Share link's page. */
	ai: ReportAiView | null;
	/** A Share link's explore form; null in a Report. */
	explore: ReportExplore | null;
};

const STYLES = `:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#52525b;--card:#fff;--border:#d4d4d8;--accent:#c2410c;--accent-fg:#fff;--line2:#18181b;--line3:#52525b;--line4:#0f766e;--up:#166534;--down:#991b1b}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--card:#18181b;--border:#3f3f46;--accent:#fb923c;--accent-fg:#09090b;--line2:#fafafa;--line3:#a1a1aa;--line4:#5eead4;--up:#86efac;--down:#fca5a5}}
@media print{:root{color-scheme:light;--bg:#fff;--fg:#18181b;--muted:#52525b;--card:#fff;--border:#d4d4d8;--accent:#c2410c;--line2:#18181b;--line3:#52525b;--line4:#0f766e;--up:#166534;--down:#991b1b}.explore,.skip{display:none}section,.ai{break-inside:avoid}}
@page{size:A4;margin:14mm}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Liberation Sans",Arial,sans-serif}
.skip{position:absolute;top:.5rem;left:.5rem;padding:.5rem 1rem;background:var(--card);color:var(--fg);z-index:1}
.skip:not(:focus){clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap;padding:0}
.wrap{max-width:72rem;margin:0 auto;padding:1rem}
header.brand{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem;padding-bottom:.75rem;border-bottom:1px solid var(--border)}
.brand-side{display:flex;align-items:center;gap:.75rem;min-width:0}
.brand-side img{max-height:2.5rem;max-width:10rem;height:auto;width:auto}
.brand-name{font-weight:600;overflow-wrap:anywhere}
.accent{display:block;width:100%;height:4px;margin-bottom:.75rem}
h1{font-size:1.6rem;line-height:1.25;margin:1rem 0 .25rem;overflow-wrap:anywhere}
h2{font-size:1.1rem;line-height:1.3;margin:0 0 .5rem;overflow-wrap:anywhere}
p{margin:.25rem 0}
.muted{color:var(--muted)}
main:focus{outline:none}
.grid{display:grid;grid-template-columns:1fr;gap:1rem;margin-top:1rem}
@media (min-width:48rem){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wide{grid-column:1/-1}}
@media print{.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wide{grid-column:1/-1}}
section,.ai,.explore{background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:1rem;min-width:0}
.ai{margin-top:1rem}
.ai ul{margin:.25rem 0;padding-inline-start:1.25rem}
.ai-note,.widget-text{font-size:.9rem;color:var(--muted)}
.widget-text{border-top:1px solid var(--border);margin-top:.75rem;padding-top:.5rem}
dl.numbers{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:1rem;margin:0}
dl.numbers dt{color:var(--muted);font-size:.9rem}
dl.numbers dd{margin:0;font-size:1.6rem;font-weight:600;font-variant-numeric:tabular-nums}
.change{display:block;font-size:.8rem;font-weight:400;color:var(--muted)}
.change.up{color:var(--up)}.change.down{color:var(--down)}
.note{white-space:pre-wrap}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
caption{text-align:start;color:var(--muted);font-size:.85rem;padding-bottom:.25rem}
th,td{padding:.35rem .5rem;border-bottom:1px solid var(--border);text-align:start;vertical-align:top}
th{font-weight:600}
td.n,th.n{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}
td.t{overflow-wrap:anywhere}
svg.chart{width:100%;height:auto;display:block;margin-bottom:.5rem}
.legend{display:flex;flex-wrap:wrap;gap:1rem;list-style:none;margin:0 0 .5rem;padding:0;font-size:.85rem}
.legend li{display:flex;align-items:center;gap:.4rem}
.axis{stroke:var(--border);fill:none}
.label{fill:var(--muted);font-size:11px}
.line{fill:none;stroke-width:2}
.l0{stroke:var(--accent)}.l1{stroke:var(--line2);stroke-dasharray:6 4}.l2{stroke:var(--line3);stroke-dasharray:2 3}.l3{stroke:var(--line4);stroke-dasharray:10 3 2 3}
.m0{fill:var(--accent)}.m1{fill:var(--line2)}.m2{fill:var(--line3)}.m3{fill:var(--line4)}
.explore{margin-top:1rem}
.explore fieldset{border:0;margin:0;padding:0;display:grid;grid-template-columns:1fr;gap:.75rem}
@media (min-width:48rem){.explore fieldset{grid-template-columns:repeat(3,minmax(0,1fr))}}
.explore legend{font-weight:600;font-size:1.1rem;margin-bottom:.25rem;padding:0}
label{display:block;font-weight:600;font-size:.9rem;margin-bottom:.25rem}
.hint{display:block;color:var(--muted);font-size:.8rem;margin-top:.15rem}
input,select{display:block;width:100%;min-height:2.5rem;padding:.4rem .6rem;border:1px solid var(--muted);border-radius:.5rem;background:var(--card);color:var(--fg);font:inherit}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin-top:.75rem}
button{min-height:2.5rem;padding:.5rem 1rem;border-radius:.5rem;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer}
a{color:inherit}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.narrow{max-width:28rem;margin:2rem auto 0}
.problem{color:var(--down);font-weight:600}
input[aria-invalid="true"]{border-color:var(--down)}
footer{margin-top:1.5rem;padding-top:.75rem;border-top:1px solid var(--border);font-size:.85rem;color:var(--muted)}
`;

/** The policy the page is sent with: its own `<style>` (by hash), `data:` images, its form to itself, no script. */
export const REPORT_PAGE_POLICY = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(STYLES).digest("base64")}'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

/** The page, as a complete HTML document. */
export function reportPage(input: ReportPageInput): string {
	const words = reportWords(input.language);
	const lang = input.language;
	const parts: string[] = [];
	parts.push(
		"<!doctype html>",
		`<html lang="${escapeAttribute(lang)}" dir="ltr">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex, nofollow">',
		'<meta name="referrer" content="no-referrer">',
		'<meta name="color-scheme" content="light dark">',
		`<title>${escapeText(`${input.title} · ${input.placeName}`)}</title>`,
		`<style>${STYLES}</style>`,
		"</head>",
		"<body>",
		`<a class="skip" href="#main">${escapeText(words.skipLink)}</a>`,
		'<div class="wrap">',
		brandHeader(input.brand),
		'<main id="main" tabindex="-1">',
		`<h1>${escapeText(input.title)}</h1>`,
		`<p>${escapeText(fill(words.reportFor, { place: input.placeName }))}</p>`,
	);
	if (input.period)
		parts.push(`<p class="muted">${escapeText(periodText(input.period.from, input.period.to, lang))}</p>`);
	if (input.compared) {
		const compared = periodText(input.compared.from, input.compared.to, lang);
		parts.push(`<p class="muted">${escapeText(fill(words.comparedWith, splitPeriod(compared)))}</p>`);
	}
	if (input.explore) parts.push(exploreForm(input.explore, words));
	if (input.ai) parts.push(aiSummary(input.ai, words));
	parts.push('<div class="grid">');
	for (const widget of input.widgets) parts.push(widgetSection(widget, input, words));
	parts.push("</div>", "</main>");
	if (input.brand.madeWith) parts.push(`<footer><p>${escapeText(words.madeWith)}</p></footer>`);
	parts.push("</div>", "</body>", "</html>");
	return parts.join("\n");
}

/** "{from} – {to}" back into its two days, for words that name them apart. */
function splitPeriod(text: string): { from: string; to: string } {
	const [from = text, to = ""] = text.split(" – ");
	return { from, to };
}

function brandHeader(brand: ReportBrand): string {
	if (!brand.agency && !brand.client) return "";
	const side = (name: string | null, logo: string | null) => {
		if (!name && !logo) return "";
		const image = logo ? `<img src="${escapeAttribute(logo)}" alt="${escapeAttribute(name ?? "")}">` : "";
		return `<div class="brand-side">${image}${name ? `<span class="brand-name">${escapeText(name)}</span>` : ""}</div>`;
	};
	const accent = brand.agency?.accent
		? `<svg class="accent" aria-hidden="true" focusable="false" viewBox="0 0 100 4" preserveAspectRatio="none"><rect width="100" height="4" fill="${escapeAttribute(brand.agency.accent)}"/></svg>`
		: "";
	return [
		accent,
		'<header class="brand">',
		brand.client ? side(brand.client.name, brand.client.logo) : "<div></div>",
		brand.agency ? side(brand.agency.name, brand.agency.logo) : "",
		"</header>",
	].join("");
}

function exploreForm(explore: ReportExplore, words: ReportWords): string {
	const option = (value: string, label: string, selected: boolean) =>
		`<option value="${escapeAttribute(value)}"${selected ? " selected" : ""}>${escapeText(label)}</option>`;
	const ranges = RANGE_PRESETS.map((preset) => option(preset, words.ranges[preset], explore.range === preset)).join("");
	const devices = [
		option("", words.explore.anyDevice, !explore.filters.device),
		...(["desktop", "mobile", "tablet"] as const).map((device) =>
			option(device, words.explore.devices[device], explore.filters.device === device),
		),
	].join("");
	const text = (name: string, label: string, value: string, hint?: string, attributes = "") =>
		`<div><label for="explore-${name}">${escapeText(label)}</label><input id="explore-${name}" name="${name}" value="${escapeAttribute(value)}"${hint ? ` aria-describedby="explore-${name}-hint"` : ""}${attributes}>${hint ? `<span class="hint" id="explore-${name}-hint">${escapeText(hint)}</span>` : ""}</div>`;
	return [
		'<form class="explore" method="get">',
		"<fieldset>",
		`<legend>${escapeText(words.explore.title)}</legend>`,
		`<p class="muted wide">${escapeText(words.explore.help)}</p>`,
		`<div><label for="explore-range">${escapeText(words.explore.days)}</label><select id="explore-range" name="range">${ranges}</select></div>`,
		text(
			"country",
			words.explore.country,
			explore.filters.country ?? "",
			words.explore.countryHelp,
			' maxlength="2" autocomplete="off"',
		),
		`<div><label for="explore-device">${escapeText(words.explore.device)}</label><select id="explore-device" name="device">${devices}</select></div>`,
		text(
			"source",
			words.explore.source,
			explore.filters.source ?? "",
			undefined,
			' maxlength="200" autocomplete="off"',
		),
		text(
			"page",
			words.explore.page,
			explore.filters.page?.path ?? "",
			words.explore.pageHelp,
			' maxlength="1000" autocomplete="off"',
		),
		"</fieldset>",
		`<div class="actions"><button type="submit">${escapeText(words.explore.apply)}</button><a href="?">${escapeText(words.explore.reset)}</a></div>`,
		"</form>",
	].join("");
}

function aiSummary(ai: ReportAiView, words: ReportWords): string {
	if (ai.status === "none") return "";
	if (ai.status !== "written")
		return `<div class="ai"><p class="ai-note">${escapeText(words.noAi[ai.status])}</p></div>`;
	const suggestions = ai.suggestions
		.map(
			(suggestion) =>
				`<li>${paragraphText(suggestion.text)}${suggestion.service ? `<br><span class="muted">${escapeText(fill(words.relatedService, { name: suggestion.service }))}</span>` : ""}</li>`,
		)
		.join("");
	return [
		'<div class="ai">',
		`<h2>${escapeText(words.whatHappened)}</h2>`,
		`<p>${paragraphText(ai.whatHappened)}</p>`,
		suggestions ? `<h2>${escapeText(words.suggestions)}</h2><ul>${suggestions}</ul>` : "",
		`<p class="ai-note">${escapeText(words.writtenByAi)}</p>`,
		"</div>",
	].join("");
}

/** Text written by a person or an AI: escaped, line breaks kept. Never HTML. */
function paragraphText(text: string): string {
	return escapeText(text).replace(/\r\n|\r|\n/g, "<br>");
}

function widgetSection(widget: ReportWidget, input: ReportPageInput, words: ReportWords): string {
	const { answer } = widget;
	const lang = input.language;
	const id = `w-${answer.widgetId.replace(/[^A-Za-z0-9_-]/g, "")}`;
	const wide = answer.data?.shape === "series" || answer.data?.shape === "table" ? " wide" : "";
	const parts = [
		`<section class="widget${wide}" aria-labelledby="${id}">`,
		`<h2 id="${id}">${escapeText(answer.title)}</h2>`,
	];
	// A Widget with its own days says them; one following the page's days says nothing more.
	const ownDays =
		!input.period ||
		answer.range.from.getTime() !== input.period.from.getTime() ||
		answer.range.to.getTime() !== input.period.to.getTime();
	if (ownDays && answer.data?.shape !== "note") {
		parts.push(`<p class="muted">${escapeText(periodText(answer.range.from, answer.range.to, lang))}</p>`);
	}
	if (answer.sites) parts.push(`<p class="muted">${escapeText(fill(words.sitesCounted, answer.sites))}</p>`);
	if (answer.countedFrom) {
		parts.push(
			`<p class="muted">${escapeText(fill(words.countedFrom, { day: dayText(answer.countedFrom, lang) }))}</p>`,
		);
	}
	if (!answer.data) {
		parts.push(`<p>${escapeText(fill(words.cantCount, { reason: answer.problem?.message ?? "" }))}</p>`);
	} else {
		parts.push(dataHtml(answer.data, comparable(widget), id, answer.title, words, lang));
	}
	if (widget.text) parts.push(`<p class="widget-text">${paragraphText(widget.text)}</p>`);
	parts.push("</section>");
	return parts.join("");
}

/** The answer for the period before, when it covers other days than this one (a Widget with its own days doesn't compare). */
function comparable(widget: ReportWidget): WidgetDataView | null {
	const { previous, answer } = widget;
	if (!previous?.data || previous.range.from.getTime() === answer.range.from.getTime()) return null;
	return previous.data;
}

function dataHtml(
	data: WidgetDataView,
	previous: WidgetDataView | null,
	id: string,
	title: string,
	words: ReportWords,
	lang: string,
): string {
	switch (data.shape) {
		case "note":
			return `<p class="note">${escapeText(data.text)}</p>`;
		case "number":
			return numbersHtml(data, previous?.shape === "number" ? previous : null, words, lang);
		case "series":
			return seriesHtml(data, id, title, words, lang);
		case "table":
			return tableHtml(data, id, words, lang);
		case "funnel":
			return funnelHtml(data, id, words, lang);
	}
}

function numbersHtml(
	data: Extract<WidgetDataView, { shape: "number" }>,
	previous: Extract<WidgetDataView, { shape: "number" }> | null,
	words: ReportWords,
	lang: string,
): string {
	const items = data.values.map((value) => {
		const shown =
			value.of === null
				? numberText(value.count, lang)
				: `${percentText(value.count, value.of, lang)}<span class="change">${escapeText(fill(words.rateOf, { count: numberText(value.count, lang), of: numberText(value.of, lang) }))}</span>`;
		const before = previous?.values.find((each) => each.key === value.key);
		return `<div><dt>${escapeText(value.label)}</dt><dd>${shown}${before && value.of === null ? changeHtml(value.count, before.count, words, lang) : ""}</dd></div>`;
	});
	return `<dl class="numbers">${items.join("")}</dl>`;
}

/** How a count changed on the period before, in words (never colour alone). */
function changeHtml(now: number, before: number, words: ReportWords, lang: string): string {
	if (now === before) return `<span class="change">${escapeText(words.change.same)}</span>`;
	if (before === 0) return `<span class="change up">${escapeText(words.change.new)}</span>`;
	const percent = percentText(Math.abs(now - before), before, lang);
	const up = now > before;
	const text = fill(up ? words.change.up : words.change.down, { percent, previous: numberText(before, lang) });
	return `<span class="change ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${escapeText(text)}</span>`;
}

function seriesHtml(
	data: Extract<WidgetDataView, { shape: "series" }>,
	id: string,
	title: string,
	words: ReportWords,
	lang: string,
): string {
	const width = 640;
	const height = 200;
	const pad = { top: 12, right: 12, bottom: 24, left: 48 };
	const points = data.points.map((point) => ({ start: new Date(point.start), values: point.values }));
	const lines = data.lines.slice(0, 4);
	const max = Math.max(1, ...points.flatMap((point) => lines.map((line) => point.values[line.key] ?? 0)));
	const hourly =
		points.length > 1 && (points[1]?.start.getTime() ?? 0) - (points[0]?.start.getTime() ?? 0) < 86_400_000;
	const stamp = (at: Date) =>
		hourly ? `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)}` : dayText(at, lang);
	const xOf = (index: number) =>
		pad.left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * (width - pad.left - pad.right));
	const yOf = (value: number) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
	const first = points[0];
	const last = points.at(-1);
	const summary = fill(words.seriesSummary, {
		lines: lines.map((line) => line.label).join(", "),
		interval: hourly ? words.hour : words.day,
		from: first ? stamp(first.start) : "",
		to: last ? stamp(last.start) : "",
		max: numberText(max, lang),
	});
	const paths = lines
		.map((line, index) => {
			const d = points
				.map(
					(point, at) => `${at === 0 ? "M" : "L"}${xOf(at).toFixed(1)} ${yOf(point.values[line.key] ?? 0).toFixed(1)}`,
				)
				.join(" ");
			const markers = points.map((point, at) => marker(index, xOf(at), yOf(point.values[line.key] ?? 0))).join("");
			return `<path class="line l${index}" d="${d}"/>${points.length <= 40 ? markers : ""}`;
		})
		.join("");
	const svg = [
		`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${id}-chart">`,
		`<title id="${id}-chart">${escapeText(`${title}. ${summary}`)}</title>`,
		`<line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"/>`,
		`<line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top}" y2="${pad.top}" stroke-dasharray="2 4"/>`,
		`<text class="label" x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end">${escapeText(numberText(max, lang))}</text>`,
		`<text class="label" x="${pad.left - 6}" y="${height - pad.bottom}" text-anchor="end">0</text>`,
		first ? `<text class="label" x="${pad.left}" y="${height - 6}">${escapeText(stamp(first.start))}</text>` : "",
		last && points.length > 1
			? `<text class="label" x="${width - pad.right}" y="${height - 6}" text-anchor="end">${escapeText(stamp(last.start))}</text>`
			: "",
		paths,
		"</svg>",
	].join("");
	const totals = lines
		.map((line) =>
			fill(words.seriesTotal, {
				label: line.label,
				total: numberText(
					points.reduce((sum, point) => sum + (point.values[line.key] ?? 0), 0),
					lang,
				),
			}),
		)
		.map((text) => `<p>${escapeText(text)}</p>`)
		.join("");
	const head = `<tr><th scope="col">${escapeText(hourly ? words.hourColumn : words.dayColumn)}</th>${lines.map((line) => `<th scope="col" class="n">${escapeText(line.label)}</th>`).join("")}</tr>`;
	const rows = points
		.map(
			(point) =>
				`<tr><th scope="row">${escapeText(stamp(point.start))}</th>${lines.map((line) => `<td class="n">${escapeText(numberText(point.values[line.key] ?? 0, lang))}</td>`).join("")}</tr>`,
		)
		.join("");
	// Which line is which, by its colour, dash and marker together (never colour alone).
	const legend = `<ul class="legend" aria-hidden="true">${lines
		.map(
			(line, index) =>
				`<li><svg viewBox="0 0 28 10" width="28" height="10" focusable="false"><path class="line l${index}" d="M1 5 L27 5"/>${marker(index, 14, 5)}</svg>${escapeText(line.label)}</li>`,
		)
		.join("")}</ul>`;
	return `${svg}${legend}${totals}<div class="scroll"><table aria-labelledby="${id}"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function marker(index: number, x: number, y: number): string {
	const at = (value: number) => value.toFixed(1);
	switch (index % 4) {
		case 1:
			return `<rect class="m1" x="${at(x - 3)}" y="${at(y - 3)}" width="6" height="6"/>`;
		case 2:
			return `<path class="m2" d="M${at(x)} ${at(y - 4)} L${at(x + 4)} ${at(y + 3)} L${at(x - 4)} ${at(y + 3)} Z"/>`;
		case 3:
			return `<path class="m3" d="M${at(x)} ${at(y - 4)} L${at(x + 4)} ${at(y)} L${at(x)} ${at(y + 4)} L${at(x - 4)} ${at(y)} Z"/>`;
		default:
			return `<circle class="m0" cx="${at(x)}" cy="${at(y)}" r="3"/>`;
	}
}

function tableHtml(
	data: Extract<WidgetDataView, { shape: "table" }>,
	id: string,
	words: ReportWords,
	lang: string,
): string {
	if (data.rows.length === 0) return `<p>${escapeText(words.noData)}</p>`;
	const numeric = (kind: WidgetColumnKind) => kind === "count" || kind === "rate";
	const head = data.columns
		.map((column) => `<th scope="col"${numeric(column.kind) ? ' class="n"' : ""}>${escapeText(column.label)}</th>`)
		.join("");
	const rows = data.rows
		.map((row) => {
			const cells = data.columns
				.map((column) => {
					const cell = row.cells[column.key];
					if (typeof cell === "object" && cell !== null) {
						return `<td class="n">${escapeText(`${percentText(cell.count, cell.of, lang)} (${fill(words.rateOf, { count: numberText(cell.count, lang), of: numberText(cell.of, lang) })})`)}</td>`;
					}
					if (typeof cell === "number") return `<td class="n">${escapeText(numberText(cell, lang))}</td>`;
					return `<td class="t">${escapeText(cellText(column.kind, cell ?? "", lang))}</td>`;
				})
				.join("");
			return `<tr>${cells}</tr>`;
		})
		.join("");
	return `<div class="scroll"><table aria-labelledby="${id}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** A text cell in words: a country by its name, an empty source as direct visits, a device by its name. */
function cellText(kind: WidgetColumnKind, value: string, lang: string): string {
	const words = cellWords(lang);
	if (kind === "source") return value === "" ? words.direct : value;
	if (kind === "country") {
		if (value === "") return words.unknown;
		try {
			return new Intl.DisplayNames([lang], { type: "region" }).of(value.toUpperCase()) ?? value;
		} catch {
			return value;
		}
	}
	if (kind === "device") {
		const devices = reportWords(lang).explore.devices;
		return devices[value as keyof typeof devices] ?? value;
	}
	return value;
}

function cellWords(lang: string): { direct: string; unknown: string } {
	return lang === "it" ? { direct: "Diretto", unknown: "Sconosciuto" } : { direct: "Direct", unknown: "Unknown" };
}

function funnelHtml(
	data: Extract<WidgetDataView, { shape: "funnel" }>,
	id: string,
	words: ReportWords,
	lang: string,
): string {
	const first = data.steps[0]?.count ?? 0;
	const rows = data.steps
		.map(
			(step, index) =>
				`<tr><th scope="row">${index + 1}. ${escapeText(step.label)}</th><td class="n">${escapeText(numberText(step.count, lang))}</td><td class="n">${escapeText(percentText(step.count, first, lang))}</td></tr>`,
		)
		.join("");
	return `<div class="scroll"><table aria-labelledby="${id}"><thead><tr><th scope="col">${escapeText(words.step)}</th><th scope="col" class="n">${escapeText(words.count)}</th><th scope="col" class="n">%</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** A small page in the same styles: the Share link's password form, or why a link doesn't work. */
function plainPage(language: string, title: string, body: string): string {
	const words = reportWords(language);
	return [
		"<!doctype html>",
		`<html lang="${escapeAttribute(language)}" dir="ltr">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex, nofollow">',
		'<meta name="referrer" content="no-referrer">',
		'<meta name="color-scheme" content="light dark">',
		`<title>${escapeText(title)}</title>`,
		`<style>${STYLES}</style>`,
		"</head>",
		"<body>",
		`<a class="skip" href="#main">${escapeText(words.skipLink)}</a>`,
		'<div class="wrap">',
		`<main id="main" tabindex="-1" class="narrow">${body}</main>`,
		"</div>",
		"</body>",
		"</html>",
	].join("\n");
}

/**
 * The page a Share link with a password shows until the password is given: a form posting to the
 * link itself. It names nothing of the Dashboard, its Site or its brand.
 */
export function sharePasswordPage(input: { language: string; problem?: "wrong" | "tooMany" }): string {
	const words = reportWords(input.language).password;
	const problem = input.problem === "wrong" ? words.wrong : input.problem === "tooMany" ? words.tooMany : null;
	const title = `${problem ? `${words.errorPrefix} ` : ""}${words.title}`;
	return plainPage(
		input.language,
		title,
		[
			`<h1>${escapeText(words.title)}</h1>`,
			`<p id="password-help">${escapeText(words.help)}</p>`,
			'<form method="post" class="explore" novalidate>',
			problem ? `<p class="problem" id="password-problem" role="alert">${escapeText(problem)}</p>` : "",
			`<label for="password">${escapeText(words.label)}</label>`,
			`<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200" aria-describedby="${problem ? "password-problem password-help" : "password-help"}"${problem ? ' aria-invalid="true" autofocus' : ""}>`,
			`<div class="actions"><button type="submit">${escapeText(words.submit)}</button></div>`,
			"</form>",
		].join(""),
	);
}

/** What a Share link that doesn't work (unknown, revoked or expired, alike) shows. */
export function shareGonePage(language: string): string {
	const words = reportWords(language).gone;
	return plainPage(language, words.title, `<h1>${escapeText(words.title)}</h1><p>${escapeText(words.help)}</p>`);
}
