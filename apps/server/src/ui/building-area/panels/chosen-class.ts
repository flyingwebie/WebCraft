import { useCallback, useSyncExternalStore } from "react";

/**
 * The Class chosen among the selected element's (BA-08's Inspector chips, BA-11's CSS pane): "CSS edits
 * the chosen one". The Inspector and the CSS pane show the same choice, and either may change it. It is
 * kept per selection, so selecting another element starts from its first Class again.
 */

let chosen: { ref: string; classId: string } | null = null;
const listeners = new Set<() => void>();

/** Follows the choice (outside React: the CSS pane's own state). */
export function subscribeChosenClass(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Chooses a Class of the element a selection reference names. */
export function chooseClass(ref: string, classId: string): void {
	if (chosen?.ref === ref && chosen.classId === classId) return;
	chosen = { ref, classId };
	for (const listener of listeners) listener();
}

/** The chosen Class of an element: the one chosen for it if it still has it, else its first. */
export function chosenClassOf(ref: string, classes: readonly string[]): string | null {
	if (chosen?.ref === ref && classes.includes(chosen.classId)) return chosen.classId;
	return classes[0] ?? null;
}

/** The chosen Class of the selected element, and how to choose another. */
export function useChosenClass(ref: string, classes: readonly string[]): [string | null, (classId: string) => void] {
	const now = useSyncExternalStore(subscribeChosenClass, () => chosenClassOf(ref, classes));
	const choose = useCallback((classId: string) => chooseClass(ref, classId), [ref]);
	return [now, choose];
}
