import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CodeXmlIcon,
	ComponentIcon,
	CopyPlusIcon,
	EyeIcon,
	EyeOffIcon,
	GitBranchIcon,
	LayersIcon,
	LayoutTemplateIcon,
	RepeatIcon,
	SquareDashedIcon,
	Trash2Icon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { matches } from "../../builder/shortcuts.ts";
import {
	childLists,
	insertAt,
	isFormatting,
	moveDown,
	moveIntoPrevious,
	moveOut,
	moveUp,
	type NodePath,
	pathKey,
	placeOf,
	removeAt,
	replaceAt,
	withNewIds,
} from "../../builder/tree.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import {
	keyOf,
	type LayoutPlacement,
	type Structure,
	type StructureSnapshot,
	type StructureSource,
	sourceOf,
} from "../editing/selection.ts";

/**
 * The Layers panel for Staff (SPEC 5, `builder/01`, `builder/02`, `docking/07`; BA-08): the whole page
 * as one tree, from the Site template down through the page's content (its Entry, Archive or Search
 * results template, or a Page's Page layout) and into each Component its Placements show. Rows are 26
 * high, indented 14 per level; an element shows its tag and first Classes, a Placement its Component's
 * name and on how many pages it shows. Under the pointer (or with focus) a row offers Hide (Placements),
 * Duplicate and Delete.
 *
 * It is an ARIA tree with one tab stop: the arrows move between rows (selecting each, as the canvas
 * does) and open and close them, Home and End go to the ends, Alt with the arrows moves the selected
 * element (up, down, into the one before it, out of its parent), Delete removes it and ⌘D / Ctrl+D
 * duplicates it. Each change is one Undo step, made through its Template's or Component's shared Draft.
 */

/** One row of the tree. */
type Row =
	| { kind: "divider"; key: string; label: string; icon: "site" | "content" | "layout"; depth: number }
	| {
			kind: "node";
			key: string;
			/** The selection's reference: `<source>#<id or @path>`. */
			ref: string;
			source: StructureSource;
			path: NodePath;
			node: TreeNode;
			depth: number;
			expandable: boolean;
			expanded: boolean;
			/** For a Placement, its Component's source when the page shows it (its rows nest under it). */
			nested: StructureSource | null;
			parent: string | null;
	  }
	| { kind: "placement"; key: string; placement: LayoutPlacement; depth: number; parent: string | null };

/** What a node is called in a row: its tag (or Component, command), and a quieter detail. */
function rowName(
	node: TreeNode,
	source: StructureSource,
	nested: StructureSource | null,
): { name: string; detail: string } {
	switch (node.type) {
		case "element": {
			const classes = node.classes
				.map(
					(id) =>
						source.catalogue.classes.find((each) => each.id === id && !each.generated)?.name ??
						source.catalogue.utilities.find((each) => each.id === id)?.name,
				)
				.filter((name): name is string => Boolean(name))
				.slice(0, 2);
			return {
				name: node.label ?? node.tag,
				detail: [node.label ? node.tag : "", classes.length ? `.${classes.join(" .")}` : ""].filter(Boolean).join(" "),
			};
		}
		case "component":
			return {
				name:
					nested?.name ??
					source.catalogue.components.find((component) => component.id === node.component)?.name ??
					node.component,
				detail: "",
			};
		case "loop":
			return { name: `{{@loop ${node.source}}}`, detail: "" };
		case "condition":
			return { name: "{{@if}}", detail: "" };
		case "text":
			return { name: `“${node.text.replace(/\s+/g, " ").trim().slice(0, 40)}”`, detail: "" };
		case "value":
			return { name: `{{ ${node.path} }}`, detail: "" };
		default:
			return { name: `{{@${node.type}}}`, detail: "" };
	}
}

/** The label of the content the Site template's outlet shows. */
function contentLabel(words: Words, site: StructureSource, content: StructureSource | undefined): string | null {
	const said = words.structure;
	if (site.pageLayout) return fill(said.pageLayout, { name: site.pageLayout.title });
	if (!content) return null;
	switch (content.target.kind) {
		case "entryTemplate":
			return fill(said.entryTemplate, { name: content.name ?? "" });
		case "archiveTemplate":
			return fill(said.archiveTemplate, { name: content.name ?? "" });
		case "searchTemplate":
			return said.searchTemplate;
		default:
			return null;
	}
}

