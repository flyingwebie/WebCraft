import type { MadeComponent } from "@webcraft/core";
import type { Json } from "@webcraft/core/draft-document";
import type { EditorHistory, HistoryLocation } from "./editor-history.ts";

/** Record the transaction's source delta, never a later document that may include peer writes. */
export function recordSourceHistory(
	history: EditorHistory,
	change: MadeComponent["sourceChange"],
	label: string,
	location: HistoryLocation,
	step: number,
) {
	const resource = `draft:${location.siteId}:${change.kind}:${change.id}`;
	history.record({
		resource,
		before: (change.kind === "component" ? { tree: change.before } : change.before) as unknown as Json,
		after: (change.kind === "component" ? { tree: change.after } : change.after) as unknown as Json,
		label,
		location: { ...location, draft: resource, resource },
		step,
	});
}
