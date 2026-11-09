import type { Database } from "@webcraft/db";
import { people, webhookDeliveries, webhookDeliveryAttempts, webhooks } from "@webcraft/db/schema";
import { and, arrayContains, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";

import type { RecordedAuditEntry } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import { siteAddresses } from "../domains/addresses.ts";
import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import { personIdOf } from "../permissions/can.ts";
import { SecretNotSetError, type Secrets, SecretUnreadableError } from "../secrets/store.ts";
import type { BackgroundScope, DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { WebhookDeliveryNotFoundError, WebhookRedeliveryRefusedError } from "./errors.ts";
import { publishedBy, TEST_EVENT, type WebhookEvent } from "./events.ts";
import { webhooksDeliver } from "./jobs.ts";
import { signatureHeader, signingSecretName, WEBHOOK_HEADERS } from "./signing.ts";
import type { WebhookRow } from "./webhooks.ts";

/**
 * Sending Webhooks. An event is queued once the change it is about is saved: one delivery per Webhook
 * on the Site that is on and receives it, each recorded in the delivery log with its body, and one
 * `webhooks.deliver` job per attempt. The worker sends it through the guarded fetcher: only to the
 * Webhook's host, to a public address it checked and connects to, no redirects followed (the call
 * carries a signature), at most 10 seconds and a 1 MB answer.
 *
 * An attempt that fails for a reason that may pass (no answer, a timeout, the host not resolving,
 * 408, 429 and 5xx answers) is tried again after a wait that grows fourfold from 1 minute, or as long
 * as the receiver's `Retry-After` asks, up to 6 hours; after 6 attempts the delivery is failed. A
 * redirect, any other 4xx answer or an answer too large fails it at once. Every attempt carries the
 * same delivery id, and a new signature with its own timestamp.
 */

/** Attempts per delivery (and per redelivery). */
export const MAX_ATTEMPTS = 6;

/** The wait after a delivery's first failed attempt; it grows fourfold after each failure. */
const FIRST_WAIT_MS = 60_000;

/** No wait between two attempts is longer, `Retry-After` included. */
export const LONGEST_WAIT_MS = 6 * 60 * 60_000;

/** How long a receiver has to answer, and how much of an answer is read. */
export const DELIVERY_TIMEOUT_MS = 10_000;
const LARGEST_ANSWER_BYTES = 1024 * 1024;

/** How much of a receiver's answer the delivery log keeps. */
export const EXCERPT_LENGTH = 500;

/** What went wrong with an attempt. */
export type AttemptProblem = "status" | "redirect" | "timeout" | "unreachable" | "address" | "size" | "secret";

export type DeliveryPorts = {
	config: InstallConfig;
	database: Database;
	data: DataLayer;
	/** Every secret: a delivery reads only its own Site's Webhook signing secret. */
	secrets: Secrets;
	fetch: GuardedFetch;
	jobs: JobQueue;
	clock: Clock;
	log: Logger;
	/** Told when a delivery (not a test send) ends, so a Webhook that keeps failing is switched off (`failing.ts`). */
	onFinished(scope: DeliveryScope, webhook: WebhookRow, delivered: boolean): Promise<void>;
};

/** What delivery code works on: a Site, opened by a person (a test send) or for background work. */
export type DeliveryScope = Pick<
	BackgroundScope,
	"select" | "first" | "count" | "insert" | "update" | "delete" | "where" | "db" | "site" | "workspace" | "now"
> & { transaction<Result>(work: (scope: DeliveryScope) => Promise<Result>): Promise<Result> };

export type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/** One `webhooks.deliver` job: attempt `attempt` of the delivery, the `round`-th of its round (redeliveries start one). */
export type AttemptPayload = { siteId: string; deliveryId: string; attempt: number; round: number };

/** Who acted, as an event names them: a person by id and name, or null when nobody did (WebCraft, a Module). */
type EventActor = { id: string; name: string } | null;

/**
 * Queues the `publish` event when an Audit log entry is a publish (it is announced once its change is
 * saved). Never throws: a failure is logged, and the publish stands.
 */
export async function publishEventOf(
	ports: DeliveryPorts,
	queue: (place: { siteId: string }, event: WebhookEvent, data: Record<string, unknown>, at: Date) => Promise<void>,
	entry: RecordedAuditEntry,
): Promise<void> {
	const published = entry.siteId ? publishedBy(entry.action, entry.details) : null;
	if (!published || !entry.siteId) return;
	try {
		await queue(
			{ siteId: entry.siteId },
			"publish",
			{ ...published, by: await actorOf(ports.database, entry.personId), via: entry.via.kind },
			entry.at,
		);
	} catch (error) {
		ports.log.error("A Webhook event couldn't be queued", { siteId: entry.siteId, event: "publish", error });
	}
}

async function actorOf(database: Database, personId: string | null): Promise<EventActor> {
	if (!personId) return null;
	const [person] = await database.db
		.select({ id: people.id, name: people.name })
		.from(people)
		.where(eq(people.id, personId));
	return person ?? null;
}

/**
 * Queues an event on a Site: one delivery for each Webhook that is on and receives it, sent by the
 * worker. Call it once the change the event is about is saved, never inside its transaction. `data`
 * holds no secret, and no Content values unless the spec says so.
 */
export async function queueEvent(
	ports: DeliveryPorts,
	place: { siteId: string },
	event: WebhookEvent,
	data: Record<string, unknown>,
	occurredAt: Date,
): Promise<void> {
	const scope = await ports.data.background(place.siteId);
	if (!scope) return;
	const receivers = await scope.select(
		webhooks,
		and(eq(webhooks.enabled, true), arrayContains(webhooks.events, [event])),
	);
	if (receivers.length === 0) return;
	const site = await siteOf(ports, scope);
	for (const webhook of receivers) {
		const id = crypto.randomUUID();
		const body = JSON.stringify({ id, type: event, occurredAt: occurredAt.toISOString(), site, data });
		await scope.insert(webhookDeliveries, {
			id,
			webhookId: webhook.id,
			event,
			body,
			status: "queued",
			nextAttemptAt: scope.now(),
			createdAt: scope.now(),
		});
		await ports.jobs.send(webhooksDeliver, { siteId: scope.site.id, deliveryId: id, attempt: 1, round: 1 });
	}
}

/** The Site as an event names it: its id, name, and where visitors find it (null without an address). */
export async function siteOf(
	ports: Pick<DeliveryPorts, "config">,
	scope: Pick<DeliveryScope, "db" | "site">,
): Promise<{ id: string; name: string; url: string | null }> {
	const addresses = await siteAddresses(scope.db, ports.config, scope.site);
	return { id: scope.site.id, name: scope.site.name, url: addresses?.main ?? null };
}

/** One attempt of a queued delivery, from the worker. */
export async function runAttempt(ports: DeliveryPorts, payload: AttemptPayload): Promise<void> {
	const scope = await ports.data.background(payload.siteId);
	if (!scope) return;
	const delivery = await scope.first(webhookDeliveries, eq(webhookDeliveries.id, payload.deliveryId));
	// Done already (a job that ran twice), or purged: nothing to do.
	if (
		!delivery ||
		(delivery.status !== "queued" && delivery.status !== "retrying") ||
		delivery.attempts !== payload.attempt - 1
	) {
		return;
	}
	const webhook = await scope.first(webhooks, eq(webhooks.id, delivery.webhookId));
	if (!webhook) return;
	if (!webhook.enabled) {
		await stopDeliveries(scope, [delivery.id]);
		return;
	}
	const result = await attempt(ports, scope, webhook, delivery);
	await recordAttempt(ports, scope, webhook, delivery, payload, result);
}

/** What one attempt found. */
export type AttemptResult = {
	attemptedAt: Date;
	durationMs: number;
	statusCode: number | null;
	problem: AttemptProblem | null;
	excerpt: string | null;
	/** Whether trying again may help. */
	retry: boolean;
	/** How long the receiver asked to wait before the next try (`Retry-After`), in milliseconds. */
	retryAfterMs: number | null;
};

/** Sends a delivery's body to its Webhook once, signed now. Never throws for what the receiver did. */
export async function attempt(
	ports: Pick<DeliveryPorts, "secrets" | "fetch" | "clock" | "log">,
	scope: Pick<DeliveryScope, "site" | "workspace">,
	webhook: WebhookRow,
	delivery: Pick<DeliveryRow, "id" | "event" | "body">,
): Promise<AttemptResult> {
	const attemptedAt = ports.clock.now();
	const finish = (result: Omit<AttemptResult, "attemptedAt" | "durationMs">): AttemptResult => ({
		...result,
		attemptedAt,
		durationMs: Math.max(0, ports.clock.now().getTime() - attemptedAt.getTime()),
	});
	let signature: string;
	try {
		const timestamp = Math.floor(attemptedAt.getTime() / 1000);
		const owner = { kind: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const;
		signature = await ports.secrets.useWith({ owner, name: signingSecretName(webhook.id) }, (secret) =>
			signatureHeader(secret, timestamp, delivery.body),
		);
	} catch (error) {
		if (!(error instanceof SecretNotSetError || error instanceof SecretUnreadableError)) throw error;
		ports.log.error("A Webhook's signing secret can't be read, so its delivery wasn't sent", {
			siteId: scope.site.id,
			webhookId: webhook.id,
			error,
		});
		return finish({ statusCode: null, problem: "secret", excerpt: null, retry: false, retryAfterMs: null });
	}
	const request = new Request(webhook.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": "WebCraft-Webhooks/1",
			[WEBHOOK_HEADERS.event]: delivery.event,
			[WEBHOOK_HEADERS.delivery]: delivery.id,
			[WEBHOOK_HEADERS.signature]: signature,
		},
		body: delivery.body,
	});
	let response: Response;
	try {
		response = await ports.fetch(request, {
			allowedHosts: [new URL(webhook.url).hostname],
			maxRedirects: 0,
			timeoutMs: DELIVERY_TIMEOUT_MS,
			maxBytes: LARGEST_ANSWER_BYTES,
		});
	} catch (error) {
		if (!(error instanceof GuardedFetchError)) throw error;
		const problem: AttemptProblem =
			error.problem === "timeout" || error.problem === "size" || error.problem === "address"
				? error.problem
				: "unreachable";
		return finish({ statusCode: null, problem, excerpt: null, retry: problem !== "size", retryAfterMs: null });
	}
	const excerpt = excerptOf(await response.text());
	const { status } = response;
	if (status >= 200 && status < 300) {
		return finish({ statusCode: status, problem: null, excerpt, retry: false, retryAfterMs: null });
	}
	const retry = status === 408 || status === 429 || status >= 500;
	return finish({
		statusCode: status,
		problem: status >= 300 && status < 400 ? "redirect" : "status",
		excerpt,
		retry,
		retryAfterMs: retry ? retryAfterOf(response.headers.get("retry-after"), attemptedAt) : null,
	});
}

/** The start of an answer, for the delivery log; null when it is empty. */
function excerptOf(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const characters = Array.from(trimmed);
	return characters.length > EXCERPT_LENGTH ? `${characters.slice(0, EXCERPT_LENGTH).join("")}…` : trimmed;
}

/** A `Retry-After` header (seconds, or an HTTP date) as a wait in milliseconds; null when absent or unreadable. */
function retryAfterOf(header: string | null, now: Date): number | null {
	if (!header) return null;
	const value = header.trim();
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

/** The wait before attempt `round + 1` of a round, after attempt `round` failed. */
export function waitAfter(round: number, retryAfterMs: number | null): number {
	const backoff = FIRST_WAIT_MS * 4 ** Math.max(round - 1, 0);
	return Math.min(Math.max(backoff, retryAfterMs ?? 0), LONGEST_WAIT_MS);
}

/** Records an attempt in the delivery log, and queues the next one or ends the delivery. */
async function recordAttempt(
	ports: DeliveryPorts,
	scope: DeliveryScope,
	webhook: WebhookRow,
	delivery: DeliveryRow,
	payload: AttemptPayload,
	result: AttemptResult,
): Promise<void> {
	const delivered = result.problem === null;
	const next =
		!delivered && result.retry && payload.round < MAX_ATTEMPTS
			? new Date(result.attemptedAt.getTime() + waitAfter(payload.round, result.retryAfterMs))
			: null;
	const status = delivered ? "delivered" : next ? "retrying" : "failed";
	const recorded = await scope.transaction(async (tx) => {
		const [updated] = await tx.update(
			webhookDeliveries,
			{
				status,
				attempts: payload.attempt,
				lastStatusCode: result.statusCode,
				lastProblem: result.problem,
				nextAttemptAt: next,
				finishedAt: next ? null : result.attemptedAt,
			},
			and(
				eq(webhookDeliveries.id, delivery.id),
				eq(webhookDeliveries.attempts, payload.attempt - 1),
				inArray(webhookDeliveries.status, ["queued", "retrying"]),
			),
		);
		if (!updated) return false;
		await tx.insert(webhookDeliveryAttempts, {
			deliveryId: delivery.id,
			number: payload.attempt,
			attemptedAt: result.attemptedAt,
			durationMs: result.durationMs,
			statusCode: result.statusCode,
			problem: result.problem,
			responseExcerpt: result.excerpt,
		});
		return true;
	});
	if (!recorded) return;
	if (next) {
		await ports.jobs.send(
			webhooksDeliver,
			{ ...payload, attempt: payload.attempt + 1, round: payload.round + 1 },
			{ startAfter: next },
		);
		return;
	}
	if (!delivery.test) await ports.onFinished(scope, webhook, delivered);
}

/**
 * Stops deliveries still waiting for an attempt (their Webhook was switched off): they are failed,
 * and can be redelivered once it is on again. They don't count as failures of the receiver.
 */
export async function stopDeliveries(scope: Pick<DeliveryScope, "update" | "now">, ids: readonly string[]) {
	if (ids.length === 0) return;
	await scope.update(
		webhookDeliveries,
		{ status: "failed", lastProblem: "switched-off", nextAttemptAt: null, finishedAt: scope.now() },
		and(inArray(webhookDeliveries.id, [...ids]), inArray(webhookDeliveries.status, ["queued", "retrying"])),
	);
}

/** The deliveries of a Webhook still waiting for an attempt. */
export async function waitingDeliveries(scope: Pick<DeliveryScope, "select">, webhookId: string): Promise<string[]> {
	const rows = await scope.select(
		webhookDeliveries,
		and(eq(webhookDeliveries.webhookId, webhookId), inArray(webhookDeliveries.status, ["queued", "retrying"])),
	);
	return rows.map((row) => row.id);
}

/** One attempt of a delivery, as the delivery log shows it. */
export type DeliveryAttemptView = {
	number: number;
	at: Date;
	durationMs: number;
	/** The receiver's HTTP status; null when it didn't answer. */
	statusCode: number | null;
	/** What went wrong; null when it was delivered. */
	problem: AttemptProblem | null;
	/** The start of the receiver's answer (up to 500 characters). */
	excerpt: string | null;
};

/** A delivery, as the delivery log shows it: its body as sent, and every attempt, oldest first. */
export type DeliveryView = {
	/** The delivery id the receiver gets on every attempt. */
	id: string;
	event: string;
	test: boolean;
	status: "queued" | "retrying" | "delivered" | "failed";
	createdAt: Date;
	nextAttemptAt: Date | null;
	finishedAt: Date | null;
	lastStatusCode: number | null;
	/** What went wrong with the last attempt, or `switched-off` when it was stopped before one. */
	lastProblem: AttemptProblem | "switched-off" | null;
	/** The JSON body, as sent. */
	body: string;
	attempts: DeliveryAttemptView[];
};

/** A page of the delivery log, newest first; `next` asks for the page after it (null at the end). */
export type DeliveryPage = { deliveries: DeliveryView[]; next: string | null };

/** The delivery log of a Webhook, newest first, `limit` at a time, before the delivery `before` when given. */
export async function listDeliveries(
	scope: Pick<DeliveryScope, "select" | "first">,
	webhookId: string,
	options: { before?: string | undefined; limit: number },
): Promise<DeliveryPage> {
	let where = eq(webhookDeliveries.webhookId, webhookId);
	if (options.before) {
		const from = await scope.first(
			webhookDeliveries,
			and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.id, options.before)),
		);
		if (!from) throw new WebhookDeliveryNotFoundError();
		where = and(
			where,
			sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${from.createdAt.toISOString()}::timestamptz, ${from.id}::uuid)`,
		) as typeof where;
	}
	const rows = await scope.select(webhookDeliveries, where, {
		orderBy: [desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id)],
		limit: options.limit + 1,
	});
	const page = rows.slice(0, options.limit);
	const attempts =
		page.length === 0
			? []
			: await scope.select(
					webhookDeliveryAttempts,
					inArray(
						webhookDeliveryAttempts.deliveryId,
						page.map((row) => row.id),
					),
					{ orderBy: [asc(webhookDeliveryAttempts.number)] },
				);
	return {
		deliveries: page.map((row) => deliveryView(row, attempts)),
		next: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
	};
}

export function deliveryView(
	row: DeliveryRow,
	attempts: readonly (typeof webhookDeliveryAttempts.$inferSelect)[],
): DeliveryView {
	return {
		id: row.id,
		event: row.event,
		test: row.test,
		status: row.status as DeliveryView["status"],
		createdAt: row.createdAt,
		nextAttemptAt: row.nextAttemptAt,
		finishedAt: row.finishedAt,
		lastStatusCode: row.lastStatusCode,
		lastProblem: row.lastProblem as DeliveryView["lastProblem"],
		body: row.body,
		attempts: attempts
			.filter((attempt) => attempt.deliveryId === row.id)
			.map((attempt) => ({
				number: attempt.number,
				at: attempt.attemptedAt,
				durationMs: attempt.durationMs,
				statusCode: attempt.statusCode,
				problem: attempt.problem as AttemptProblem | null,
				excerpt: attempt.responseExcerpt,
			})),
	};
}

/** One delivery of a Webhook, with its attempts; `WebhookDeliveryNotFoundError` when it has none with that id. */
async function findDelivery(
	scope: Pick<DeliveryScope, "first" | "select">,
	webhookId: string,
	deliveryId: string,
): Promise<DeliveryView> {
	const row = await scope.first(
		webhookDeliveries,
		and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.id, deliveryId)),
	);
	if (!row) throw new WebhookDeliveryNotFoundError();
	return deliveryView(row, await scope.select(webhookDeliveryAttempts, eq(webhookDeliveryAttempts.deliveryId, row.id)));
}

/**
 * Send test: a signed `test` event, sent at once (whether the Webhook is on or off), recorded in the
 * delivery log and answered with what the receiver said. Never retried, and never counted as a
 * failure of the Webhook.
 */
export async function sendTest(ports: DeliveryPorts, scope: SiteScope, webhook: WebhookRow): Promise<DeliveryView> {
	const id = crypto.randomUUID();
	const now = scope.now();
	const data = { by: await actorOf(ports.database, personIdOf(scope.access.actor)), via: scope.access.via.kind };
	const body = JSON.stringify({
		id,
		type: TEST_EVENT,
		occurredAt: now.toISOString(),
		site: await siteOf(ports, scope),
		data,
	});
	const row = await scope.insert(webhookDeliveries, {
		id,
		webhookId: webhook.id,
		event: TEST_EVENT,
		body,
		test: true,
		status: "queued",
		nextAttemptAt: now,
		createdAt: now,
	});
	const result = await attempt(ports, scope, webhook, row);
	await recordAttempt(
		ports,
		scope,
		webhook,
		row,
		{ siteId: scope.site.id, deliveryId: id, attempt: 1, round: MAX_ATTEMPTS },
		result,
	);
	return findDelivery(scope, webhook.id, id);
}

/**
 * Redeliver: a failed delivery is queued again, with the same id and body, for a new round of up to
 * 6 attempts (numbered on from its last). Refused for a delivery that isn't failed, for a test send,
 * and while the Webhook is switched off.
 */
export async function redeliver(
	ports: DeliveryPorts,
	scope: SiteScope,
	webhook: WebhookRow,
	deliveryId: string,
): Promise<DeliveryView> {
	const queued = await scope.transaction(async (tx) => {
		const delivery = await tx.db
			.select()
			.from(webhookDeliveries)
			.where(
				tx.where(
					webhookDeliveries,
					and(eq(webhookDeliveries.webhookId, webhook.id), eq(webhookDeliveries.id, deliveryId)),
				),
			)
			.for("update");
		const [row] = delivery;
		if (!row) throw new WebhookDeliveryNotFoundError();
		if (row.test) throw new WebhookRedeliveryRefusedError("test");
		if (row.status !== "failed") throw new WebhookRedeliveryRefusedError("not-failed");
		const [current] = await tx.select(webhooks, eq(webhooks.id, webhook.id));
		if (!current?.enabled) throw new WebhookRedeliveryRefusedError("switched-off");
		await tx.update(
			webhookDeliveries,
			{ status: "queued", nextAttemptAt: tx.now(), finishedAt: null },
			eq(webhookDeliveries.id, row.id),
		);
		return row;
	});
	// Sent once the delivery is queued for good, so the attempt finds it so.
	await ports.jobs.send(webhooksDeliver, {
		siteId: scope.site.id,
		deliveryId: queued.id,
		attempt: queued.attempts + 1,
		round: 1,
	});
	return findDelivery(scope, webhook.id, queued.id);
}

/** How long the delivery log keeps a delivery. */
export const DELIVERY_LOG_DAYS = 30;

/** Deletes deliveries (and their attempts) older than 30 days, across the Install; answers how many. */
export async function purgeDeliveries(database: Database, now: Date): Promise<number> {
	const before = new Date(now.getTime() - DELIVERY_LOG_DAYS * 24 * 60 * 60_000);
	const deleted = await database.db
		.delete(webhookDeliveries)
		.where(lt(webhookDeliveries.createdAt, before))
		.returning({ id: webhookDeliveries.id });
	return deleted.length;
}
