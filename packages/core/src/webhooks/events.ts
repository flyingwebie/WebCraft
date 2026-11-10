import type { AuditDetails } from "../audit.ts";

/**
 * The events a Webhook can receive: Staff tick them, and each is the `type` of the body sent. A
 * feature adding one adds its key here and queues it with `services.webhooks.queueEvent` once its
 * change is saved; its data holds no secret, and no Content values unless the spec says so.
 *
 * - `publish`: something on the Site was published (an Entry, a Page, the Globals, a Template, a
 *   Component, a script, a Form, a Form's emails, a Loop or the Design system).
 * - `unpublish`: an Entry stopped showing (a Scheduled publish unpublished it): its data is the Entry
 *   (`kind`, `id`, `postTypeId`) and where it was (`paths`, each `{ language, path }`), which answer
 *   410 Gone from then on. A Page unpublished with the one above it sends its own event.
 * - `formSubmitted`: a visitor sent a Form and its Submission was kept (never spam; also when it is
 *   taken out of the Spam folder). Its data is the Form (`id`, `key`, `name`) and the Submission
 *   (`id`, `language`, `page`, `receivedAt`, and its `values`, each `{ key, label, type, value }`):
 *   the spec sends a Submission's values (story 99), so other systems get the lead.
 */
export const WEBHOOK_EVENTS = ["publish", "unpublish", "formSubmitted"] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** The `type` of a test send's body (Send test); no Webhook subscribes to it. */
export const TEST_EVENT = "test";

export function isWebhookEvent(value: string): value is WebhookEvent {
	return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * What a publish published, as the `publish` event names it: the item's kind (`entry`, `template`,
 * `component`, `script`, `globals`, `form`, `loop`, `designSystem`, and every kind publishing gains)
 * and id; an Entry's Post Type and path, and a Template's Post Type.
 */
export type PublishedItem =
	| { kind: "entry"; id: string; postTypeId: string; path: string | null }
	| { kind: "template"; id: string; postTypeId: string | null }
	| { kind: string; id: string };

/** A published path that the publish changed, as `Published.pathChanges` lists them. */
type PathChange = { entryId: string; language: string; from: string; to: string };

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * A publish, as the Audit log names it: `<item>.publish`, such as `entry.publish` or `form.publish`,
 * with the item's id as `<item>Id` in its details. A Module's own actions have three parts
 * (`sample.note.add`), so they never match.
 */
const PUBLISH_ACTION = /^([a-z][A-Za-z]*)\.publish$/;

/**
 * What an Audit log action published, or null when it isn't a publish. The publish event is queued
 * from it once the publish is saved (after its transaction commits), whatever published it, so a
 * new kind of item fires it without a change here.
 */
export function publishedBy(
	action: string,
	details: AuditDetails,
): { item: PublishedItem; pathChanges: PathChange[] } | null {
	// AI translation publishing an item's translated values publishes that item (`translation.publish`).
	if (action === "translation.publish") {
		const item = (details.item ?? {}) as Record<string, unknown>;
		const kind = item.kind === "formEmails" ? "formEmails" : text(item.kind);
		if (!kind) return null;
		if (kind === "entry") {
			return { item: { kind, id: text(item.id), postTypeId: text(item.postTypeId), path: null }, pathChanges: [] };
		}
		return { item: { kind, id: text(item.id) }, pathChanges: [] };
	}
	const kind = PUBLISH_ACTION.exec(action)?.[1];
	if (!kind) return null;
	const id = text(details[`${kind}Id`]);
	if (kind === "entry") {
		return {
			item: { kind, id, postTypeId: text(details.postTypeId), path: textOrNull(details.path) },
			pathChanges: Array.isArray(details.pathChanges) ? (details.pathChanges as PathChange[]) : [],
		};
	}
	if (kind === "template") return { item: { kind, id, postTypeId: textOrNull(details.postTypeId) }, pathChanges: [] };
	return { item: { kind, id }, pathChanges: [] };
}

/**
 * What an Audit log action unpublished, or null when it isn't an unpublish (`entry.unpublish`): the
 * Entry and where it was, each path within its language.
 */
export function unpublishedBy(
	action: string,
	details: AuditDetails,
): { item: { kind: "entry"; id: string; postTypeId: string }; paths: { language: string; path: string }[] } | null {
	if (action !== "entry.unpublish") return null;
	const paths = Array.isArray(details.paths)
		? (details.paths as unknown[]).flatMap((each) => {
				const { language, path } = (each ?? {}) as Record<string, unknown>;
				return typeof language === "string" && typeof path === "string" ? [{ language, path }] : [];
			})
		: [];
	return { item: { kind: "entry", id: text(details.entryId), postTypeId: text(details.postTypeId) }, paths };
}