/** Whether a tree holds the outlet (`{{@outlet}}`) somewhere: its elements open towards it at first. */
function holdsOutlet(node: TreeNode): boolean {
	return node.type === "outlet" || childLists(node).some((list) => list.some(holdsOutlet));
}

/** Whether the selection is inside a node (its Component's elements, for a Placement): it opens towards it. */
function holdsSelection(
	node: TreeNode,
	source: StructureSource,
	nested: StructureSource | null,
	selected: string | null,
): boolean {
	if (!selected) return false;
	if (nested) return sourceOf(selected).startsWith(nested.ref);
	if (sourceOf(selected) !== source.ref) return false;
	const key = keyOf(selected);
	const found = (list: readonly TreeNode[]): boolean =>
		list.some((child) => ("id" in child && child.id === key) || childLists(child).some(found));
	return found(childLists(node).flat());
}

/** The rows the tree shows: every node but formatting, inside what is open. */
function rowsOf(
	snapshot: StructureSnapshot,
	words: Words,
	expandedOf: (key: string, opened: boolean) => boolean,
): Row[] {
	const rows: Row[] = [];
	const site = snapshot.sources.get("site");
	if (!site) return rows;
	const content = snapshot.sources.get("content");
	const selected = snapshot.selection?.ref ?? null;
	const onTheWay = (ref: string) =>
		selected !== null && selected !== ref && sourceOf(selected).startsWith(sourceOf(ref));

	const visit = (
		source: StructureSource,
		nodes: readonly TreeNode[],
		prefix: number[],
		depth: number,
		parent: string | null,
	) => {
		nodes.forEach((node, index) => {
			if (isFormatting(node) || node.type === "comment" || node.type === "text" || node.type === "value") return;
			const path = [...prefix, index];
			if (node.type === "outlet") {
				const label = contentLabel(words, site, content);
				if (label) rows.push({ kind: "divider", key: `${source.ref}:outlet`, label, icon: "layout", depth });
				if (site.pageLayout && snapshot.layout) {
					for (const placement of snapshot.layout) {
						rows.push({ kind: "placement", key: `layout:${placement.id}`, placement, depth, parent });
					}
				} else if (content) visit(content, content.tree.nodes, [], depth, parent);
				return;
			}
			const id = "id" in node ? node.id : `@${path.join(".")}`;
			const ref = `${source.ref}#${id}`;
			const nested = node.type === "component" ? (snapshot.sources.get(`${source.ref}/${node.id}`) ?? null) : null;
			const children = nested ? nested.tree.nodes : (childLists(node)[0] ?? []);
			const expandable = children.some(
				(child) => !isFormatting(child) && child.type !== "comment" && child.type !== "text" && child.type !== "value",
			);
			const opened =
				expandable && (holdsOutlet(node) || (onTheWay(ref) && holdsSelection(node, source, nested, selected)));
			const expanded = expandable && expandedOf(`${source.ref}:${pathKey(path)}`, opened);
			rows.push({
				kind: "node",
				key: `${source.ref}:${pathKey(path)}`,
				ref,
				source,
				path,
				node,
				depth,
				expandable,
				expanded,
				nested,
				parent,
			});
			if (!expanded) return;
			if (nested) visit(nested, nested.tree.nodes, [], depth + 1, `${source.ref}:${pathKey(path)}`);
			else visit(source, children, [...path, 0], depth + 1, `${source.ref}:${pathKey(path)}`);
		});
	};
	rows.push({ kind: "divider", key: "site:divider", label: words.structure.siteTemplate, icon: "site", depth: 0 });
	visit(site, site.tree.nodes, [], 0, null);
	return rows;
}

/** The pixel indent of a row: 14 per level (SPEC 4). */
const INDENT = 14;

