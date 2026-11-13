import type { CommandMenuData } from "@webcraft/core";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";

import type { useT } from "../i18n.tsx";
import type { Canvas, Command } from "./commands.ts";
import { type BuilderTarget, type Catalogue, layerName } from "./model.ts";
import { childLists, type NodePath, pathKey } from "./tree.ts";

type T = ReturnType<typeof useT>;

/** A tree Go to searches by layer label: one source of the page (Code mode has several). */
export type LayerSourceOf = { ref: string; tree: ElementTree; catalogue: Catalogue };

/** Where Go to's choices lead; each canvas leaves safely (its Draft saved first). */
export type GoToTarget = {
	/** Opens a page (a Page or an Entry) in Code mode. */
	page(path: string): void;
	/** Opens a Template or Component in the Builder. */
	builder(target: BuilderTarget): void;
	/** Selects a layer on this page; focus goes to its tree row. */
	layer(ref: string, path: NodePath): void;
};

/**
 * Go to's destinations off the page, wherever the menu shows (Edit mode too, #139): Pages and each
 * Post Type's Entries, for everyone who edits Content, and Templates and Components (opened in the
 * Builder, ADR 0035), for those who may change Structure.
 */
export function destinationCommands(t: T, data: CommandMenuData, go: Pick<GoToTarget, "page" | "builder">): Command[] {
	const everywhere: readonly Canvas[] = ["code", "builder", "edit"];
	const commands: Command[] = [];
	const pagesGroup = t("builder.commandMenu.groups.pages");
	for (const page of data.pages)
		commands.push({
			id: `page:${page.id}`,
			tab: "goTo",
			group: pagesGroup,
			label: page.title || page.path,
			hint: page.path,
			keywords: [page.path],
			permission: "entry.edit",
			canvases: everywhere,
			run: () => go.page(page.path),
		});
	for (const postType of data.postTypes)
		for (const entry of postType.entries)
			commands.push({
				id: `page:${entry.id}`,
				tab: "goTo",
				group: postType.name,
				parent: pagesGroup,
				label: entry.title || entry.path,
				hint: entry.path,
				keywords: [entry.path],
				permission: "entry.edit",
				canvases: everywhere,
				run: () => go.page(entry.path),
			});
	const templatesGroup = t("builder.commandMenu.groups.templates");
	const template = (id: string, label: string, target: BuilderTarget) =>
		commands.push({
			id: `template:${id}`,
			tab: "goTo",
			group: templatesGroup,
			label,
			keywords: [t(`builder.kinds.${target.kind}`)],
			permission: "structure.edit",
			canvases: everywhere,
			run: () => go.builder(target),
		});
	template("site", t("builder.commandMenu.templates.siteTemplate"), { kind: "siteTemplate" });
	template("search", t("builder.commandMenu.templates.searchTemplate"), { kind: "searchTemplate" });
	for (const postType of data.postTypes) {
		template(`entry:${postType.id}`, t("builder.commandMenu.templates.entryTemplate", { postType: postType.name }), {
			kind: "entryTemplate",
			postTypeId: postType.id,
		});
		if (postType.archive)
			template(
				`archive:${postType.id}`,
				t("builder.commandMenu.templates.archiveTemplate", { postType: postType.name }),
				{ kind: "archiveTemplate", postTypeId: postType.id },
			);
	}
	const componentsGroup = t("builder.commandMenu.groups.components");
	for (const component of data.components)
		commands.push({
			id: `component:${component.id}`,
			tab: "goTo",
			group: componentsGroup,
			label: component.name,
			keywords: [t("builder.kinds.component")],
			permission: "structure.edit",
			canvases: everywhere,
			run: () => go.builder({ kind: "component", componentId: component.id }),
		});
	return commands;
}

/**
 * Go to: Pages and each Post Type's Entries (opened in Code mode), Templates and Components (opened
 * in the Builder, ADR 0035), and the layers on the current page by their layer label.
 */
