import { AiProviderError } from "../ai/providers.ts";
import type { WidgetAnswerView, WidgetDataView } from "../dashboards/views.ts";
import { AI_TEXT_LIMITS } from "./model.ts";
import type { Service } from "./services-list.ts";

/**
 * A Report's AI text (#104): what is sent to the AI provider, and what is kept of its answer. Only
 * totals are sent: each Widget's counts (a table's biggest rows, a series' sums, a funnel's steps)
 * for the period and the one before. Never a note's words, never anything about one visitor. The
 * answer is untrusted text: read as JSON, cut to its limits, stripped of control characters, and
 * shown escaped, never as HTML.
 */

/** The AI text kept with a Report: per Widget, what happened, and suggestions (a service by id, or none). */
export type ReportAiText = {
	widgets: Record<string, string>;
	whatHappened: string;
	suggestions: { text: string; service: string | null }[];
};

/** How many of a table's rows are sent. */
const TABLE_ROWS_SENT = 5;

/** The facts of a Report, as JSON for the provider: its place, its days, and each Widget's totals. */
export function reportFacts(input: {
	place: string;
	period: { from: Date; to: Date };
	compared: { from: Date; to: Date };
	widgets: readonly { answer: WidgetAnswerView; previous: WidgetAnswerView | null }[];
}): { json: string; widgetIds: string[] } {
	const day = (at: Date) => at.toISOString().slice(0, 10);
	const last = (to: Date) => day(new Date(to.getTime() - 86_400_000));
	const widgets = input.widgets.flatMap(({ answer, previous }) => {
		if (!answer.data || answer.data.shape === "note") return [];
		const before =
			previous?.data && previous.range.from.getTime() !== answer.range.from.getTime() ? previous.data : null;
		return [
			{
				id: answer.widgetId,
				title: answer.title,
				days: `${day(answer.range.from)} to ${last(answer.range.to)}`,
				counts: totalsOf(answer.data),
				...(before ? { countsBefore: totalsOf(before) } : {}),
			},
		];
	});
	return {
		json: JSON.stringify({
			place: input.place,
			period: `${day(input.period.from)} to ${last(input.period.to)}`,
			periodBefore: `${day(input.compared.from)} to ${last(input.compared.to)}`,
			widgets,
		}),
		widgetIds: widgets.map((widget) => widget.id),
	};
}

/** A Widget's totals, by label. */
function totalsOf(data: WidgetDataView): Record<string, number | string> {
	switch (data.shape) {
		case "note":
			return {};
		case "number":
			return Object.fromEntries(
				data.values.map((value) => [value.label, value.of === null ? value.count : `${value.count} of ${value.of}`]),
			);
		case "series":
			return Object.fromEntries(
				data.lines.map((line) => [
					`${line.label} (sum)`,
					data.points.reduce((sum, point) => sum + (point.values[line.key] ?? 0), 0),
				]),
			);
		case "table": {
			const label = data.columns.find((column) => column.kind !== "count" && column.kind !== "rate");
			const count = data.columns.find((column) => column.kind === "count");
			return Object.fromEntries(
				data.rows.slice(0, TABLE_ROWS_SENT).map((row) => {
					const cell = count ? row.cells[count.key] : undefined;
					return [String((label ? row.cells[label.key] : row.key) || "(none)"), typeof cell === "number" ? cell : 0];
				}),
			);
		}
		case "funnel":
			return Object.fromEntries(data.steps.map((step, index) => [`${index + 1}. ${step.label}`, step.count]));
	}
}

/** The most output tokens a Report's text may take: generous for a few paragraphs. */
export const REPORT_TEXT_OUTPUT_TOKENS = 2000;

/** Reads a provider's answer: a JSON object, kept within its limits; anything else is the provider's fault. */
export function readReportText(text: string, widgetIds: readonly string[], services: readonly Service[]): ReportAiText {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	let parsed: unknown;
	try {
		parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined;
	} catch {
		parsed = undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new AiProviderError("answer", "The AI provider didn't answer a Report's text.");
	}
	const answer = parsed as Record<string, unknown>;
	const whatHappened = plain(answer.whatHappened, AI_TEXT_LIMITS.whatHappened);
	if (!whatHappened) throw new AiProviderError("answer", "The AI provider didn't say what happened.");
	const widgets: Record<string, string> = {};
	const given = answer.widgets && typeof answer.widgets === "object" ? (answer.widgets as Record<string, unknown>) : {};
	for (const id of widgetIds) {
		const said = plain(given[id], AI_TEXT_LIMITS.widget);
		if (said) widgets[id] = said;
	}
	const known = new Set(services.map((service) => service.id));
	const suggestions = (Array.isArray(answer.suggestions) ? answer.suggestions : [])
		.flatMap((each) => {
			const item: Record<string, unknown> =
				each && typeof each === "object" ? (each as Record<string, unknown>) : { text: each };
			const said = plain(item.text, AI_TEXT_LIMITS.suggestion);
			if (!said) return [];
			const service = typeof item.service === "string" && known.has(item.service) ? item.service : null;
			return [{ text: said, service }];
		})
		.slice(0, AI_TEXT_LIMITS.suggestions);
	return { widgets, whatHappened, suggestions };
}

/**
 * Text fit to show as it is: a string, without control characters (line breaks kept, at most two in a
 * row), trimmed, cut at `max` characters on a word. Anything else is nothing.
 */
export function plain(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const cleaned = value
		.replace(/\r\n?/g, "\n")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if ([...cleaned].length <= max) return cleaned;
	const cut = [...cleaned].slice(0, max).join("");
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
