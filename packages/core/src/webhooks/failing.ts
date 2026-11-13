import { webhooks } from "@webcraft/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

import type { Email } from "../email/index.ts";
import type { Logger } from "../log.ts";
import { siteOwners } from "../tenancy/site-owners.ts";
import { type DeliveryScope, stopDeliveries, waitingDeliveries } from "./deliveries.ts";
import { hostOf } from "./rules.ts";
import type { WebhookRow } from "./webhooks.ts";

/** Deliveries failed in a row (each after all its attempts) after which a Webhook is switched off. */
export const SWITCH_OFF_AFTER = 10;

/**
 * Counts how a Webhook's deliveries end. A delivered one starts its count of failures in a row again;
 * a failed one adds to it, and the one that makes it `SWITCH_OFF_AFTER` switches the Webhook off and
 * sends the Site's Owners the `webhook-switched-off` email, once. Test sends never count.
 */
export async function countFinished(
	ports: { email: Email; log: Logger },
	scope: DeliveryScope,
	webhook: WebhookRow,
	delivered: boolean,
): Promise<void> {
	const thisWebhook = scope.where(webhooks, eq(webhooks.id, webhook.id));
	const [counted] = await scope.db
		.update(webhooks)
		.set({ failuresInARow: delivered ? 0 : sql`${webhooks.failuresInARow} + 1` })
		.where(thisWebhook)
		.returning({ failuresInARow: webhooks.failuresInARow });
	if (delivered || !counted || counted.failuresInARow < SWITCH_OFF_AFTER) return;
	// Only the failure that switches it off tells anyone, however many end at once.
	const now = scope.now();
	const [switchedOff] = await scope.db
		.update(webhooks)
		.set({ enabled: false, switchedOffReason: "failing", switchedOffAt: now, updatedAt: now })
		.where(and(thisWebhook, eq(webhooks.enabled, true), gte(webhooks.failuresInARow, SWITCH_OFF_AFTER)))
		.returning();
	if (!switchedOff) return;
	await stopDeliveries(scope, await waitingDeliveries(scope, webhook.id));
	ports.log.warn("A Webhook kept failing, so it was switched off", {
		siteId: scope.site.id,
		webhookId: webhook.id,
		failuresInARow: counted.failuresInARow,
	});
	await tellOwners(ports, scope, switchedOff, counted.failuresInARow);
}

async function tellOwners(
	ports: { email: Email; log: Logger },
	scope: DeliveryScope,
	webhook: WebhookRow,
	failures: number,
): Promise<void> {
	const owners = await siteOwners(scope);
	if (owners.length === 0) {
		ports.log.warn("No Owner to tell that a Webhook was switched off", {
			siteId: scope.site.id,
			webhookId: webhook.id,
		});
		return;
	}
	await ports.email.send({
		type: "webhook-switched-off",
		to: owners.map((personId) => ({ personId })),
		data: {
			webhookName: webhook.name,
			host: hostOf(webhook.url),
			siteName: scope.site.name,
			failures,
			webhooksPath: `/sites/${scope.site.id}/webhooks`,
		},
		related: { kind: "site", id: scope.site.id },
	});
}