export function goToCommands(
	t: T,
	data: CommandMenuData,
	sources: readonly LayerSourceOf[],
	go: GoToTarget,
	/** Only this Component's Placements: what places it, and its Placements on this page (#134). */
	placementsOf?: string,
): Command[] {
	const both = ["code", "builder"] as const;
	if (placementsOf) return placementCommands(t, data, sources, go, placementsOf);
	const commands = destinationCommands(t, data, go);
	const layersGroup = t("builder.commandMenu.groups.layers");
	for (const source of sources) {
		const visit = (nodes: readonly TreeNode[], owner: NodePath | null) => {
			nodes.forEach((node, index) => {
				if (node.type === "text" || node.type === "comment") return;
				const path: NodePath = owner ? [...owner, index] : [index];
				const name = layerName(t, node, source.catalogue);
				commands.push({
					id: `layer:${source.ref}:${pathKey(path)}`,
					tab: "goTo",
					group: layersGroup,
					label: name.name,
					hint: name.detail ?? undefined,
					keywords: [],
					permission: "structure.edit",
					canvases: both,
					focus: "row",
					run: () => go.layer(source.ref, path),
				});
				childLists(node).forEach((list, at) => {
					visit(list, [...path, at]);
				});
			});
		};
		visit(source.tree.nodes, null);
	}
	return commands;
}

/**
 * Go to, filtered to one Component's Placements (a Placement's "on N pages" badge, #134): the
 * Templates and Components that place it (opened in the Builder), the Entries whose Body places it
 * (opened in Code mode), and its Placements on this page (selected in the tree).
 */
function placementCommands(
	t: T,
	data: CommandMenuData,
	sources: readonly LayerSourceOf[],
	go: GoToTarget,
	componentId: string,
): Command[] {
	const both = ["code", "builder"] as const;
	const component = data.components.find((each) => each.id === componentId);
	const group = t("builder.components.placementsOf", { name: component?.name ?? "" });
	const commands: Command[] = [];
	const add = (id: string, label: string, run: () => void, more: Partial<Command> = {}) =>
		commands.push({
			id: `placements:${id}`,
			tab: "goTo",
			group,
			label,
			keywords: [],
			permission: "structure.edit",
			canvases: both,
			run,
			...more,
		});
	for (const use of component?.usedIn ?? []) {
		const draftOnly = use.versions.includes("published") ? undefined : t("builder.components.draftOnly");
		if (use.kind === "template") {
			const postType = data.postTypes.find((each) => each.id === use.postTypeId);
			if (use.templateKind === "site")
				add(
					`template:${use.id}`,
					t("builder.commandMenu.templates.siteTemplate"),
					() => go.builder({ kind: "siteTemplate" }),
					{ hint: draftOnly },
				);
			else if (use.postTypeId) {
				const target: BuilderTarget =
					use.templateKind === "archive"
						? { kind: "archiveTemplate", postTypeId: use.postTypeId }
						: { kind: "entryTemplate", postTypeId: use.postTypeId };
				add(
					`template:${use.id}`,
					t(`builder.commandMenu.templates.${target.kind}`, { postType: postType?.name ?? "" }),
					() => go.builder(target),
					{ hint: draftOnly },
				);
			} else
				add(
					`template:${use.id}`,
					t("builder.commandMenu.templates.searchTemplate"),
					() => go.builder({ kind: "searchTemplate" }),
					{ hint: draftOnly },
				);
		} else if (use.kind === "component") {
			add(`component:${use.id}`, use.name, () => go.builder({ kind: "component", componentId: use.id }), {
				hint: draftOnly,
			});
		} else if (use.kind === "entry") {
			const entry = [...data.pages, ...data.postTypes.flatMap((each) => each.entries)].find(
				(each) => each.id === use.id,
			);
			if (entry)
				add(`entry:${use.id}`, entry.title || entry.path, () => go.page(entry.path), {
					hint: entry.path,
					permission: "entry.edit",
				});
		}
	}
	for (const source of sources) {
		const visit = (nodes: readonly TreeNode[], owner: NodePath | null) => {
			nodes.forEach((node, index) => {
				const path: NodePath = owner ? [...owner, index] : [index];
				if (node.type === "component" && node.component === componentId)
					add(
						`layer:${source.ref}:${pathKey(path)}`,
						layerName(t, node, source.catalogue).name,
						() => go.layer(source.ref, path),
						{
							hint: t("builder.components.onThisPage"),
							focus: "row",
						},
					);
				childLists(node).forEach((list, at) => {
					visit(list, [...path, at]);
				});
			});
		};
		visit(source.tree.nodes, null);
	}
	return commands;
}
