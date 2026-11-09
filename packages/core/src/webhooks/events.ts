import type { AuditDetails } from "../audit.ts";

/**
 * The events a Webhook can receive: Staff tick them, and each is the `type` of the body sent. A
 * feature adding one (Forms' `formSubmitted`) adds its key here and queues it with
 * `services.webhooks.queueEvent` once its change is saved; its data holds no secret, and no Content
 * values unless the spec says so.
 *
 * - `publish`: something on the Site was published (an Entry, a Page, the Globals, a Template, a
 *   Component, a script or the Design system).
 */
export const WEBHOOK_EVENTS = ["publish"] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** The `type` of a test send's body (Send test); no Webhook subscribes to it. */
export const TEST_EVENT = "test";

export function isWebhookEvent(value: string): value is WebhookEvent {
	return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** What a publish published, as the `publish` event names it: the item's kind and id, and where an Entry is. */
export type PublishedItem =
	| { kind: "entry"; id: string; postTypeId: string; path: string | null }
	| { kind: "template"; id: string; postTypeId: string | null }
	| { kind: "component" | "script" | "globals" | "designSystem"; id: string };

/** A published path that the publish changed, as `Published.pathChanges` lists them. */
type PathChange = { entryId: string; language: string; from: string; to: string };

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The Audit log entries that are a publish, and what each published. The publish event is queued
 * from them once the publish is saved (after its transaction commits), whatever published it.
 */
const PUBLISHES: Record<string, (details: AuditDetails) => { item: PublishedItem; pathChanges: PathChange[] }> = {
	"entry.publish": (details) => ({
		item: {
			kind: "entry",
			id: text(details.entryId),
			postTypeId: text(details.postTypeId),
			path: textOrNull(details.path),
		},
		pathChanges: Array.isArray(details.pathChanges) ? (details.pathChanges as PathChange[]) : [],
	}),
	"template.publish": (details) => ({
		item: { kind: "template", id: text(details.templateId), postTypeId: textOrNull(details.postTypeId) },
		pathChanges: [],
	}),
	"component.publish": (details) => ({ item: { kind: "component", id: text(details.componentId) }, pathChanges: [] }),
	"script.publish": (details) => ({ item: { kind: "script", id: text(details.scriptId) }, pathChanges: [] }),
	"globals.publish": (details) => ({ item: { kind: "globals", id: text(details.globalsId) }, pathChanges: [] }),
	"designSystem.publish": (details) => ({
		item: { kind: "designSystem", id: text(details.designSystemId) },
		pathChanges: [],
	}),
};

/** What an Audit log action published, or null when it isn't a publish. */
export function publishedBy(
	action: string,
	details: AuditDetails,
): { item: PublishedItem; pathChanges: PathChange[] } | null {
	const read = Object.hasOwn(PUBLISHES, action) ? PUBLISHES[action] : undefined;
	return read ? read(details) : null;
}
