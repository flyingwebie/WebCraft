/**
 * What a Report is made of (#104, GLOSSARY.md): its schedule, the period each one covers and the one
 * it is compared with, its recipients and its language. Pure rules, shared by the service, its jobs
 * and the procedures.
 */
import { ADMIN_LANGUAGE_CODES, type AdminLanguageCode, isAdminLanguage } from "../admin-languages.ts";
import type { DashboardRange } from "../dashboards/model.ts";

/** How often a Report goes out: every Monday for the week before, or on the 1st for the month before. */
export const REPORT_SCHEDULES = ["weekly", "monthly"] as const;
export type ReportSchedule = (typeof REPORT_SCHEDULES)[number];

/** The languages a Report (and a Share link's page) can be in: those WebCraft has its words in. */
export const REPORT_LANGUAGES = ADMIN_LANGUAGE_CODES;
export type ReportLanguage = AdminLanguageCode;

export function isReportLanguage(value: string): value is ReportLanguage {
	return isAdminLanguage(value);
}

/** The hour (UTC) Reports go out at, on their day: early, so they wait in the morning's mail. */
export const REPORT_SEND_HOUR_UTC = 6;

/** How many recipients one Report has at most, and how many Reports one Dashboard. */
export const MAX_RECIPIENTS = 20;
export const MAX_REPORTS_PER_DASHBOARD = 10;

/** How long a Report's history (and its PDFs) is kept. */
export const REPORT_HISTORY_DAYS = 400;

/** How many times rendering a Report's PDF is tried before it is recorded as failed. */
export const RENDER_ATTEMPTS = 3;

/** The longest AI text kept for one Widget, for "What happened", and for one suggestion, in characters. */
export const AI_TEXT_LIMITS = { widget: 600, whatHappened: 1500, suggestion: 400, suggestions: 5 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(at: Date): number {
	return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/** The Monday a day falls in (UTC days, weeks from Monday). */
function mondayOf(day: number): number {
	const weekday = (new Date(day).getUTCDay() + 6) % 7;
	return day - weekday * DAY_MS;
}

/** When a Report on `schedule` goes out next after `now`: the next Monday (or 1st) at 06:00 UTC. */
export function nextRunAfter(schedule: ReportSchedule, now: Date): Date {
	const hour = REPORT_SEND_HOUR_UTC * 60 * 60 * 1000;
	if (schedule === "weekly") {
		let next = mondayOf(startOfDay(now)) + hour;
		while (next <= now.getTime()) next += 7 * DAY_MS;
		return new Date(next);
	}
	let month = 0;
	let next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) + hour;
	while (next <= now.getTime()) next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ++month, 1) + hour;
	return new Date(next);
}

/** A Report's period and the one it is compared with: whole UTC days, `to` the first instant after. */
export type ReportPeriod = { from: Date; to: Date; previousFrom: Date; previousTo: Date };

/**
 * The last whole period before `at`: the week (Monday to Sunday) or the calendar month that ended
 * last, and the one before it. A Report going out on Monday covers the week that ended on Sunday.
 */
export function periodBefore(schedule: ReportSchedule, at: Date): ReportPeriod {
	if (schedule === "weekly") {
		const to = mondayOf(startOfDay(at));
		return {
			from: new Date(to - 7 * DAY_MS),
			to: new Date(to),
			previousFrom: new Date(to - 14 * DAY_MS),
			previousTo: new Date(to - 7 * DAY_MS),
		};
	}
	const month = (offset: number) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));
	return { from: month(-1), to: month(0), previousFrom: month(-2), previousTo: month(-1) };
}

/** A period as a Dashboard range: its days, both counted. */
export function rangeOf(from: Date, to: Date): DashboardRange {
	return {
		preset: "custom",
		from: from.toISOString().slice(0, 10),
		to: new Date(to.getTime() - DAY_MS).toISOString().slice(0, 10),
	};
}

/** The period of the same length just before a range's days. */
export function previousOf(range: { from: Date; to: Date }): { from: Date; to: Date } {
	const length = range.to.getTime() - range.from.getTime();
	return { from: new Date(range.from.getTime() - length), to: new Date(range.from.getTime()) };
}
