import { webhookDeliveries, webhooks } from "@webcraft/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";

import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { can } from "../permissions/can.ts";
import type { SecretDescription } from "../secrets/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { stopDeliveries, waitingDeliveries } from "./deliveries.ts";
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

/** The Site's Webhook with this id, locked for a change in `scope`'s transaction. */
export async function lockWebhook(scope: Pick<SiteScope, "db" | "where">, webhookId: string): Promise<WebhookRow> {
	const [row] = await scope.db
		.select()
		.from(webhooks)
		.where(scope.where(webhooks, eq(webhooks.id, webhookId)))
		.for("update");
	if (!row) throw new WebhookNotFoundError();
	return row;
}

/**
 * Switches a Webhook on or off. Switched off, it receives nothing: deliveries still waiting for an
 * attempt are stopped (failed, to redeliver once it is on again). Switched on, its count of failures
 * in a row starts again.
 */
export async function setWebhookEnabled(scope: SiteScope, webhookId: string, enabled: boolean): Promise<WebhookView> {
	const row = await scope.transaction(async (tx) => {
		const current = await lockWebhook(tx, webhookId);
		if (current.enabled === enabled) return current;
		const now = tx.now();
		const [updated] = await tx.update(
			webhooks,
			enabled
				? { enabled, switchedOffReason: null, failuresInARow: 0, updatedAt: now }
				: { enabled, switchedOffReason: null, switchedOffAt: now, updatedAt: now },
			eq(webhooks.id, current.id),
		);
		if (!enabled) await stopDeliveries(tx, await waitingDeliveries(tx, current.id));
		await tx.audit(enabled ? "webhook.switchOn" : "webhook.switchOff", { webhookId: current.id, name: current.name });
		return updated ?? current;
	});
	return webhookView(scope, row);
}

/** A change to a Webhook: its name (the URL's host when empty), URL and events, all given. */
export type WebhookChange = { name?: string | undefined; url: string; events: readonly string[] };

/** Changes a Webhook's name, URL and events at once; deliveries waiting for an attempt go to the new URL. */
export async function updateWebhook(scope: SiteScope, webhookId: string, change: WebhookChange): Promise<WebhookView> {
	const url = webhookUrl(change.url);
	const events = eventsOf(change.events);
	const name = change.name?.trim() || hostOf(url);
	const row = await scope.transaction(async (tx) => {
		const current = await lockWebhook(tx, webhookId);
		const changed = [
			...(current.name !== name ? ["name"] : []),
			...(current.url !== url ? ["url"] : []),
			...(current.events.join() !== events.join() ? ["events"] : []),
		];
		if (changed.length === 0) return current;
		const [updated] = await tx.update(
			webhooks,
			{ name, url, events, updatedAt: tx.now() },
			eq(webhooks.id, current.id),
		);
		await tx.audit("webhook.update", { webhookId: current.id, name, host: hostOf(url), events, changed });
		return updated ?? current;
	});
	return webhookView(scope, row);
}

/**
 * Replaces a Webhook's signing secret with the one Staff give, or a new one WebCraft makes (answered
 * once). Every attempt from now on is signed with it.
 */
export async function changeWebhookSecret(
	scope: SiteScope,
	webhookId: string,
	secret: string | undefined,
): Promise<WebhookWithSecret> {
	const given = secret?.trim() ? givenSecret(secret) : null;
	const value = given ?? newSigningSecret();
	const row = await scope.transaction(async (tx) => {
		const current = await lockWebhook(tx, webhookId);
		await tx.update(webhooks, { updatedAt: tx.now() }, eq(webhooks.id, current.id));
		await tx.audit("webhook.changeSecret", { webhookId: current.id, name: current.name });
		return current;
	});
	await scope.secrets.set(signingSecretName(row.id), value);
	return { webhook: await webhookView(scope, row), secret: given ? null : value };
}

/** What removing a Webhook would remove, and the confirmation to send back; or that it was removed. */
export type WebhookRemoval =
	| {
			removed: false;
			preview: { name: string; url: string; deliveries: number };
			confirmation: Confirmation;
	  }
	| { removed: true };

/**
 * Removes a Webhook in two steps: without `confirmation` it answers what would go (its name, URL and
 * how many deliveries its log holds) with a confirmation id; with it, the Webhook, its delivery log
 * and its signing secret go at once.
 */
export async function removeWebhook(
	scope: SiteScope,
	webhookId: string,
	confirmation?: string,
): Promise<WebhookRemoval> {
	const asked = await scope.transaction(async (tx) => {
		const row = await lockWebhook(tx, webhookId);
		const deliveries = await tx.count(webhookDeliveries, eq(webhookDeliveries.webhookId, row.id));
		const preview = { name: row.name, url: row.url, deliveries };
		const request = { action: "webhook.remove", target: row.id, preview };
		if (confirmation === undefined) {
			return { removed: false as const, preview, confirmation: await askConfirmation(tx, request) };
		}
		await useConfirmation(tx, confirmation, request);
		await tx.delete(webhooks, eq(webhooks.id, row.id));
		await tx.audit("webhook.remove", { webhookId: row.id, name: row.name, host: hostOf(row.url) });
		return null;
	});
	if (asked) return asked;
	await scope.secrets.remove(signingSecretName(webhookId));
	return { removed: true };
}
