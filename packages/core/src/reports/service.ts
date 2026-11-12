import type { Database } from "@webcraft/db";
import { dashboards, emailLog, reportSends, reports, sites, workspaceDashboards } from "@webcraft/db/schema";
import { and, desc, eq, inArray, isNull, lt, lte, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { ADMIN_LANGUAGES } from "../admin-languages.ts";
import { AiCapReachedError } from "../ai/errors.ts";
import type { AiKeys } from "../ai/keys.ts";
import { AiKeyMissingError, AiProviderError, type AiProviders } from "../ai/providers.ts";
import type { Clock } from "../clock.ts";
import { DashboardNotFoundError } from "../dashboards/errors.ts";
import type { Dashboards } from "../dashboards/index.ts";
import type { DashboardPlace, WidgetAnswerView } from "../dashboards/views.ts";
import type { Email, EmailAttachment, EmailAttachmentRef } from "../email/index.ts";
import { mailAddress } from "../email/site-mail.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import type { People } from "../people.ts";
import { actingPerson, can, personIdOf } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import { assertSensitiveActionAllowed } from "../permissions/sensitive.ts";
import type {
	Access,
	BackgroundScope,
	BackgroundWorkspaceScope,
	DataLayer,
	SiteScope,
	WorkspaceScope,
} from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { siteStaff } from "../tenancy/site-owners.ts";
import { plain, REPORT_TEXT_OUTPUT_TOKENS, type ReportAiText, readReportText, reportFacts } from "./ai.ts";
import { resolveBrand } from "./branding.ts";
import { ReportInvalidError, ReportNotFoundError, ReportSendNotFoundError, ReportSendRefusedError } from "./errors.ts";
import {
	AI_TEXT_LIMITS,
	isReportLanguage,
	MAX_RECIPIENTS,
	MAX_REPORTS_PER_DASHBOARD,
	nextRunAfter,
	periodBefore,
	RENDER_ATTEMPTS,
	REPORT_HISTORY_DAYS,
	type ReportSchedule,
	rangeOf,
} from "./model.ts";
import { type ReportAiView, type ReportWidget, reportPage } from "./page.ts";
import { PDF_LIMITS, PdfRenderError, type PdfRenderer } from "./pdf.ts";
import { servicesList } from "./services-list.ts";
import { fill, periodText, reportWords } from "./words.ts";

/** A Report, as the admin shows it. */
export type ReportView = {
	id: string;
	dashboardId: string;
	name: string;
	schedule: ReportSchedule;
	language: string;
	recipients: string[];
	/** Whether each one waits for its AI text to be reviewed before it goes out. */
	review: boolean;
	active: boolean;
	/** When it goes out next; null while it is off. */
	nextRunAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

/** What setting up a Report gives. */
export type ReportInput = {
	name: string;
	schedule: ReportSchedule;
	language: string;
	recipients: readonly string[];
	review: boolean;
	active: boolean;
};

/** Where an email of a Report stands, from the Email log. */
export type ReportRecipientStatus = {
	address: string;
	/** `queued`, `retrying`, `sent`, `failed`, `logged` (no SMTP yet), or null before it was queued. */
	status: string | null;
	/** The mail server's last answer. */
	response: string | null;
};

/** One entry of a Report's history. */
export type ReportSendView = {
	id: string;
	reportId: string;
	kind: "scheduled" | "test";
	status: "preparing" | "review" | "rendering" | "sent" | "failed" | "discarded";
	period: { from: Date; to: Date };
	compared: { from: Date; to: Date };
	language: string;
	recipients: ReportRecipientStatus[];
	/** Whether its AI text is in it, or why not. */
	ai: "written" | "noKey" | "cap" | "failed" | "none" | null;
	problem: string | null;
	pdf: { bytes: number } | null;
	createdAt: Date;
	sentAt: Date | null;
	approvedAt: Date | null;
};

/** An entry of the history with what it shows: its Widgets' titles and its AI text, for review. */
export type ReportSendDetail = ReportSendView & {
	widgets: { id: string; title: string }[];
	text: ReportAiText | null;
	services: { id: string; name: string }[];
};

/** What a Report's history keeps of what it shows (`report_sends.content`). */
type Content = {
	name: string;
	placeName: string;
	widgets: { answer: WidgetAnswerView; previous: WidgetAnswerView | null }[];
	ai: ReportAiText | null;
};

/** The job payload naming one entry of a Report's history, in its Workspace (and Site). */
export type ReportSendRef = { sendId: string; workspaceId: string; siteId: string | null };

export type Reports = {
	list(access: Access, place: DashboardPlace, dashboardId: string): Promise<ReportView[]>;
	create(access: Access, place: DashboardPlace, dashboardId: string, input: ReportInput): Promise<ReportView>;
	update(access: Access, place: DashboardPlace, reportId: string, input: Partial<ReportInput>): Promise<ReportView>;
	/** Changes who a Report goes to (Content: Owners may). */
	setRecipients(
		access: Access,
		place: DashboardPlace,
		reportId: string,
		recipients: readonly string[],
	): Promise<ReportView>;
	delete(access: Access, place: DashboardPlace, reportId: string): Promise<void>;
	/** Makes a Report now for the last whole period and sends it to the person alone (never held for review). */
	sendTest(access: Access, place: DashboardPlace, reportId: string): Promise<ReportSendView>;
	history(
		access: Access,
		place: DashboardPlace,
		reportId: string,
		options: { limit?: number; before?: Date },
	): Promise<ReportSendView[]>;
	send(access: Access, place: DashboardPlace, sendId: string): Promise<ReportSendDetail>;
	/** A history entry's PDF, base64. */
	pdf(
		access: Access,
		place: DashboardPlace,
		sendId: string,
	): Promise<{ filename: string; contentType: string; base64: string }>;
	/** Changes the AI text of one waiting for review. */
	editText(access: Access, place: DashboardPlace, sendId: string, text: ReportAiText): Promise<ReportSendDetail>;
	/** Sends one waiting for review, with its AI text as it is now. */
	approve(access: Access, place: DashboardPlace, sendId: string): Promise<ReportSendView>;
	/** Drops one waiting for review: it never goes out. */
	discard(access: Access, place: DashboardPlace, sendId: string): Promise<ReportSendView>;
	/** Sends one again: its PDF to the Report's recipients now (a test: to its person), or makes its PDF again when it failed. */
	resend(access: Access, place: DashboardPlace, sendId: string): Promise<ReportSendView>;
	/** The worker: starts every Report whose time came. Answers how many. */
	runDue(): Promise<number>;
	/** The worker: works out what a Report shows and writes its AI text. */
	prepare(ref: ReportSendRef): Promise<void>;
	/** The worker: makes a Report's PDF and emails it. */
	render(ref: ReportSendRef): Promise<void>;
	/** The worker: deletes history older than `REPORT_HISTORY_DAYS`. Answers how many. */
	purge(): Promise<number>;
	/** Reads a Report's PDF for an email that names it, when it is sent. */
	attachment(ref: EmailAttachmentRef): Promise<EmailAttachment | null>;
};

export type ReportsDeps = {
	database: Database;
	data: DataLayer;
	dashboards: Dashboards;
	aiKeys: AiKeys;
	ai: AiProviders;
	email: Email;
	jobs: JobQueue;
	clock: Clock;
	log: Logger;
	people: People;
	pdf: PdfRenderer;
	/** The jobs the service queues (defined beside it, in `jobs.ts`). */
	queue: { prepare(ref: ReportSendRef): Promise<void>; render(ref: ReportSendRef, startAfter?: Date): Promise<void> };
};

/**
 * A Dashboard's place (its Site, or its Workspace: every Site of it), opened for a person with the
 * Permission it needs. A procedure that must check the Permission before a Sensitive action's gate
 * (`onPlace` in `packages/api/src/procedures/reports.ts`) opens it once and keeps it on the context,
 * the way `onSite`/`onWorkspace` keep `context.site`/`context.workspace`, instead of a service
 * opening the same place with the same Permission again.
 */
export type OpenedDashboardPlace = { level: "site"; scope: SiteScope } | { level: "workspace"; scope: WorkspaceScope };

type Opened = OpenedDashboardPlace;

/**
 * The opened place's queries, typed once for the tables Reports use: each names its Site (null in a
 * Workspace Dashboard's), so a Site scope and a Workspace scope run the same calls (with `inPlace`).
 */
export function scoped(opened: Opened): SiteScope {
	return opened.scope as unknown as SiteScope;
}

/** A place opened for the worker. */
type Background = BackgroundScope | BackgroundWorkspaceScope;

type ReportRow = typeof reports.$inferSelect;
type SendRow = typeof reportSends.$inferSelect;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Opens a Dashboard's place for a person with a Permission. A Workspace Dashboard's Reports and Share
 * links add up every Site of its Workspace, so only someone who sees each of them opens them.
 */
export async function openPlace(
	data: DataLayer,
	access: Access,
	place: DashboardPlace,
	permission: Permission,
): Promise<Opened> {
	if ("siteId" in place) return { level: "site", scope: await data.site(access, place.siteId, permission) };
	const scope = await data.workspace(access, place.workspaceId, permission);
	const all = await scope.select(sites);
	const seesAll = all.every((site) =>
		can(access.actor, "site.view", { level: "site", workspaceId: site.workspaceId, siteId: site.id }),
	);
	if (!seesAll) throw new PermissionDeniedError(permission);
	return { level: "workspace", scope };
}

/** A scope's condition for a table naming its Site: a Workspace scope reads its Workspace Dashboards' only. */
export function inPlace(level: "site" | "workspace", table: { siteId: AnyPgColumn }, extra?: SQL): SQL | undefined {
	if (level === "site") return extra;
	return extra ? (and(isNull(table.siteId), extra) as SQL) : isNull(table.siteId);
}

/** Whether a Dashboard is in the opened place; throws `DashboardNotFoundError` when not. */
export async function requireDashboard(opened: Opened, dashboardId: string): Promise<void> {
	const found =
		opened.level === "site"
			? await scoped(opened).first(dashboards, eq(dashboards.id, dashboardId))
			: await (opened.scope as WorkspaceScope).first(workspaceDashboards, eq(workspaceDashboards.id, dashboardId));
	if (!found) throw new DashboardNotFoundError();
}

function checkedName(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "" || trimmed.length > 100)
		throw new ReportInvalidError("name", "A Report's name has 1 to 100 characters.");
	return trimmed;
}

function checkedRecipients(recipients: readonly string[]): string[] {
	const found: string[] = [];
	for (const each of recipients) {
		if (each.trim() === "") continue;
		const address = mailAddress(each.trim());
		if (!address) throw new ReportInvalidError("recipients", `${each.trim().slice(0, 254)} isn't an email address.`);
		if (!found.includes(address)) found.push(address);
	}
	if (found.length > MAX_RECIPIENTS) {
		throw new ReportInvalidError("recipients", `A Report goes to at most ${MAX_RECIPIENTS} recipients.`);
	}
	return found;
}

/**
 * Changing who receives a Report is a Sensitive action (`reportRecipients.change`): it sends a
 * Dashboard's figures to an email address. Checked where recipients are written (making a Report,
 * `update`, `setRecipients`), so every other Report change stays available to API clients. The same
 * addresses again change nothing. Call it after the Permission check.
 */
function assertRecipientsChangeAllowed(access: Access, before: readonly string[], after: readonly string[], now: Date) {
	const had = new Set(before);
	if (after.length === had.size && after.every((address) => had.has(address))) return;
	assertSensitiveActionAllowed(access, "reportRecipients.change", now);
}

function checkedLanguage(language: string): string {
	if (!isReportLanguage(language)) {
		throw new ReportInvalidError(
			"language",
			`A Report is in ${ADMIN_LANGUAGES.map((each) => each.code).join(" or ")}.`,
		);
	}
	return language;
}

function recipientsOf(json: unknown): string[] {
	return Array.isArray(json) ? json.filter((each): each is string => typeof each === "string") : [];
}

function viewOf(row: ReportRow): ReportView {
	return {
		id: row.id,
		dashboardId: (row.dashboardId ?? row.workspaceDashboardId) as string,
		name: row.name,
		schedule: row.schedule as ReportSchedule,
		language: row.language,
		recipients: recipientsOf(row.recipients),
		review: row.review,
		active: row.active,
		nextRunAt: row.active ? row.nextRunAt : null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** A Widget's answer read back from JSON: its times as dates again. */
function answerFrom(json: unknown): WidgetAnswerView | null {
	if (!json || typeof json !== "object") return null;
	const answer = json as WidgetAnswerView & { range: { from: string; to: string } };
	const date = (value: unknown) => new Date(value as string);
	const data = answer.data;
	return {
		...answer,
		range: { ...answer.range, from: date(answer.range.from), to: date(answer.range.to) },
		countedFrom: answer.countedFrom ? date(answer.countedFrom) : null,
		data:
			data?.shape === "series"
				? { ...data, points: data.points.map((point) => ({ ...point, start: date(point.start) })) }
				: data,
	};
}

function contentOf(json: unknown): Content | null {
	if (!json || typeof json !== "object") return null;
	const content = json as Content;
	return {
		name: content.name,
		placeName: content.placeName,
		widgets: (content.widgets ?? []).flatMap((widget) => {
			const answer = answerFrom(widget.answer);
			return answer ? [{ answer, previous: answerFrom(widget.previous) }] : [];
		}),
		ai: content.ai ?? null,
	};
}

/** A file name for a Report's PDF: its name and days, in letters and digits. */
function pdfName(name: string, from: Date, to: Date): string {
	const base =
		name
			.normalize("NFKD")
			.replace(/[^\w\s-]/g, "")
			.trim()
			.replace(/[\s_]+/g, "-")
			.toLowerCase()
			.slice(0, 60) || "report";
	const last = new Date(to.getTime() - DAY_MS);
	return `${base}-${from.toISOString().slice(0, 10)}-${last.toISOString().slice(0, 10)}.pdf`;
}

/** An entry's view, with each recipient's email as the Email log has it. */
async function sendViews(database: Database, rows: readonly SendRow[]): Promise<ReportSendView[]> {
	const ids = rows.map((row) => row.id);
	const lines =
		ids.length === 0
			? []
			: await database.db
					.select({
						relatedId: emailLog.relatedId,
						recipient: emailLog.recipient,
						status: emailLog.status,
						lastResponse: emailLog.lastResponse,
						createdAt: emailLog.createdAt,
					})
					.from(emailLog)
					.where(and(eq(emailLog.relatedKind, "reportSend"), inArray(emailLog.relatedId, ids)))
					.orderBy(desc(emailLog.createdAt));
	return rows.map((row) => {
		const mine = lines.filter((line) => line.relatedId === row.id);
		return {
			id: row.id,
			reportId: row.reportId,
			kind: row.kind as ReportSendView["kind"],
			status: row.status as ReportSendView["status"],
			period: { from: row.periodFrom, to: row.periodTo },
			compared: { from: row.previousFrom, to: row.previousTo },
			language: row.language,
			recipients: recipientsOf(row.recipients).map((address) => {
				// The newest email to the address: a resend's, after the first one.
				const line = mine.find((each) => each.recipient === address);
				return { address, status: line?.status ?? null, response: line?.lastResponse ?? null };
			}),
			ai: (row.aiStatus as ReportSendView["ai"]) ?? null,
			problem: row.problem,
			pdf: row.pdfBytes !== null && row.pdf ? { bytes: row.pdfBytes } : null,
			createdAt: row.createdAt,
			sentAt: row.sentAt,
			approvedAt: row.approvedAt,
		};
	});
}

export function createReports(deps: ReportsDeps): Reports {
	const { database, data, clock, log } = deps;

	const reportOf = async (opened: Opened, reportId: string): Promise<ReportRow> => {
		const row = await scoped(opened).first(reports, inPlace(opened.level, reports, eq(reports.id, reportId)));
		if (!row) throw new ReportNotFoundError();
		return row;
	};

	const sendOf = async (opened: Opened, sendId: string): Promise<SendRow> => {
		const row = await scoped(opened).first(reportSends, inPlace(opened.level, reportSends, eq(reportSends.id, sendId)));
		if (!row) throw new ReportSendNotFoundError();
		return row;
	};

	const refOf = (row: { id: string; workspaceId: string; siteId: string | null }): ReportSendRef => ({
		sendId: row.id,
		workspaceId: row.workspaceId,
		siteId: row.siteId,
	});

	const background = async (ref: { workspaceId: string; siteId: string | null }): Promise<Background | null> => {
		if (ref.siteId) {
			const scope = await data.background(ref.siteId);
			return scope && scope.workspace.id === ref.workspaceId ? scope : null;
		}
		return data.backgroundWorkspace(ref.workspaceId);
	};

	const levelOf = (scope: Background) => (scope.level === "background" ? "site" : "workspace");

	const backgroundSend = async (scope: Background, sendId: string): Promise<SendRow | undefined> =>
		(scope as BackgroundScope).first(reportSends, inPlace(levelOf(scope), reportSends, eq(reportSends.id, sendId)));

	const detailOf = async (row: SendRow): Promise<ReportSendDetail> => {
		const [view] = await sendViews(database, [row]);
		const content = contentOf(row.content);
		const services = await servicesList(database.db);
		return {
			...(view as ReportSendView),
			widgets: (content?.widgets ?? [])
				.filter((widget) => widget.answer.data && widget.answer.data.shape !== "note")
				.map((widget) => ({ id: widget.answer.widgetId, title: widget.answer.title })),
			text: content?.ai ?? null,
			services: services.map((service) => ({ id: service.id, name: service.name })),
		};
	};

	/** A new entry in the history, made for the worker to prepare. */
	const startSend = async (
		scope: SiteScope | WorkspaceScope | Background,
		report: ReportRow,
		kind: "scheduled" | "test",
		recipients: string[],
		requestedBy: string | null,
	): Promise<SendRow> => {
		const period = periodBefore(report.schedule as ReportSchedule, clock.now());
		const row = await (scope as BackgroundScope).insert(reportSends, {
			reportId: report.id,
			kind,
			status: "preparing",
			periodFrom: period.from,
			periodTo: period.to,
			previousFrom: period.previousFrom,
			previousTo: period.previousTo,
			language: report.language,
			recipients,
			requestedBy,
			createdAt: clock.now(),
		} as never);
		await deps.queue.prepare(refOf(row as SendRow));
		return row as SendRow;
	};

	/** The AI text of a Report, written from its totals with the Workspace's AI key; or why there is none. */
	const writeText = async (
		ref: ReportSendRef,
		send: SendRow,
		placeName: string,
		widgets: Content["widgets"],
	): Promise<{ ai: ReportAiText | null; status: "written" | "noKey" | "cap" | "failed" | "none" }> => {
		const facts = reportFacts({
			place: placeName,
			period: { from: send.periodFrom, to: send.periodTo },
			compared: { from: send.previousFrom, to: send.previousTo },
			widgets,
		});
		if (facts.widgetIds.length === 0) return { ai: null, status: "none" };
		const services = await servicesList(database.db);
		const language = ADMIN_LANGUAGES.find((each) => each.code === send.language) ?? ADMIN_LANGUAGES[0];
		try {
			const ai = await deps.aiKeys.call(
				{ workspaceId: ref.workspaceId, siteId: ref.siteId },
				"report",
				{
					inputTokens: Math.ceil((facts.json.length + JSON.stringify(services).length) / 3) + 800,
					outputTokens: REPORT_TEXT_OUTPUT_TOKENS,
				},
				async (connection) => {
					const answer = await deps.ai.writeReport({
						connection,
						purpose: "report",
						language: { code: language.code, name: language.name },
						facts: facts.json,
						services,
					});
					return { value: readReportText(answer.text, facts.widgetIds, services), usage: answer.usage };
				},
			);
			return { ai, status: "written" };
		} catch (error) {
			if (error instanceof AiKeyMissingError) return { ai: null, status: "noKey" };
			if (error instanceof AiCapReachedError) return { ai: null, status: "cap" };
			if (error instanceof AiProviderError) {
				log.warn("A Report's AI text wasn't written: the AI provider gave no usable answer", {
					reportSendId: send.id,
					problem: error.problem,
				});
				return { ai: null, status: "failed" };
			}
			throw error;
		}
	};

	/** Records that an entry failed, in words for its history. */
	const fail = async (scope: Background, send: SendRow, problem: string) => {
		await (scope as BackgroundScope).update(
			reportSends,
			{ status: "failed", problem } as never,
			inPlace(levelOf(scope), reportSends, eq(reportSends.id, send.id)),
		);
	};

	/**
	 * Emails a Report's PDF to its recipients, each once: an email already queued for the entry isn't
	 * queued again (the job may run twice), unless it is sent `again` on purpose.
	 */
	const mail = async (
		scope: Background,
		send: SendRow,
		recipients: string[],
		content: Content,
		again = false,
	): Promise<void> => {
		const site = scope.level === "background" ? scope.site : null;
		const brand = await resolveBrand(scope, site);
		const words = reportWords(send.language);
		const period = periodText(send.periodFrom, send.periodTo, send.language);
		const route = site
			? await deps.email.siteMail.route(scope as BackgroundScope as unknown as SiteScope)
			: { smtp: { kind: "install" as const }, fromName: brand.client?.name ?? scope.workspace.name, replyTo: null };
		const already = again
			? new Set<string>()
			: new Set(
					(
						await database.db
							.select({ recipient: emailLog.recipient })
							.from(emailLog)
							.where(and(eq(emailLog.relatedKind, "reportSend"), eq(emailLog.relatedId, send.id)))
					).map((line) => line.recipient),
				);
		const filename = pdfName(content.name, send.periodFrom, send.periodTo);
		for (const to of recipients) {
			if (already.has(to)) continue;
			await deps.email.siteMail.queue(site ? { id: site.id } : null, route, {
				type: "report",
				to,
				language: send.language,
				subject: fill(words.email.subject, { name: content.name, period }),
				paragraphs: [
					fill(words.email.intro, { name: content.name, place: content.placeName, period }),
					content.ai ? content.ai.whatHappened : words.email.noAi,
					words.email.attached,
				],
				note: send.kind === "test" ? words.email.test : null,
				related: { kind: "reportSend", id: send.id },
				attachments: [
					{ kind: "reportPdf", id: send.id, workspaceId: scope.workspace.id, siteId: site?.id ?? null, filename },
				],
			});
		}
	};

	const service: Reports = {
		async list(access, place, dashboardId) {
			const opened = await openPlace(data, access, place, "report.view");
			await requireDashboard(opened, dashboardId);
			const column = opened.level === "site" ? reports.dashboardId : reports.workspaceDashboardId;
			const rows = await scoped(opened).select(reports, inPlace(opened.level, reports, eq(column, dashboardId)), {
				orderBy: [reports.name, reports.createdAt],
			});
			return rows.map(viewOf);
		},

		async create(access, place, dashboardId, input) {
			const opened = await openPlace(data, access, place, "report.manage");
			await requireDashboard(opened, dashboardId);
			const column = opened.level === "site" ? reports.dashboardId : reports.workspaceDashboardId;
			if (
				(await scoped(opened).count(reports, inPlace(opened.level, reports, eq(column, dashboardId)))) >=
				MAX_REPORTS_PER_DASHBOARD
			) {
				throw new ReportInvalidError("reports", `A Dashboard has at most ${MAX_REPORTS_PER_DASHBOARD} Reports.`);
			}
			const name = checkedName(input.name);
			const language = checkedLanguage(input.language);
			const recipients = checkedRecipients(input.recipients);
			const now = clock.now();
			assertRecipientsChangeAllowed(access, [], recipients, now);
			const scope = scoped(opened);
			const row = await scope.transaction(async (tx) => {
				const made = await tx.insert(reports, {
					...(opened.level === "site" ? { dashboardId } : { workspaceDashboardId: dashboardId }),
					name,
					schedule: input.schedule,
					language,
					recipients,
					review: input.review,
					active: input.active,
					nextRunAt: nextRunAfter(input.schedule, now),
					createdAt: now,
					createdBy: personIdOf(access.actor),
					updatedAt: now,
					updatedBy: personIdOf(access.actor),
				} as never);
				await tx.audit("report.create", {
					reportId: made.id,
					dashboardId,
					name,
					schedule: input.schedule,
					recipients: recipients.length,
					review: input.review,
				});
				return made;
			});
			return viewOf(row);
		},

		async update(access, place, reportId, input) {
			const opened = await openPlace(data, access, place, "report.manage");
			const current = await reportOf(opened, reportId);
			const schedule = input.schedule ?? (current.schedule as ReportSchedule);
			const active = input.active ?? current.active;
			const now = clock.now();
			const recipients = input.recipients === undefined ? undefined : checkedRecipients(input.recipients);
			if (recipients) assertRecipientsChangeAllowed(access, recipientsOf(current.recipients), recipients, now);
			const set = {
				...(input.name !== undefined ? { name: checkedName(input.name) } : {}),
				...(input.language !== undefined ? { language: checkedLanguage(input.language) } : {}),
				...(recipients !== undefined ? { recipients } : {}),
				...(input.review !== undefined ? { review: input.review } : {}),
				schedule,
				active,
				// A new schedule, or switching it on again, counts from now.
				...(schedule !== current.schedule || (active && !current.active)
					? { nextRunAt: nextRunAfter(schedule, now) }
					: {}),
				updatedAt: now,
				updatedBy: personIdOf(access.actor),
			};
			const scope = scoped(opened);
			const [row] = await scope.transaction(async (tx) => {
				const updated = await tx.update(
					reports,
					set as never,
					inPlace(opened.level, reports, eq(reports.id, reportId)),
				);
				await tx.audit("report.update", {
					reportId,
					name: updated[0]?.name ?? current.name,
					changed: Object.keys(input).filter((key) => input[key as keyof ReportInput] !== undefined),
				});
				return updated;
			});
			return viewOf(row as ReportRow);
		},

		async setRecipients(access, place, reportId, recipients) {
			const opened = await openPlace(data, access, place, "reportRecipients.edit");
			const current = await reportOf(opened, reportId);
			const checked = checkedRecipients(recipients);
			assertRecipientsChangeAllowed(access, recipientsOf(current.recipients), checked, clock.now());
			const scope = scoped(opened);
			const [row] = await scope.transaction(async (tx) => {
				const updated = await tx.update(
					reports,
					{ recipients: checked, updatedAt: clock.now(), updatedBy: personIdOf(access.actor) } as never,
					inPlace(opened.level, reports, eq(reports.id, reportId)),
				);
				const before = recipientsOf(current.recipients);
				await tx.audit("reportRecipients.change", {
					reportId,
					name: current.name,
					added: checked.filter((address) => !before.includes(address)),
					removed: before.filter((address) => !checked.includes(address)),
				});
				return updated;
			});
			return viewOf(row as ReportRow);
		},

		async delete(access, place, reportId) {
			const opened = await openPlace(data, access, place, "report.manage");
			const current = await reportOf(opened, reportId);
			const scope = scoped(opened);
			await scope.transaction(async (tx) => {
				await tx.delete(reports, inPlace(opened.level, reports, eq(reports.id, reportId)));
				await tx.audit("report.delete", { reportId, name: current.name });
			});
		},

		async sendTest(access, place, reportId) {
			const opened = await openPlace(data, access, place, "report.manage");
			const report = await reportOf(opened, reportId);
			const person = await deps.people.get(actingPerson(access.actor));
			if (!person) throw new ReportNotFoundError();
			const row = await startSend(opened.scope, report, "test", [person.email], person.id);
			await opened.scope.audit("report.test", { reportId, name: report.name });
			const [view] = await sendViews(database, [row]);
			return view as ReportSendView;
		},

		async history(access, place, reportId, options) {
			const opened = await openPlace(data, access, place, "report.view");
			await reportOf(opened, reportId);
			const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
			const rows = await scoped(opened).select(
				reportSends,
				inPlace(
					opened.level,
					reportSends,
					and(
						eq(reportSends.reportId, reportId),
						options.before ? lt(reportSends.createdAt, options.before) : undefined,
					) as SQL,
				),
				{ orderBy: [desc(reportSends.createdAt)], limit },
			);
			return sendViews(database, rows);
		},

		async send(access, place, sendId) {
			const opened = await openPlace(data, access, place, "report.view");
			return detailOf(await sendOf(opened, sendId));
		},

		async pdf(access, place, sendId) {
			const opened = await openPlace(data, access, place, "report.view");
			const row = await sendOf(opened, sendId);
			if (!row.pdf) throw new ReportSendRefusedError("noPdf");
			const content = contentOf(row.content);
			return {
				filename: pdfName(content?.name ?? "report", row.periodFrom, row.periodTo),
				contentType: "application/pdf",
				base64: Buffer.from(row.pdf).toString("base64"),
			};
		},

		async editText(access, place, sendId, text) {
			const opened = await openPlace(data, access, place, "report.manage");
			const row = await sendOf(opened, sendId);
			if (row.status !== "review") throw new ReportSendRefusedError("notHeld");
			const content = contentOf(row.content);
			if (!content) throw new ReportSendRefusedError("notHeld");
			const services = new Set((await servicesList(database.db)).map((each) => each.id));
			const widgetIds = new Set(content.widgets.map((widget) => widget.answer.widgetId));
			const whatHappened = plain(text.whatHappened, AI_TEXT_LIMITS.whatHappened);
			if (!whatHappened) throw new ReportInvalidError("text", "Say what happened in a few sentences.");
			if (text.suggestions.length > AI_TEXT_LIMITS.suggestions) {
				throw new ReportInvalidError("text", `A Report has at most ${AI_TEXT_LIMITS.suggestions} suggestions.`);
			}
			const ai: ReportAiText = {
				whatHappened,
				widgets: Object.fromEntries(
					Object.entries(text.widgets)
						.filter(([id]) => widgetIds.has(id))
						.map(([id, said]) => [id, plain(said, AI_TEXT_LIMITS.widget)])
						.filter(([, said]) => said !== ""),
				),
				suggestions: text.suggestions
					.map((suggestion) => ({
						text: plain(suggestion.text, AI_TEXT_LIMITS.suggestion),
						service: suggestion.service && services.has(suggestion.service) ? suggestion.service : null,
					}))
					.filter((suggestion) => suggestion.text !== ""),
			};
			const [updated] = await scoped(opened).update(
				reportSends,
				{ content: { ...content, ai } } as never,
				inPlace(opened.level, reportSends, and(eq(reportSends.id, sendId), eq(reportSends.status, "review")) as SQL),
			);
			if (!updated) throw new ReportSendRefusedError("notHeld");
			return detailOf(updated);
		},

		async approve(access, place, sendId) {
			const opened = await openPlace(data, access, place, "report.manage");
			const row = await sendOf(opened, sendId);
			const scope = scoped(opened);
			const updated = await scope.transaction(async (tx) => {
				const [changed] = await tx.update(
					reportSends,
					{ status: "rendering", approvedBy: personIdOf(access.actor), approvedAt: clock.now() } as never,
					inPlace(opened.level, reportSends, and(eq(reportSends.id, sendId), eq(reportSends.status, "review")) as SQL),
				);
				if (!changed) throw new ReportSendRefusedError("notHeld");
				await tx.audit("report.approve", { reportId: row.reportId, reportSendId: sendId });
				return changed;
			});
			await deps.queue.render(refOf(updated));
			const [view] = await sendViews(database, [updated]);
			return view as ReportSendView;
		},

		async discard(access, place, sendId) {
			const opened = await openPlace(data, access, place, "report.manage");
			const row = await sendOf(opened, sendId);
			const scope = scoped(opened);
			const updated = await scope.transaction(async (tx) => {
				const [changed] = await tx.update(
					reportSends,
					{ status: "discarded" } as never,
					inPlace(opened.level, reportSends, and(eq(reportSends.id, sendId), eq(reportSends.status, "review")) as SQL),
				);
				if (!changed) throw new ReportSendRefusedError("notHeld");
				await tx.audit("report.discard", { reportId: row.reportId, reportSendId: sendId });
				return changed;
			});
			const [view] = await sendViews(database, [updated]);
			return view as ReportSendView;
		},

		async resend(access, place, sendId) {
			const opened = await openPlace(data, access, place, "report.manage");
			const row = await sendOf(opened, sendId);
			if (row.status !== "sent" && row.status !== "failed") throw new ReportSendRefusedError("notSent");
			const report = await reportOf(opened, row.reportId);
			const content = contentOf(row.content);
			const scope = scoped(opened);
			const where = inPlace(opened.level, reportSends, eq(reportSends.id, sendId));
			if (!row.pdf) {
				// It failed before its PDF was made: make it again, from the start.
				if (!content) throw new ReportSendRefusedError("noPdf");
				const [updated] = await scope.transaction(async (tx) => {
					const changed = await tx.update(
						reportSends,
						{ status: "rendering", renderAttempts: 0, problem: null } as never,
						where,
					);
					await tx.audit("report.resend", { reportId: row.reportId, reportSendId: sendId });
					return changed;
				});
				await deps.queue.render(refOf(updated as SendRow));
				const [view] = await sendViews(database, [updated as SendRow]);
				return view as ReportSendView;
			}
			const recipients = row.kind === "test" ? recipientsOf(row.recipients) : recipientsOf(report.recipients);
			if (recipients.length === 0) throw new ReportSendRefusedError("noRecipients");
			const [updated] = await scope.transaction(async (tx) => {
				const changed = await tx.update(reportSends, { recipients, status: "sent", problem: null } as never, where);
				await tx.audit("report.resend", {
					reportId: row.reportId,
					reportSendId: sendId,
					recipients: recipients.length,
				});
				return changed;
			});
			const bg = await background(refOf(row));
			// Sent again to everyone, including those already sent it.
			if (bg && content) await mail(bg, updated as SendRow, recipients, content, true);
			const [view] = await sendViews(database, [updated as SendRow]);
			return view as ReportSendView;
		},

		async runDue() {
			const now = clock.now();
			// Install-wide: which Reports are due. Each one is then claimed and started in its own place.
			const due = await database.db
				.select({ id: reports.id, workspaceId: reports.workspaceId, siteId: reports.siteId })
				.from(reports)
				.where(and(eq(reports.active, true), lte(reports.nextRunAt, now)))
				.limit(200);
			let started = 0;
			for (const each of due) {
				const scope = await background(each);
				if (!scope) continue;
				const level = levelOf(scope);
				const claimed = await (scope as BackgroundScope).transaction(async (tx) => {
					const [row] = (await tx.db
						.select()
						.from(reports)
						.where(
							tx.where(
								reports,
								inPlace(level, reports, and(eq(reports.id, each.id), lte(reports.nextRunAt, now)) as SQL),
							),
						)
						.for("update", { skipLocked: true })) as ReportRow[];
					if (!row) return null;
					await tx.update(
						reports,
						{ nextRunAt: nextRunAfter(row.schedule as ReportSchedule, now) } as never,
						inPlace(level, reports, eq(reports.id, row.id)),
					);
					return row;
				});
				if (!claimed) continue;
				const recipients = recipientsOf(claimed.recipients);
				if (recipients.length === 0) continue;
				await startSend(scope, claimed, "scheduled", recipients, null);
				started++;
			}
			return started;
		},

		async prepare(ref) {
			const scope = await background(ref);
			if (!scope) return;
			const send = await backgroundSend(scope, ref.sendId);
			if (send?.status !== "preparing") return;
			const level = levelOf(scope);
			const report = await (scope as BackgroundScope).first(
				reports,
				inPlace(level, reports, eq(reports.id, send.reportId)),
			);
			if (!report) return;
			const place: DashboardPlace = ref.siteId ? { siteId: ref.siteId } : { workspaceId: ref.workspaceId };
			const dashboardId = (report.dashboardId ?? report.workspaceDashboardId) as string;
			const current = await deps.dashboards.shown(place, dashboardId, {
				range: rangeOf(send.periodFrom, send.periodTo),
				language: send.language,
			});
			if (!current) return fail(scope, send, "Its Dashboard no longer exists.");
			const previous = await deps.dashboards.shown(place, dashboardId, {
				range: rangeOf(send.previousFrom, send.previousTo),
				language: send.language,
			});
			const placeName = scope.level === "background" ? scope.site.name : scope.workspace.name;
			const widgets = current.answers.map((answer) => ({
				answer,
				previous: previous?.answers.find((each) => each.widgetId === answer.widgetId) ?? null,
			}));
			const text = await writeText(ref, send, placeName, widgets);
			const content: Content = { name: report.name, placeName, widgets, ai: text.ai };
			const held = report.review && send.kind === "scheduled" && text.status === "written";
			await (scope as BackgroundScope).update(
				reportSends,
				{ content, aiStatus: text.status, status: held ? "review" : "rendering" } as never,
				inPlace(level, reportSends, eq(reportSends.id, send.id)),
			);
			if (!held) {
				await deps.queue.render(ref);
				return;
			}
			const staff = await siteStaff(scope);
			if (staff.length === 0) return;
			const base = ref.siteId ? `/sites/${ref.siteId}` : `/workspaces/${ref.workspaceId}`;
			await deps.email.send({
				type: "report-review",
				to: staff.map((personId) => ({ personId })),
				data: {
					reportName: report.name,
					placeName,
					reviewPath: `${base}/dashboards/${dashboardId}/reports?review=${send.id}`,
				},
				related: { kind: "reportSend", id: send.id },
			});
		},

		async render(ref) {
			const scope = await background(ref);
			if (!scope) return;
			const send = await backgroundSend(scope, ref.sendId);
			if (send?.status !== "rendering") return;
			const level = levelOf(scope);
			const where = inPlace(level, reportSends, eq(reportSends.id, send.id));
			const content = contentOf(send.content);
			if (!content) return fail(scope, send, "Nothing was prepared for it.");
			let pdf: Uint8Array | null = send.pdf;
			if (!pdf) {
				const html = await pageOf(scope, send, content);
				const attempts = send.renderAttempts + 1;
				try {
					if (html.length > PDF_LIMITS.html) throw new PdfRenderError("size", "The Report's page is too large.");
					pdf = await deps.pdf.render(html);
					if (pdf.byteLength > PDF_LIMITS.pdf) throw new PdfRenderError("size", "The Report's PDF is too large.");
				} catch (error) {
					const problem = error instanceof PdfRenderError ? error.problem : "failed";
					log.warn("A Report's PDF wasn't made", { reportSendId: send.id, attempt: attempts, problem });
					const again = problem !== "size" && attempts < RENDER_ATTEMPTS;
					await (scope as BackgroundScope).update(
						reportSends,
						{
							renderAttempts: attempts,
							problem: `Its PDF couldn't be made (${problem}).`,
							...(again ? {} : { status: "failed" }),
						} as never,
						where,
					);
					// Tried again after 2, then 4 minutes; never sent without its PDF.
					if (again) await deps.queue.render(ref, new Date(clock.now().getTime() + 2 ** attempts * MINUTE_MS));
					else await tellFailed(scope, send);
					return;
				}
				await (scope as BackgroundScope).update(
					reportSends,
					{ pdf: Buffer.from(pdf), pdfBytes: pdf.byteLength, renderAttempts: attempts, problem: null } as never,
					where,
				);
			}
			await mail(scope, send, recipientsOf(send.recipients), content);
			await (scope as BackgroundScope).update(reportSends, { status: "sent", sentAt: clock.now() } as never, where);
		},

		async purge() {
			const before = new Date(clock.now().getTime() - REPORT_HISTORY_DAYS * DAY_MS);
			const deleted = await database.db
				.delete(reportSends)
				.where(lt(reportSends.createdAt, before))
				.returning({ id: reportSends.id });
			return deleted.length;
		},

		async attachment(ref) {
			if (ref.kind !== "reportPdf") return null;
			const scope = await background(ref);
			if (!scope) return null;
			const row = await backgroundSend(scope, ref.id);
			if (!row?.pdf) return null;
			return { filename: ref.filename, contentType: "application/pdf", content: new Uint8Array(row.pdf) };
		},
	};

	/** Tells the Workspace's Staff that a Report wasn't sent: its PDF couldn't be made. */
	const tellFailed = async (scope: Background, send: SendRow) => {
		const level = levelOf(scope);
		const report = await (scope as BackgroundScope).first(
			reports,
			inPlace(level, reports, eq(reports.id, send.reportId)),
		);
		const staff = await siteStaff(scope);
		if (!report || staff.length === 0) return;
		const base = scope.level === "background" ? `/sites/${scope.site.id}` : `/workspaces/${scope.workspace.id}`;
		const dashboardId = report.dashboardId ?? report.workspaceDashboardId;
		await deps.email.send({
			type: "report-failed",
			to: staff.map((personId) => ({ personId })),
			data: {
				reportName: report.name,
				placeName: scope.level === "background" ? scope.site.name : scope.workspace.name,
				reportsPath: `${base}/dashboards/${dashboardId}/reports?report=${report.id}`,
			},
			related: { kind: "reportSend", id: send.id },
		});
	};

	/** The page a Report's PDF is made from: the same page a Share link shows, with the Report's AI text. */
	const pageOf = async (scope: Background, send: SendRow, content: Content): Promise<string> => {
		const site = scope.level === "background" ? scope.site : null;
		const services = new Map((await servicesList(database.db)).map((each) => [each.id, each.name]));
		const ai: ReportAiView =
			send.aiStatus === "written" && content.ai
				? {
						status: "written",
						whatHappened: content.ai.whatHappened,
						suggestions: content.ai.suggestions.map((suggestion) => ({
							text: suggestion.text,
							service: suggestion.service ? (services.get(suggestion.service) ?? null) : null,
						})),
					}
				: { status: (send.aiStatus as "noKey" | "cap" | "failed" | "none" | null) ?? "none" };
		const widgets: ReportWidget[] = content.widgets.map((widget) => ({
			...widget,
			text: content.ai?.widgets[widget.answer.widgetId] ?? null,
		}));
		return reportPage({
			language: send.language,
			title: content.name,
			placeName: content.placeName,
			brand: await resolveBrand(scope, site),
			period: { from: send.periodFrom, to: send.periodTo },
			compared: { from: send.previousFrom, to: send.previousTo },
			widgets,
			ai,
			explore: null,
		});
	};

	return service;
}
