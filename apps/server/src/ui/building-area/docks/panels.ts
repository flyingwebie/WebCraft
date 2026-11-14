import type { PanelDefault } from "./layout.ts";

/**
 * The building area's panels (SPEC 5): where each starts, and the context rule under which it shows.
 * A panel is drawn when its switch in the Panels menu is on and its rule holds. Each later part of the
 * building area fills its panel; until then a panel is an empty frame with its title.
 */

/** What the selection on the canvas is, for the panels' rules. */
export type SelectionKind = "element" | "loop" | "condition" | "placement";

/** What kind of document is open, for the panels' rules. */
export type DocumentKind = "page" | "entry" | "template" | "component" | "form";

/** What the panels' rules read. */
export type PanelContext = {
	/** The selection on the canvas: what it is and its name (`h1 · Heading`), or nothing. */
	selection: { kind: SelectionKind; name: string } | null;
	/** The open document. */
	document: DocumentKind;
	/** Whether a Component is being edited in place. */
	componentInPlace: boolean;
};

/** The panels' keys, as `buildingArea.dockPanels` names them. */
export type PanelKey = "layers" | "inspector" | "entry" | "component" | "html" | "css" | "js";

export type PanelDefinition = PanelDefault & {
	id: PanelKey;
	/** Whether the panel has a place to show now, whatever its switch says. */
	shows(context: PanelContext): boolean;
};

/** Every panel, in the order of the Panels menu and of each dock's defaults. */
export const PANELS: readonly PanelDefinition[] = [
	// Layers: always, for Staff (Members get the Sections panel instead).
	{ id: "layers", dock: "right", shows: () => true },
	// The Inspector: when something is selected.
	{ id: "inspector", dock: "right", shows: (context) => context.selection !== null },
	// Entry fields: when the open document is a Page or an Entry; collapsed under Layers until opened.
	{
		id: "entry",
		dock: "right",
		collapsed: true,
		shows: (context) => context.document === "page" || context.document === "entry",
	},
	// The Component: while one is edited in place.
	{ id: "component", dock: "left", shows: (context) => context.componentInPlace },
	// HTML, CSS and JS: when something is selected; CSS for elements only (a Loop, a Condition or a
	// Placement gets HTML and JS).
	{ id: "html", dock: "bottom", shows: (context) => context.selection !== null },
	{ id: "css", dock: "bottom", shows: (context) => context.selection?.kind === "element" },
	{ id: "js", dock: "bottom", shows: (context) => context.selection !== null },
];

/** A panel's definition by its key. */
export function panelOf(id: string): PanelDefinition | undefined {
	return PANELS.find((panel) => panel.id === id);
}
