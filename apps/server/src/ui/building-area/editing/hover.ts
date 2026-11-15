/**
 * What is under the pointer across the views (BA-33, the old `code-selection` hover): a row of Layers
 * under the pointer outlines its element on the canvas (dashed), and an element of the page under the
 * pointer marks its row in Layers. Hovering never changes the selection, nor anything being typed.
 * One reference at a time, by the Structure's references (`data-wc-code`), with where it came from.
 */

export type Hovered = { ref: string; from: "tree" | "canvas" } | null;

let hovered: Hovered = null;
const listeners = new Set<() => void>();

export function hover(ref: string | null, from: "tree" | "canvas"): void {
	const next: Hovered = ref ? { ref, from } : null;
	// Leaving a row clears only what that view set.
	if (!next && hovered && hovered.from !== from) return;
	if (next?.ref === hovered?.ref && next?.from === hovered?.from) return;
	hovered = next;
	for (const listener of listeners) listener();
}

export function hoveredNow(): Hovered {
	return hovered;
}

export function subscribeHover(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
