import type { CommandMenuData } from "@webcraft/core";

import type { BarCommands } from "../../site/edit-bar/kit.ts";
import { type Canvas, type Command, type HistoryTarget, historyCommands } from "../builder/commands.ts";
import { destinationCommands, type GoToTarget } from "../builder/go-to.ts";
import type { useT } from "../i18n.tsx";
import type { LayoutAction, PageLayoutController } from "../page-layouts/controller.ts";

type T = ReturnType<typeof useT>;

/** What Edit mode's menu reads from the Site (`commandMenu`): the menu's data, and where the Builder is. */
export type EditMenuData = CommandMenuData & { siteId: string; adminOrigin: string };

/** Edit mode's own commands show nowhere else. */
const EDIT: readonly Canvas[] = ["edit"];

/** The rows of the Page layout drawer that aren't Placements: the Page template's header and footer. */
const CONTEXT = { header: "context:header", footer: "context:footer" };

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
	const state = layout?.state();
	return !!state?.editing && state.data.canArrange;
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
	const locked = placement.locked && !layout.state().data.canLock ? t("pageLayout.locked") : undefined;
	const act = (action: LayoutAction, label: string, keywords: string, more: Partial<Command> = {}): Command => {
		const allowed = layout.allowed(action, placement.id);
		return {
			...on,
			id: `placement-${action}`,
			label,
			keywords: words(keywords),
			disabled: !allowed,
			...(!allowed && locked ? { reason: locked } : {}),
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
 * Templates and Components), then the page's Placements by their Page layout drawer label, where the
 * person may arrange the page. Picking a Placement selects it, which scrolls to it.
 */
export function editGoTo(
	t: T,
	data: EditMenuData,
	layout: PageLayoutController | null,
	go: Pick<GoToTarget, "page" | "builder"> & { selected(label: string): void },
): Command[] {
	const commands = destinationCommands(t, data, go);
	if (!layout || !arranging(layout)) return commands;
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
	const { data, selected, busy } = layout.state();
	const group = t("builder.insert.groups.components");
	// The words for where `insert` puts it: after the selected row, or at the end with none (or the footer) selected.
	const after =
		selected === CONTEXT.header
			? t("pageLayout.header")
			: data.placements.some((placement) => placement.id === selected) && selected
				? layout.label(selected)
				: null;
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
