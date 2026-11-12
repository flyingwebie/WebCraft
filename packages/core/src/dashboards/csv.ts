/**
 * Widgets as CSV files for spreadsheets: UTF-8 with a byte order mark (so spreadsheet programs read
 * accents right), every cell quoted, rows ended with CRLF. A cell that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return would run as a formula when opened, so it gets a `'` in front and
 * stays text: a page path, a source or a Goal's name can never become a formula in someone's
 * spreadsheet. A Dashboard's file holds each Widget in turn, headed by its title.
 */
import type { WidgetAnswerView } from "./views.ts";

const BOM = "﻿";

/**
 * Characters that start a formula in spreadsheet programs, their full-width forms too (＝ ＋ － ＠),
 * which programs reading East Asian text take the same way.
 */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

/** A cell, quoted, its quotes doubled, a formula's start made text. */
export function csvCell(value: string | number): string {
	const text = String(value);
	const safe = FORMULA_START.test(text) ? `'${text}` : text;
	return `"${safe.replace(/"/g, '""')}"`;
}

type Words = {
	dashboard: string;
	range: string;
	measure: string;
	count: string;
	outOf: string;
	rate: string;
	start: string;
	step: string;
	visitors: string;
	ofFirst: string;
	dropped: string;
	note: string;
	direct: string;
	unknown: string;
	notCounted: string;
	countedFrom: string;
	sites: string;
	devices: Record<string, string>;
};

const WORDS: Record<"en" | "it", Words> = {
	en: {
		dashboard: "Dashboard",
		range: "Range (UTC)",
		measure: "Measure",
		count: "Count",
		outOf: "Out of",
		rate: "Rate",
		start: "Start (UTC)",
		step: "Step",
		visitors: "Visitors",
		ofFirst: "Of the first step",
		dropped: "Left since the step before",
		note: "Note",
		direct: "Direct",
		unknown: "Unknown",
		notCounted: "Not counted",
		countedFrom: "Counted from",
		sites: "Sites counted",
		devices: { desktop: "Computer", mobile: "Phone", tablet: "Tablet" },
	},
	it: {
		dashboard: "Dashboard",
		range: "Periodo (UTC)",
		measure: "Misura",
		count: "Numero",
		outOf: "Su",
		rate: "Tasso",
		start: "Inizio (UTC)",
		step: "Passo",
		visitors: "Visitatori",
		ofFirst: "Del primo passo",
		dropped: "Usciti dal passo precedente",
		note: "Nota",
		direct: "Diretto",
		unknown: "Sconosciuto",
		notCounted: "Non conteggiato",
		countedFrom: "Conteggiato dal",
		sites: "Siti conteggiati",
		devices: { desktop: "Computer", mobile: "Telefono", tablet: "Tablet" },
	},
};

function wordsFor(language: string): Words {
	return language === "it" ? WORDS.it : WORDS.en;
}

/** A share as a percentage with one decimal, or empty when there is nothing to share. */
function percent(count: number, of: number): string {
	return of > 0 ? `${((count / of) * 100).toFixed(1)}%` : "";
}

const time = (at: Date) => at.toISOString().slice(0, 16).replace("T", " ");
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The days a range covers, both counted: `2026-03-01 – 2026-03-30`. */
export function rangeText(range: { from: Date; to: Date }): string {
	const last = new Date(range.to.getTime() - 1);
	return `${dayOf(range.from)} – ${dayOf(last)}`;
}

/** One Widget's lines: its title, its range, then its table. */
function widgetLines(answer: WidgetAnswerView, language: string): (string | number)[][] {
	const words = wordsFor(language);
	const lines: (string | number)[][] = [[answer.title], [words.range, rangeText(answer.range)]];
	if (answer.sites) lines.push([words.sites, `${answer.sites.counted} / ${answer.sites.of}`]);
	if (answer.countedFrom) lines.push([words.countedFrom, dayOf(answer.countedFrom)]);
	const { data } = answer;
	if (!data) {
		lines.push([words.notCounted, answer.problem?.message ?? ""]);
		return lines;
	}
	switch (data.shape) {
		case "note":
			lines.push([words.note], [data.text]);
			break;
		case "number":
			lines.push([words.measure, words.count, words.outOf, words.rate]);
			for (const value of data.values) {
				lines.push(
					value.of === null
						? [value.label, value.count, "", ""]
						: [value.label, value.count, value.of, percent(value.count, value.of)],
				);
			}
			break;
		case "series":
			lines.push([words.start, ...data.lines.map((line) => line.label)]);
			for (const point of data.points) {
				lines.push([time(point.start), ...data.lines.map((line) => point.values[line.key] ?? 0)]);
			}
			break;
		case "table": {
			lines.push(data.columns.map((column) => column.label));
			const regions = regionNames(language);
			for (const row of data.rows) {
				lines.push(
					data.columns.map((column) => {
						const cell = row.cells[column.key];
						if (typeof cell === "object" && cell !== null) return percent(cell.count, cell.of);
						if (cell === undefined) return "";
						if (typeof cell === "number") return cell;
						if (column.kind === "source") return cell === "" ? words.direct : cell;
						if (column.kind === "country") return cell === "" ? words.unknown : `${regions(cell)} (${cell})`;
						if (column.kind === "device") return words.devices[cell] ?? cell;
						return cell;
					}),
				);
			}
			break;
		}
		case "funnel": {
			lines.push([words.step, words.visitors, words.ofFirst, words.dropped]);
			const first = data.steps[0]?.count ?? 0;
			data.steps.forEach((step, index) => {
				const before = index === 0 ? null : (data.steps[index - 1]?.count ?? 0);
				lines.push([
					step.label,
					step.count,
					percent(step.count, first),
					before === null ? "" : percent(before - step.count, before),
				]);
			});
			break;
		}
	}
	return lines;
}

/** A country's name in a language, from its code (the code itself where the runtime doesn't know it). */
function regionNames(language: string): (code: string) => string {
	try {
		const names = new Intl.DisplayNames([language, "en"], { type: "region" });
		return (code) => names.of(code) ?? code;
	} catch {
		return (code) => code;
	}
}

function file(lines: readonly (readonly (string | number)[])[]): string {
	return `${BOM}${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** One Widget's file. */
export function widgetCsv(answer: WidgetAnswerView, language: string): string {
	return file(widgetLines(answer, language));
}

/** A Dashboard's file: its name, then each Widget in turn, an empty line between them. */
export function dashboardCsv(name: string, answers: readonly WidgetAnswerView[], language: string): string {
	const lines: (string | number)[][] = [[wordsFor(language).dashboard, name]];
	for (const answer of answers) lines.push([], ...widgetLines(answer, language));
	return file(lines);
}

/** A file name from a name: lower-case words joined by dashes, with the day. */
export function csvFilename(name: string, day: Date): string {
	const base =
		name
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "dashboard";
	return `${base}-${dayOf(day)}.csv`;
}
