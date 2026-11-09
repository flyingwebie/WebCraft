import { webhooks as webhooksTable } from "@webcraft/db/schema";
import { eq, sql } from "drizzle-orm";

import type { RecordedAuditEntry } from "../audit.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	type AttemptPayload,
	type DeliveryPage,
	type DeliveryPorts,
	type DeliveryScope,
	type DeliveryView,
	listDeliveries,
	publishEventOf,
	purgeDeliveries,
	queueEvent,
	redeliver,
	runAttempt,
	sendTest,
} from "./deliveries.ts";
import type { WebhookEvent } from "./events.ts";
import {
	addWebhook,
	changeWebhookSecret,
	findWebhook,
	listWebhooks,
	type NewWebhook,
	removeWebhook,
	setWebhookEnabled,
	updateWebhook,
	type WebhookChange,
	type WebhookRemoval,
	type WebhookRow,
	type WebhookView,
	type WebhookWithSecret,
} from "./webhooks.ts";

export type { AttemptProblem, DeliveryAttemptView, DeliveryPage, DeliveryView } from "./deliveries.ts";
export {
	TooManyWebhooksError,
	WebhookDeliveryNotFoundError,
	WebhookInvalidError,
	type WebhookInvalidField,
	type WebhookInvalidReason,
	WebhookNotFoundError,
	type WebhookRedeliveryProblem,
	WebhookRedeliveryRefusedError,
} from "./errors.ts";
export { isWebhookEvent, type PublishedItem, TEST_EVENT, WEBHOOK_EVENTS, type WebhookEvent } from "./events.ts";
export { webhooksDeliver, webhooksPurgeLog, webhooksPurgeLogSchedule } from "./jobs.ts";
export { WEBHOOK_HEADERS } from "./signing.ts";
export {
	MAX_WEBHOOKS_PER_SITE,
	type NewWebhook,
	type WebhookChange,
	type WebhookRemoval,
	type WebhookStatus,
	type WebhookView,
	type WebhookWithSecret,
} from "./webhooks.ts";

/**
 * A Site's Webhooks (spec story 139): calls to outside addresses when something happens on the Site,
 * signed with a secret, sent by the worker through the guarded fetcher with retries, and kept in a
 * delivery log. Site settings: open the Site with `site.view` to read them and `structure.edit` to
 * change them; each change saves at once and is recorded in the Audit log.
 */
export type Webhooks = {
	/** The Site's Webhooks, oldest first. */
	list(scope: SiteScope): Promise<WebhookView[]>;
	/** Adds a Webhook, on at once; answers the signing secret WebCraft made, once, when none was given. */
	add(scope: SiteScope, input: NewWebhook): Promise<WebhookWithSecret>;
	/** Changes a Webhook's name, URL and events at once. */
	update(scope: SiteScope, webhookId: string, change: WebhookChange): Promise<WebhookView>;
	/** Replaces a Webhook's signing secret with the one given, or a new one WebCraft makes (answered once). */
	changeSecret(scope: SiteScope, webhookId: string, secret?: string): Promise<WebhookWithSecret>;
	/**
	 * Removes a Webhook in two steps: without `confirmation` it answers what would go and a
	 * confirmation id; with it, the Webhook, its delivery log and its secret go.
	 */
	remove(scope: SiteScope, webhookId: string, confirmation?: string): Promise<WebhookRemoval>;
	/**
	 * Switches a Webhook on or off. Off, it receives nothing, and deliveries waiting for an attempt
	 * are stopped (to redeliver once it is on again).
	 */
	setEnabled(scope: SiteScope, webhookId: string, enabled: boolean): Promise<WebhookView>;
	/**
	 * Send test: a signed `test` event sent at once, on or off, recorded in the delivery log and
	 * answered with what the receiver said. Never retried; never counted as a failure.
	 */
	test(scope: SiteScope, webhookId: string): Promise<DeliveryView>;
	/** Queues a failed delivery again (same id and body) for a new round of attempts, while the Webhook is on. */
	redeliver(scope: SiteScope, webhookId: string, deliveryId: string): Promise<DeliveryView>;
	/**
	 * A Webhook's delivery log, newest first, `limit` at a time (the page before the delivery
	 * `before` when given). Deliveries are kept 30 days.
	 */
	deliveries(
		scope: SiteScope,
		webhookId: string,
		options: { before?: string | undefined; limit: number },
	): Promise<DeliveryPage>;
	/**
	 * Queues an event on a Site for every Webhook that is on and receives it. Call it once the change
	 * the event is about is saved (never inside its transaction); `data` holds no secret, and no
	 * Content values unless the spec says so. Forms' `formSubmitted` (#89) is queued this way.
	 */
	queueEvent(place: { siteId: string }, event: WebhookEvent, data: Record<string, unknown>, at: Date): Promise<void>;
	/** Hears every Audit log entry once its change is saved, and queues the `publish` event for a publish. */
	afterAudit(entry: RecordedAuditEntry): Promise<void>;
	/** For the worker: one attempt of a delivery. */
	runAttempt(payload: AttemptPayload): Promise<void>;
	/** For the worker: deletes deliveries older than 30 days across the Install; answers how many. */
	purgeLog(): Promise<number>;
};

export type WebhooksOptions = Omit<DeliveryPorts, "onFinished">;

export function createWebhooks(options: WebhooksOptions): Webhooks {
	const ports: DeliveryPorts = { ...options, onFinished };
	const queue: Webhooks["queueEvent"] = (place, event, data, at) => queueEvent(ports, place, event, data, at);
	return {
		list: listWebhooks,
		add: addWebhook,
		update: updateWebhook,
		changeSecret: changeWebhookSecret,
		remove: removeWebhook,
		setEnabled: setWebhookEnabled,
		test: async (scope, webhookId) => sendTest(ports, scope, await findWebhook(scope, webhookId)),
		redeliver: async (scope, webhookId, deliveryId) =>
			redeliver(ports, scope, await findWebhook(scope, webhookId), deliveryId),
		async deliveries(scope, webhookId, options) {
			await findWebhook(scope, webhookId);
			return listDeliveries(scope, webhookId, options);
		},
		queueEvent: queue,
		afterAudit: (entry) => publishEventOf(ports, queue, entry),
		runAttempt: (payload) => runAttempt(ports, payload),
		purgeLog: () => purgeDeliveries(options.database, options.clock.now()),
	};
}

/** A delivery ended: a delivered one starts the count of failures in a row again, a failed one adds to it. */
async function onFinished(scope: DeliveryScope, webhook: WebhookRow, delivered: boolean): Promise<void> {
	await scope.db
		.update(webhooksTable)
		.set({ failuresInARow: delivered ? 0 : sql`${webhooksTable.failuresInARow} + 1` })
		.where(scope.where(webhooksTable, eq(webhooksTable.id, webhook.id)));
}
