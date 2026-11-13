import type { CommandMenuData } from "@webcraft/core";

import type { BarCommands } from "../../site/edit-bar/kit.ts";
import { type Canvas, type Command, type HistoryTarget, historyCommands } from "../builder/commands.ts";
import { destinationCommands, type GoToTarget } from "../builder/go-to.ts";
import type { useT } from "../i18n.tsx";
import {
	HEADER_ROW,
	type LayoutAction,
	type LayoutRefusal,
	type PageLayoutController,
} from "../page-layouts/controller.ts";

type T = ReturnType<typeof useT>;

/** What Edit mode's menu reads from the Site (`commandMenu`): the menu's data, and where the Builder is. */
export type EditMenuData = CommandMenuData & { siteId: string; adminOrigin: string };

/** Edit mode's own commands show nowhere else. */
const EDIT: readonly Canvas[] = ["edit"];

/**
 * The Placement selected in the Page layout, where the person may arrange the page now: its id and
 * what the layout says of it. Null in Preview, without a Page layout, or on the header or footer.
 */
function selectedPlacement(layout: PageLayoutController | null) {
	if (!layout || !arranging(layout)) return null;
	const { data, selected } = layout.state();
	return data.placements.find((placement) => placement.id === selected) ?? null;
}

/** Whether the person may arrange the page's layout now (never in Preview, or where arranging is off). */
export function arranging(layout: PageLayoutController | null): boolean {
	return !!layout?.state().editing;
}

/** Why the Page layout refuses an action, in words, where there is something to tell: a save under way passes. */
function refusalWords(t: T, refusal: LayoutRefusal | null): string | undefined {
	if (refusal === "locked") return t("pageLayout.locked");
	if (refusal === "besideLocked") return t("builder.commandMenu.editMode.besideLocked");
	if (refusal === "notAllowed") return t("builder.commandMenu.editMode.notAllowed");
	return undefined;
}

/**
 * Edit mode's Actions (#139). For the page: Save Draft, Publish (or Send to Review for those who can't
 * publish), Undo and Redo, Preview, and leaving; in Preview, what still applies. For the selected
 * Placement, where the person may arrange the page: Props, Move up and down, Duplicate, Hide and
 * Remove, each through the Page layout's own controller, which decides what is allowed.
 */
export function editActions(
	t: T,
	target: { bar: BarCommands; editing: boolean; history: HistoryTarget; layout: PageLayoutController | null },
): Command[] {
	const { bar, editing, history, layout } = target;
	const page = { tab: "actions", group: t("builder.commandMenu.groups.page"), canvases: EDIT } as const;
	const words = (key: string) => key.split(" ").filter(Boolean);
	const commands: Command[] = [];
	if (editing)
		commands.push({
			...page,
			id: "save",
			label: t("builder.commandMenu.actions.save"),
			keywords: words(t("builder.commandMenu.keywords.save")),
			shortcut: "editor.save",
			permission: "entry.edit",
			run: () => bar.save(),
		});
	commands.push(
		{
			...page,
			id: "publish",
			label: t("builder.commandMenu.actions.publish"),
			keywords: words(t("builder.commandMenu.keywords.publish")),
			permission: "entry.publish",
			// The bar's Publish menu opens: nothing is published at once.
			run: () => bar.publish(),
		},
		{
			...page,
			id: "sendToReview",
			label: t("builder.commandMenu.actions.sendToReview"),
			keywords: words(t("builder.commandMenu.keywords.sendToReview")),
			permission: "entry.edit",
			without: "entry.publish",
			run: () => bar.publish(),
		},
	);
	if (editing)
		commands.push(
			...historyCommands(history, t, { group: page.group, permission: "entry.edit", canvases: EDIT }, true),
		);
	commands.push(
		editing
			? {
					...page,
					id: "preview",
					label: t("builder.commandMenu.actions.preview"),
					keywords: words(t("builder.commandMenu.keywords.preview")),
					permission: "site.view",
					run: () => bar.edit(false),
				}
			: {
					...page,
					id: "edit",
					label: t("builder.commandMenu.actions.edit"),
					keywords: words(t("builder.commandMenu.keywords.edit")),
					permission: "entry.edit",
					run: () => bar.edit(true),
				},
		{
			...page,
			id: "leave",
			label: t("builder.commandMenu.actions.leave"),
			keywords: words(t("builder.commandMenu.keywords.leave")),
			permission: "site.view",
			run: () => bar.leave(),
		},
	);

	const placement = selectedPlacement(layout);
	if (!layout || !placement) return commands;
	const on = {
		tab: "actions",
		group: t("builder.commandMenu.groups.placement"),
		permission: "entry.edit",
		canvases: EDIT,
	} as const;
	// A locked Placement keeps its place for everyone who can't unlock it; its Props stay theirs to edit.
	// What the Page layout refuses is listed all the same, off, with the layout's own reason.
	const act = (action: LayoutAction, label: string, keywords: string, more: Partial<Command> = {}): Command => {
		const refusal = layout.refusal(action, placement.id);
		const reason = refusalWords(t, refusal);
		return {
			...on,
			id: `placement-${action}`,
			label,
			keywords: words(keywords),
			disabled: refusal !== null,
			...(reason ? { reason } : {}),
			run: async () => {
				await layout.action(action, placement.id);
			},
			...more,
		};
	};
	commands.push(
		{
			...on,
			id: "placement-props",
			label: t("pageLayout.props"),
			keywords: words(t("builder.commandMenu.keywords.props")),
			run: () => layout.openProps(),
		},
		act("moveUp", t("pageLayout.moveUp"), t("builder.commandMenu.keywords.moveUp"), { shortcut: "tree.moveUp" }),
		act("moveDown", t("pageLayout.moveDown"), t("builder.commandMenu.keywords.moveDown"), {
			shortcut: "tree.moveDown",
		}),
		act("duplicate", t("pageLayout.duplicate"), t("builder.commandMenu.keywords.duplicate")),
		act(
			"hide",
			placement.hidden
				? t("builder.commandMenu.actions.showPlacement")
				: t("builder.commandMenu.actions.hidePlacement"),
			t("builder.commandMenu.keywords.hidePlacement"),
		),
		act("delete", t("pageLayout.delete"), t("builder.commandMenu.keywords.delete")),
	);
	return commands;
}

