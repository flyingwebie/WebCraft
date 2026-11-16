import type { ElementTree, Expression, TreeNode } from "@webcraft/renderer/builder";
import type { ShellConfig, Words } from "../api.ts";
import type { Icon } from "../controls.tsx";
import type { BuildingDocument } from "../documents.ts";
import type { Inserter, InsertKind } from "../editing/insert.ts";
import type { LayerOps } from "../editing/layer-ops.ts";
import type { Structure, StructureSnapshot } from "../editing/selection.ts";

/**
 * What the Command menu can do in the shell it opens in (BA-10): the shell gives it these, and the
 * menu's own file (`CommandMenu.tsx`, fetched the first time it opens) makes its Actions, Go to and
 * Insert from them. Staff get the whole menu; a Member gets the shorter one (SPEC 13.9): Actions and
 * Go to, in their own words, no Insert.
 */
export type MenuHost = {
	config: ShellConfig;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	/** The tab's one Undo history, as the bar's Undo and Redo use it. */
	history: {
		undo(): void | Promise<void>;
		redo(): void | Promise<void>;
		state(): { undo: string | null; redo: string | null; busy: boolean };
	};
	/** Opens the bar's Publish (its sheet or confirmation); never publishes at once. */
	publish(): void;
	/** The places this person may open, and the one open now. */
	places: readonly { key: string; name: string }[];
	place: string | null;
	openPlace(key: string): void;
	leavePlace(): void;
	/** Opens a document on the canvas (Go to). */
	open(document: BuildingDocument): void;
	exit(): void;
	/**
	 * The Permissions the menu draws by, when not those the server says the person holds: Staff seeing
	 * the page as a client (FX-04) get the menu of the role they view it as.
	 */
	permissions?: readonly string[];
	/** Staff: Hide the interface (the rail's switch). */
	hidden?: { on: boolean; set(on: boolean): void };
	/** A Member: Edit or Preview, Page details, Sections (where they may arrange), Help. */
	member?: {
		preview: { on: boolean; set(on: boolean): void };
		pageDetails(): void;
		sections: (() => void) | null;
		help(): void;
	};
	/** Staff: the page's Structure, what changes it, and inserting. */
	staff?: {
		structure: Structure;
		ops: LayerOps;
		inserter: Inserter;
		/** Edits the selected Placement's Component in place, when one is selected. */
		editComponent: (() => void) | null;
		/** Hides or shows the selected Page Placement, when one is selected. */
		toggleHidden: { hidden: boolean; run(): void } | null;
		/** Asks for a name, then moves the selection into a new Component (Make Component). */
		makeComponent(): void;
		/** Asks for a name, then places a new, empty Component where Insert would (New Component). */
		newComponent(): void;
		/** The element tree's helpers, from Staff's first file, so the menu's own file needn't carry them. */
		parts: {
			icons: Record<InsertKind, Icon>;
			tags: Record<InsertKind, string>;
			anchorName(snapshot: StructureSnapshot, ref: string): string;
			childLists(node: TreeNode): readonly (readonly TreeNode[])[];
			newElement(tree: ElementTree, tag: string): TreeNode;
			withNewIds(tree: ElementTree, nodes: readonly TreeNode[]): TreeNode[];
			readExpression(text: string): { expression: Expression } | { problem: { message: string } };
		};
	};
};
