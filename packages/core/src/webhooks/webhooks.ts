import { webhookDeliveries, webhooks } from "@webcraft/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";

import { can } from "../permissions/can.ts";
import type { SecretDescription } from "../secrets/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { TooManyWebhooksError, WebhookNotFoundError } from "./errors.ts";
import { isWebhookEvent, type WebhookEvent } from "./events.ts";
import { givenSecret, hostOf, webhookUrl } from "./rules.ts";
import { newSigningSecret, signingSecretName } from "./signing.ts";

/** A Site has at most this many Webhooks. */
export const MAX_WEBHOOKS_PER_SITE = 20;

export type WebhookRow = typeof webhooks.$inferSelect;

/**
 * Whether a Webhook receives events: `on`, or `off`. `offReason` says who switched it off: `staff`, or
 * `failing` when WebCraft did after deliveries kept failing.
 */
export type WebhookStatus = "on" | "off";

export type WebhookView = {
	id: string;
	name: string;
	/**
	 * Where it is sent. People without `structure.edit` see only its origin (`https://host`): a URL
	 * can carry a token in its path or query.
	 */
	url: string;
	events: WebhookEvent[];
	status: WebhookStatus;
	offReason: "staff" | "failing" | null;
	/** Deliveries that failed in a row; at `SWITCH_OFF_AFTER` it is switched off. */
	failuresInARow: number;
	/** Its signing secret: "set" and the last 4 characters, for `structure.edit` only (null otherwise). */
	secret: SecretDescription | null;
	/** Its newest delivery, test sends included. */
	lastDelivery: { id: string; at: Date; status: string; event: string } | null;
	createdAt: Date;
	updatedAt: Date;
};

export type NewWebhook = {
	name?: string | undefined;
	url: string;
	events: readonly string[];
	secret?: string | undefined;
};

/** What adding a Webhook (or replacing its secret) answers: the secret WebCraft made, shown once. */
export type WebhookWithSecret = { webhook: WebhookView; secret: string | null };

/** The events a Webhook receives, each once, in the catalogue's order; refuses an unknown one. */
function eventsOf(events: readonly string[]): WebhookEvent[] {
	const unknown = events.find((event) => !isWebhookEvent(event));
	if (unknown !== undefined) throw new TypeError(`${unknown} isn't a Webhook event.`);
	return [...new Set(events)] as WebhookEvent[];
}

function canEdit(scope: SiteScope): boolean {
	return can(scope.access.actor, "structure.edit", {
		level: "site",
		workspaceId: scope.workspace.id,
		siteId: scope.site.id,
	});
}

/** The Site's Webhooks, oldest first. */
export async function listWebhooks(scope: SiteScope): Promise<WebhookView[]> {
	const rows = await scope.select(webhooks, undefined, { orderBy: [asc(webhooks.createdAt), asc(webhooks.id)] });
	const latest = await scope.db
		.selectDistinctOn([webhookDeliveries.webhookId], {
			webhookId: webhookDeliveries.webhookId,
			id: webhookDeliveries.id,
			at: webhookDeliveries.createdAt,
			status: webhookDeliveries.status,
			event: webhookDeliveries.event,
		})
		.from(webhookDeliveries)
		.where(scope.where(webhookDeliveries))
		.orderBy(webhookDeliveries.webhookId, desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id));
	const last = new Map(latest.map(({ webhookId, ...delivery }) => [webhookId, delivery]));
	return Promise.all(rows.map((row) => viewOf(scope, row, last.get(row.id) ?? null)));
}

/** One of the Site's Webhooks, as the admin shows it. */
export async function webhookView(scope: SiteScope, row: WebhookRow): Promise<WebhookView> {
	const [latest] = await scope.db
		.select({
			id: webhookDeliveries.id,
			at: webhookDeliveries.createdAt,
			status: webhookDeliveries.status,
			event: webhookDeliveries.event,
		})
		.from(webhookDeliveries)
		.where(scope.where(webhookDeliveries, eq(webhookDeliveries.webhookId, row.id)))
		.orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
		.limit(1);
	return viewOf(scope, row, latest ?? null);
}

async function viewOf(
	scope: SiteScope,
	row: WebhookRow,
	lastDelivery: WebhookView["lastDelivery"],
): Promise<WebhookView> {
	const staff = canEdit(scope);
	return {
		id: row.id,
		name: row.name,
		url: staff ? row.url : new URL(row.url).origin,
		events: row.events.filter(isWebhookEvent),
		status: row.enabled ? "on" : "off",
		offReason: row.enabled ? null : row.switchedOffReason === "failing" ? "failing" : "staff",
		failuresInARow: row.failuresInARow,
		secret: staff ? await scope.secrets.describe(signingSecretName(row.id)) : null,
		lastDelivery,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The Site's Webhook with this id, or `WebhookNotFoundError`. */
export async function findWebhook(scope: Pick<SiteScope, "first">, webhookId: string): Promise<WebhookRow> {
	const row = await scope.first(webhooks, eq(webhooks.id, webhookId));
	if (!row) throw new WebhookNotFoundError();
	return row;
}

/**
 * Adds a Webhook, on at once. Its signing secret is the one Staff give, or a new one WebCraft makes,
 * answered once here and never again (only "set" and its last 4 characters show afterwards).
 */
export async function addWebhook(scope: SiteScope, input: NewWebhook): Promise<WebhookWithSecret> {
	const url = webhookUrl(input.url);
	const events = eventsOf(input.events);
	const given = input.secret?.trim() ? givenSecret(input.secret) : null;
	const name = input.name?.trim() || hostOf(url);
	const id = crypto.randomUUID();
	const secret = given ?? newSigningSecret();
	// The secret is stored first, so a Webhook is never without one; it goes again if the Webhook isn't saved.
	await scope.secrets.set(signingSecretName(id), secret);
	try {
		const row = await scope.transaction(async (tx) => {
			// Adds take turns per Site, so two at once can't pass the limit together.
			await lockSiteWebhooks(tx);
			if ((await tx.count(webhooks)) >= MAX_WEBHOOKS_PER_SITE) throw new TooManyWebhooksError(MAX_WEBHOOKS_PER_SITE);
			const now = tx.now();
			const added = await tx.insert(webhooks, { id, name, url, events, createdAt: now, updatedAt: now });
			await tx.audit("webhook.add", { webhookId: id, name, host: hostOf(url), events });
			return added;
		});
		return { webhook: await webhookView(scope, row), secret: given ? null : secret };
	} catch (error) {
		await scope.secrets.remove(signingSecretName(id)).catch(() => {});
		throw error;
	}
}

async function lockSiteWebhooks(scope: Pick<SiteScope, "db" | "site">): Promise<void> {
	await scope.db.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`webcraft:webhooks:${scope.site.id}`}, 0))`,
	);
}