export function Layers({ structure, words }: { structure: Structure; words: Words }) {
	const snapshot = useSyncExternalStore(structure.subscribe, structure.snapshot);
	const said = words.structure;
	/** Rows the person opened or closed themselves; the others follow the outlet and the selection. */
	const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
	const rows = useMemo(
		() => rowsOf(snapshot, words, (key, opened) => toggled.get(key) ?? opened),
		[snapshot, words, toggled],
	);
	const selectedRef = snapshot.selection?.ref ?? null;
	const selectedRow = rows.find((row) => row.kind === "node" && row.ref === selectedRef);
	const [focusKey, setFocusKey] = useState<string | null>(null);
	const list = useRef<HTMLDivElement>(null);
	const focusable = rows.filter((row) => row.kind !== "divider");
	const tabStop = (selectedRow ?? focusable.find((row) => row.key === focusKey) ?? focusable[0])?.key ?? null;

	// The selected row is brought into view as the selection changes (from the canvas, Undo, the address).
	useEffect(() => {
		if (!selectedRow) return;
		list.current
			?.querySelector<HTMLElement>(`[data-wc-row="${CSS.escape(selectedRow.key)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selectedRow]);

	const toggle = (key: string, open: boolean) => setToggled((was) => new Map(was).set(key, open));

	const focusRow = (key: string | null) => {
		if (!key) return;
		setFocusKey(key);
		requestAnimationFrame(() =>
			list.current?.querySelector<HTMLElement>(`[data-wc-row="${CSS.escape(key)}"]`)?.focus(),
		);
	};

	const choose = (row: Row) => {
		if (row.kind === "node") structure.select(row.ref);
		// A Page layout's Placement: its Component's elements on the page (BA-09 opens its Props).
		else if (row.kind === "placement") structure.select(`content/${row.placement.id}`);
		setFocusKey(row.key);
	};

	/** Changes the tree of a row's source; answers whether it was taken (else it was said why not). */
	const change = (row: Extract<Row, { kind: "node" }>, next: ElementTree, label: string, select?: string | null) => {
		const refused = structure.change(row.source.ref, next, label, select);
		if (refused) {
			announceRefusal(refused);
			return false;
		}
		return true;
	};
	const [refusal, setRefusal] = useState({ text: "", count: 0 });
	const announceRefusal = (text: string) => setRefusal((was) => ({ text, count: was.count + 1 }));

	const nameOfRow = (row: Extract<Row, { kind: "node" }>) => rowName(row.node, row.source, row.nested).name;

	const act = (row: Extract<Row, { kind: "node" }>, action: "hide" | "duplicate" | "delete") => {
		const tree = row.source.tree;
		const name = nameOfRow(row);
		if (action === "hide" && row.node.type === "component") {
			const hidden = !row.node.hidden;
			change(
				row,
				replaceAt(tree, row.path, { ...row.node, hidden }),
				fill(hidden ? said.steps.hide : said.steps.show, { name }),
			);
			return;
		}
		if (action === "duplicate") {
			const [copy] = withNewIds(tree, [row.node]);
			if (!copy) return;
			const place = placeOf(row.path);
			const made = insertAt(tree, { ...place, index: place.index + 1 }, [copy]);
			const key = "id" in copy ? copy.id : `@${made.path.join(".")}`;
			if (change(row, made.tree, fill(said.steps.duplicate, { name }), key))
				focusRow(`${row.source.ref}:${pathKey(made.path)}`);
			return;
		}
		if (action === "delete") {
			const at = focusable.findIndex((each) => each.key === row.key);
			const next = focusable[at + 1] ?? focusable[at - 1];
			if (change(row, removeAt(tree, row.path), fill(said.steps.delete, { name }), null) && next) focusRow(next.key);
		}
	};

	const move = (row: Extract<Row, { kind: "node" }>, how: "up" | "down" | "in" | "out") => {
		const moved = { up: moveUp, down: moveDown, in: moveIntoPrevious, out: moveOut }[how](row.source.tree, row.path);
		if ("refused" in moved) {
			announceRefusal(moved.refused);
			return;
		}
		const key = "id" in row.node ? row.node.id : `@${moved.path.join(".")}`;
		if (change(row, moved.tree, fill(said.steps.move, { name: nameOfRow(row) }), key))
			focusRow(`${row.source.ref}:${pathKey(moved.path)}`);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const at = focusable.findIndex((row) => row.key === (focusKey ?? tabStop));
		const row = focusable[at];
		if (!row) return;
		const go = (next: Row | undefined) => {
			if (!next) return;
			choose(next);
			focusRow(next.key);
		};
		const node = row.kind === "node" ? row : null;
		if (event.altKey && node && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
			event.preventDefault();
			const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
			const inward = rtl ? "ArrowLeft" : "ArrowRight";
			move(
				node,
				event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === inward ? "in" : "out",
			);
			return;
		}
		if (node && (event.key === "Delete" || event.key === "Backspace")) {
			event.preventDefault();
			act(node, "delete");
			return;
		}
		if (node && matches(event.nativeEvent, "element.duplicate")) {
			event.preventDefault();
			act(node, "duplicate");
			return;
		}
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const opening = rtl ? "ArrowLeft" : "ArrowRight";
		const closing = rtl ? "ArrowRight" : "ArrowLeft";
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				go(focusable[at + 1]);
				return;
			case "ArrowUp":
				event.preventDefault();
				go(focusable[at - 1]);
				return;
			case "Home":
				event.preventDefault();
				go(focusable[0]);
				return;
			case "End":
				event.preventDefault();
				go(focusable[focusable.length - 1]);
				return;
			case opening:
				event.preventDefault();
				if (node?.expandable && !node.expanded) toggle(node.key, true);
				else if (node?.expandable) go(focusable[at + 1]);
				return;
			case closing:
				event.preventDefault();
				if (node?.expandable && node.expanded) toggle(node.key, false);
				else go(focusable.find((each) => each.key === row.parent));
				return;
			case "Enter":
			case " ":
				event.preventDefault();
				choose(row);
				return;
			default:
				return;
		}
	};

	if (!snapshot.sources.get("site")) {
		return <p className="text-chrome-muted px-2 py-1 text-[12px]">{said.loading}</p>;
	}

	return (
		<div className="flex min-h-0 grow flex-col" data-wc-layers="">
			<div
				ref={list}
				role="tree"
				aria-label={said.tree}
				aria-describedby="wc-layers-keys"
				onKeyDown={onKeyDown}
				className="-mx-1 min-h-0 grow overflow-auto px-1 pb-2"
			>
				{rows.map((row) =>
					row.kind === "divider" ? (
						<div
							key={row.key}
							role="presentation"
							className="text-chrome-faint flex h-[26px] items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase"
							style={{ paddingInlineStart: `${8 + row.depth * INDENT}px` }}
							data-wc-layers-divider=""
						>
							{row.icon === "site" ? (
								<LayoutTemplateIcon aria-hidden="true" className="size-3.5 shrink-0" />
							) : (
								<LayersIcon aria-hidden="true" className="size-3.5 shrink-0" />
							)}
							<span className="truncate">{row.label}</span>
						</div>
					) : (
						<TreeRow
							key={row.key}
							row={row}
							words={words}
							selected={row.kind === "node" ? row.ref === selectedRef : selectedRef === `content/${row.placement.id}`}
							tabStop={row.key === tabStop}
							onChoose={() => choose(row)}
							onToggle={row.kind === "node" && row.expandable ? () => toggle(row.key, !row.expanded) : undefined}
							actions={
								row.kind === "node" ? (
									<RowActions row={row} words={words} onAction={(action) => act(row, action)} />
								) : null
							}
							onFocus={() => setFocusKey(row.key)}
						/>
					),
				)}
			</div>
			<p id="wc-layers-keys" className="sr-only">
				{said.keys}
			</p>
			<p className="sr-only" role="status" aria-live="polite">
				{refusal.text ? `${refusal.text}${refusal.count % 2 ? " " : ""}` : ""}
			</p>
		</div>
	);
}

function TreeRow({
	row,
	words,
	selected,
	tabStop,
	onChoose,
	onToggle,
	actions,
	onFocus,
}: {
	row: Extract<Row, { kind: "node" } | { kind: "placement" }>;
	words: Words;
	selected: boolean;
	tabStop: boolean;
	onChoose(): void;
	onToggle?: () => void;
	actions: ReactNode;
	onFocus(): void;
}) {
	const said = words.structure;
	const node = row.kind === "node" ? row.node : null;
	const component = node?.type === "component" || row.kind === "placement";
	const named =
		row.kind === "node" ? rowName(row.node, row.source, row.nested) : { name: row.placement.name, detail: "" };
	const pages = row.kind === "node" ? (row.nested?.pages ?? null) : null;
	const hidden = (node?.type === "component" && node.hidden) || (row.kind === "placement" && row.placement.hidden);
	const expanded = row.kind === "node" && row.expandable ? row.expanded : undefined;
	const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
	const Glyph = component
		? ComponentIcon
		: node?.type === "loop"
			? RepeatIcon
			: node?.type === "condition"
				? GitBranchIcon
				: node?.type === "element"
					? CodeXmlIcon
					: SquareDashedIcon;
	const label = [
		named.name,
		named.detail,
		pages !== null && pages > 1 ? fill(said.pagesOther, { count: String(pages) }) : null,
		hidden ? said.hiddenRow : null,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div
			role="treeitem"
			aria-level={row.depth + 1}
			aria-selected={selected}
			aria-expanded={expanded}
			aria-label={label}
			tabIndex={tabStop ? 0 : -1}
			onClick={onChoose}
			// The tree hears the keys for every row (one tab stop, arrow keys).
			onKeyDown={() => {}}
			onFocus={(event) => {
				if (event.target === event.currentTarget) onFocus();
			}}
			className={`group/row relative flex h-[26px] cursor-default items-center gap-1 rounded-[5px] pe-1 text-[12px] ${
				selected
					? "text-chrome-strong bg-[#6366f1]/25 shadow-[inset_2px_0_0_#6366f1]"
					: "hover:bg-chrome-hover text-chrome-text"
			} ${hidden ? "[&>[data-wc-row-name]]:opacity-50" : ""} ${CHROME_EASE} ${FOCUS_RING}`}
			style={{ paddingInlineStart: `${4 + row.depth * INDENT}px` }}
			data-wc-row={row.key}
			data-wc-ref={row.kind === "node" ? row.ref : undefined}
		>
			<span aria-hidden="true" className="text-chrome-faint grid size-3.5 shrink-0 place-items-center">
				{onToggle ? (
					<Chevron
						className={expanded ? "size-3.5" : "size-3.5 rtl:rotate-180"}
						onClick={(event) => {
							event.stopPropagation();
							onToggle();
						}}
					/>
				) : null}
			</span>
			<Glyph
				aria-hidden="true"
				className={`size-3.5 shrink-0 ${component ? "text-[#a78bfa]" : node?.type === "loop" ? "text-[#fbbf24]" : node?.type === "condition" ? "text-[#60a5fa]" : "text-chrome-faint"}`}
			/>
			<span className="flex min-w-0 grow items-baseline gap-1.5 truncate" data-wc-row-name="">
				{node?.type === "element" ? (
					<>
						<span className={`font-mono ${node.label ? "text-chrome-strong font-sans" : "text-[#f472b6]"}`}>
							{named.name}
						</span>
						{named.detail ? (
							<span className="text-chrome-faint truncate font-mono text-[11px]">{named.detail}</span>
						) : null}
					</>
				) : (
					<span className={component ? "text-chrome-strong font-medium" : "font-mono"}>{named.name}</span>
				)}
			</span>
			{hidden ? <EyeOffIcon aria-hidden="true" className="text-chrome-faint size-3.5 shrink-0" /> : null}
			{pages !== null && pages > 1 ? (
				<span className="shrink-0 rounded-[4px] bg-[#7c2d12] px-1.5 text-[11px] leading-[18px] font-medium text-[#fdba74]">
					{fill(said.pagesOther, { count: String(pages) })}
				</span>
			) : null}
			{actions}
		</div>
	);
}

/** A row's actions, under the pointer or with focus in the row (`docking/07`): Hide, Duplicate, Delete. */
function RowActions({
	row,
	words,
	onAction,
}: {
	row: Extract<Row, { kind: "node" }>;
	words: Words;
	onAction(action: "hide" | "duplicate" | "delete"): void;
}) {
	if (!row.source.editable) return null;
	const said = words.structure.actions;
	const placement = row.node.type === "component";
	const buttons: { action: "hide" | "duplicate" | "delete"; label: string; icon: typeof EyeIcon }[] = [
		...(placement
			? [
					{
						action: "hide" as const,
						label: row.node.type === "component" && row.node.hidden ? said.show : said.hide,
						icon: row.node.type === "component" && row.node.hidden ? EyeIcon : EyeOffIcon,
					},
				]
			: []),
		{ action: "duplicate", label: said.duplicate, icon: CopyPlusIcon },
		{ action: "delete", label: said.delete, icon: Trash2Icon },
	];
	return (
		<span
			className="hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex"
			data-wc-row-actions=""
		>
			{buttons.map(({ action, label, icon: Icon }, index) => (
				<button
					key={action}
					type="button"
					tabIndex={-1}
					aria-label={label}
					onClick={(event) => {
						event.stopPropagation();
						onAction(action);
					}}
					className={`group text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong relative grid size-5 place-items-center rounded-[4px] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-row-action={action}
				>
					<Icon aria-hidden="true" className="size-3.5" />
					<Tip label={label} side="bottom" align={index === buttons.length - 1 ? "end" : "center"} />
				</button>
			))}
		</span>
	);
}
