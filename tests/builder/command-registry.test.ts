// The Command menu's registry (#131) as other features build on it (#134, #139): each command
// declares the Permission it needs on the canvas it runs on (ADR 0028), and the menu hides what
// can() doesn't allow. Publishing in the Builder publishes Structure (`structure.edit`); Code mode's
// Publish publishes the page's Content (`entry.publish`).
import { expect, test } from "bun:test";
import { createTranslator } from "use-intl";

import en from "../../apps/server/src/messages/en.json";
import {
	type Canvas,
	type EditorCommandTarget,
	editorCommands,
	visibleCommands,
} from "../../apps/server/src/ui/builder/commands.ts";

const t = createTranslator({ locale: "en", messages: en }) as unknown as Parameters<typeof editorCommands>[1];

function target(canvas: Canvas): EditorCommandTarget {
	const nothing = () => {};
	return {
		canvas,
		selection: null,
		history: { undo: nothing, redo: nothing, canUndo: () => false, canRedo: () => false },
		save: nothing,
		publish: nothing,
		layer: nothing,
	};
}

function actionsFor(canvas: Canvas, held: readonly string[]): string[] {
	return visibleCommands(editorCommands(target(canvas), t), {
		tab: "actions",
		canvas,
		can: (permission) => held.includes(permission),
		query: "",
		recent: [],
	}).results.map((command) => command.id);
}

test("the Builder's Publish needs structure.edit; Code mode's needs entry.publish", () => {
	const builder = editorCommands(target("builder"), t).find((command) => command.id === "publish");
	const code = editorCommands(target("code"), t).find((command) => command.id === "publish");
	expect(builder?.permission).toBe("structure.edit");
	expect(code?.permission).toBe("entry.publish");

	// Someone holding entry.publish without structure.edit (a role that may come later) never sees it.
	expect(actionsFor("builder", ["entry.publish"])).not.toContain("publish");
	expect(actionsFor("builder", ["structure.edit"])).toContain("publish");
	expect(actionsFor("code", ["structure.edit"])).not.toContain("publish");
	expect(actionsFor("code", ["structure.edit", "entry.publish"])).toContain("publish");
});
