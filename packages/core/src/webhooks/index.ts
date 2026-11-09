import type { SiteScope } from "../tenancy/data-layer.ts";
import { addWebhook, listWebhooks, type NewWebhook, type WebhookView, type WebhookWithSecret } from "./webhooks.ts";

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
export { WEBHOOK_HEADERS } from "./signing.ts";
export {
	MAX_WEBHOOKS_PER_SITE,
	type NewWebhook,
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
};

export function createWebhooks(): Webhooks {
	return {
		list: listWebhooks,
		add: addWebhook,
	};
}