/**
 * Edit mode's Go to (#139): Pages and Entries of the Site (and, for those who may change Structure,
 * Templates and Components), then, while the page is being edited, its Placements by their Page layout
 * drawer label, for everyone who may edit it, arranging or not. Picking a Placement selects it, which
 * scrolls to it. In Preview nothing is selected, so there are none to go to.
 */
export function editGoTo(
	t: T,
	data: EditMenuData,
	target: { layout: PageLayoutController | null; editing: boolean },
	go: Pick<GoToTarget, "page" | "builder"> & { selected(label: string): void },
): Command[] {
	const commands = destinationCommands(t, data, go);
	const { layout, editing } = target;
	if (!layout || !editing) return commands;
	const group = t("builder.commandMenu.groups.placements");
	for (const placement of layout.state().data.placements) {
		const label = layout.label(placement.id);
		commands.push({
			id: `placement:${placement.id}`,
			tab: "goTo",
			group,
			label,
			keywords: [],
			permission: "entry.edit",
			canvases: EDIT,
			run: () => {
				layout.select(placement.id);
				go.selected(label);
			},
		});
	}
	return commands;
}

/**
 * Edit mode's Insert (#139): the Components the Page layout lets this person place (Allowed components,
 * for Members), put after the selected Placement by the Page layout's own controller. Null where the
 * person may not arrange the page: there is no Insert there.
 */
export function editInserts(
	t: T,
	layout: PageLayoutController | null,
): { commands: Command[]; where: string; empty: string } | null {
	if (!layout || !arranging(layout)) return null;
	const { data, busy } = layout.state();
	const group = t("builder.insert.groups.components");
	// Where the Page layout itself puts a new Placement: after one of its rows, or at the end.
	const row = layout.insertsAfter();
	const after = row === null ? null : row === HEADER_ROW ? t("pageLayout.header") : layout.label(row);
	return {
		commands: data.components.map((component) => ({
			id: `place:${component.id}`,
			tab: "insert",
			group,
			label: component.name,
			keywords: [],
			permission: "entry.edit",
			canvases: EDIT,
			disabled: busy,
			run: async () => {
				await layout.insert(component.id);
			},
		})),
		where: after ? t("builder.commandMenu.insert.after", { name: after }) : t("builder.commandMenu.editMode.insertEnd"),
		empty: t("pageLayout.noComponents"),
	};
}
