import { CheckIcon, CircleDotIcon, ClockIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";

import { fill, type Words } from "../api.ts";
import type { Icon } from "../controls.tsx";

/**
 * The Draft state beside Publish (SPEC 10, `docking/08`): "Saved", "Saving…", "Draft · N changes",
 * "In review", "Could not save". N is the open document's changed items.
 */
export type DraftState =
	| { kind: "saved" }
	| { kind: "saving" }
	| { kind: "changes"; count: number }
	| { kind: "review" }
	| { kind: "failed" };

const LOOK: Record<DraftState["kind"], { icon: Icon; colour: string; text: string }> = {
	saved: { icon: CheckIcon, colour: "text-chrome-muted", text: "text-chrome-muted" },
	saving: { icon: LoaderIcon, colour: "text-chrome-muted", text: "text-chrome-muted" },
	changes: { icon: CircleDotIcon, colour: "text-chrome-warn", text: "text-chrome-warn" },
	review: { icon: ClockIcon, colour: "text-chrome-accent", text: "text-chrome-muted" },
	failed: { icon: TriangleAlertIcon, colour: "text-chrome-danger", text: "text-chrome-danger" },
};

/** The state's words, in the person's Admin language. */
export function draftStateText(state: DraftState, words: Words, language: string): string {
	const each = words.draftState;
	switch (state.kind) {
		case "saved":
			return each.saved;
		case "saving":
			return each.saving;
		case "review":
			return each.review;
		case "failed":
			return each.failed;
		case "changes": {
			const form = new Intl.PluralRules(language).select(state.count) === "one" ? "one" : "other";
			return fill(each.changes[form], { count: String(state.count) });
		}
	}
}

/**
 * What the Draft state says, from what is known of the page: a save under way or failed wins; then a
 * Review waiting; then the page's changes, if it has any.
 */
export function draftStateOf(
	saving: "idle" | "saving" | "failed",
	page: { changes: number; inReview: boolean } | null,
): DraftState {
	if (saving === "saving") return { kind: "saving" };
	if (saving === "failed") return { kind: "failed" };
	if (page?.inReview) return { kind: "review" };
	if (page && page.changes > 0) return { kind: "changes", count: page.changes };
	return { kind: "saved" };
}

/** The Draft state's cell: an icon and its words, never a control. */
export function DraftStateCell({ state, words, language }: { state: DraftState; words: Words; language: string }) {
	const look = LOOK[state.kind];
	const Glyph = look.icon;
	return (
		<p
			className="m-0 flex h-7 shrink-0 items-center gap-1.5 px-2 text-[12px] font-medium whitespace-nowrap"
			data-wc-draft-state={state.kind}
		>
			<span className="sr-only">{`${words.draftState.label}: `}</span>
			<Glyph aria-hidden="true" className={`size-3.5 ${look.colour}`} />
			<span className={look.text}>{draftStateText(state, words, language)}</span>
		</p>
	);
}
