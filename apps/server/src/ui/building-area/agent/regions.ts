/**
 * The page agent's half of Content typed in place (ADR 0037, BA-07): which of the page's elements are
 * text regions, how each is made editable, and the rules typing in one follows before any Site script
 * sees a key. Saving, the text toolbar, the Undo history and Co-editing are the shell's
 * (`ui/building-area/editing/`); the caret must live in the page, so this part stays in the frame.
 *
 * It runs inside the agent's classic script, before any Site script: everything it uses of the
 * browser is handed to it, kept before the page could change it.
 */
import { TEXT_REGION } from "./contract.ts";

/** What the agent kept of the browser before any Site script ran, as the regions use it. */
export type KeptFunctions = {
	setAttribute: typeof Element.prototype.setAttribute;
	getAttribute: typeof Element.prototype.getAttribute;
	matches: typeof Element.prototype.matches;
	closest: typeof Element.prototype.closest;
	querySelectorAll: typeof Element.prototype.querySelectorAll;
	preventDefault: typeof Event.prototype.preventDefault;
	execCommand: typeof Document.prototype.execCommand;
};

export type PageRegions = {
	/** Makes the text regions among `nodes` (and their descendants) editable, once each. */
	adopt(nodes: readonly Node[]): void;
	/** Whether a region takes formatting (rich text) rather than one line of plain text. */
	isRichText(region: Element): boolean;
	/** The region an event's target is in, or null. */
	regionOf(target: EventTarget | null): Element | null;
	/**
	 * The rules of typing in a region, applied as the agent sees the event (capture phase, first):
	 * plain text is one line, and what is pasted into it is text only.
	 */
	rules(kind: "keydown" | "paste", event: Event): void;
};

export function pageRegions(win: Window & typeof globalThis, kept: KeptFunctions): PageRegions {
	const doc = win.document;
	const { setAttribute, getAttribute, matches, closest, querySelectorAll, preventDefault, execCommand } = kept;

	/** How plain text regions are made editable: `plaintext-only` where the browser has it. */
	const plainTextOnly = (() => {
		try {
			const probe = doc.createElement("div");
			probe.contentEditable = "plaintext-only";
			return probe.contentEditable === "plaintext-only";
		} catch {
			return false;
		}
	})();

	const isRichText = (region: Element) => getAttribute.call(region, "data-wc-type") === "richText";

	const regionOf = (target: EventTarget | null): Element | null =>
		target instanceof win.Element ? closest.call(target, TEXT_REGION) : null;

	return {
		adopt(nodes) {
			for (const node of nodes) {
				if (!(node instanceof win.Element)) continue;
				const found = [...(matches.call(node, TEXT_REGION) ? [node] : []), ...querySelectorAll.call(node, TEXT_REGION)];
				for (const region of found) {
					if (getAttribute.call(region, "contenteditable") !== null) continue;
					setAttribute.call(
						region,
						"contenteditable",
						isRichText(region) || !plainTextOnly ? "true" : "plaintext-only",
					);
					setAttribute.call(region, "spellcheck", "true");
				}
			}
		},
		isRichText,
		regionOf,
		rules(kind, event) {
			const region = regionOf(event.target);
			if (!region || isRichText(region)) return;
			// Plain text is one line: Enter finishes nothing here (the shell's Escape and Tab do).
			if (kind === "keydown" && (event as KeyboardEvent).key === "Enter") {
				preventDefault.call(event);
				return;
			}
			// Plain text takes text only, whatever the clipboard holds (`plaintext-only` does this itself).
			if (kind === "paste" && getAttribute.call(region, "contenteditable") !== "plaintext-only") {
				preventDefault.call(event);
				const text = (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
				execCommand.call(doc, "insertText", false, text.replace(/[\r\n]+/g, " "));
			}
		},
	};
}
