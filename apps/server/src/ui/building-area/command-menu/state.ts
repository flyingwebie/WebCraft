/**
 * The building area's Command menu (BA-10; SPEC 2 and 6, `builder/09`): what opens it and at what.
 * Kept apart from the menu's own file, which loads the first time it is opened (`loader.tsx`).
 */

/** The menu's tabs, in order, each with its key: Actions ⌘K, Go to ⌘P, Insert ⌘I. */
export type MenuTab = "actions" | "goTo" | "insert";

/** A question Insert asks before it inserts (which Loop, the Condition's test, which Form). */
export type InsertQuestion = "loop" | "condition" | "form";

/** What the menu opens at. */
export type MenuRequest = {
	tab: MenuTab;
	/** Insert asks this question at once (the insert row's Loop and Condition). */
	step?: InsertQuestion;
	/** Insert lists only the Components (the insert row's Component button, the empty Page's Add a Component). */
	only?: "components";
	/** ⌘ was held as the menu was opened from the row: Insert starts on After. */
	forceAfter?: boolean;
};

/**
 * The event that opens the menu from outside the shell's own keys (`detail`: a `MenuRequest`): the
 * page in the frame forwards ⌘K, ⌘P and ⌘I through its agent (`editing/editing.ts`), and the empty
 * Page's buttons ask for Insert.
 */
export const COMMAND_MENU_EVENT = "webcraft:command-menu";

/** Asks the shell's Command menu to open at a tab (or a question). */
export function openCommandMenu(request: MenuRequest): void {
	document.dispatchEvent(new CustomEvent(COMMAND_MENU_EVENT, { detail: request }));
}
