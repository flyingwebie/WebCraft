import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	BracesIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClipboardPasteIcon,
	ComponentIcon,
	CopyIcon,
	CopyPlusIcon,
	CornerDownRightIcon,
	CornerUpLeftIcon,
	EyeIcon,
	EyeOffIcon,
	GitBranchIcon,
	type LucideIcon,
	PencilIcon,
	PlusIcon,
	RepeatIcon,
	ScissorsIcon,
	Trash2Icon,
} from "lucide-react";
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useAfterRender } from "../after-render.ts";
import { useT } from "../i18n.tsx";
import { type Catalogue, layerName, listName, type Selection } from "./model.ts";
import {
	canHoldChildren,
	childLists,
	type DropPosition,
	dropPositionAt,
	isFixedText,
	isFormatting,
	type ListRef,
	type NodePath,
	pathKey,
} from "./tree.ts";

/** One row of the Layers panel: a node, or a later list of a Condition or Loop (its Else, its Empty). */
export type LayerRow = { source?: string; catalogue?: Catalogue; divider?: string; pages?: number; count?: number } & (
	| { kind: "node"; key: string; path: NodePath; depth: number; node: TreeNode; expandable: boolean; expanded: boolean }
	| { kind: "list"; key: string; list: ListRef; owner: TreeNode; depth: number; expandable: boolean; expanded: boolean }
);

/** The rows the Layers panel shows: every node but formatting, in order, inside what is open. */
export function layerRows(tree: ElementTree, collapsed: ReadonlySet<string>): LayerRow[] {
	const rows: LayerRow[] = [];
	const visit = (nodes: readonly TreeNode[], prefix: number[], depth: number) => {
		nodes.forEach((node, index) => {
			if (isFormatting(node)) return;
			const path = [...prefix, index];
			const lists = childLists(node);
			const expandable = lists.some((list) => list.some((child) => !isFormatting(child))) || lists.length > 1;
			const key = rowKey(node, path);
			const expanded = expandable && !collapsed.has(key);
			rows.push({ kind: "node", key, path, depth, node, expandable, expanded });
			if (!expanded) return;
			lists.forEach((list, at) => {
				if (at === 0) {
					visit(list, [...path, 0], depth + 1);
					return;
				}
				rows.push({
					kind: "list",
					key: `${key}/${at}`,
					list: { owner: path, list: at },
					owner: node,
					depth: depth + 1,
					expandable: false,
					expanded: false,
				});
				visit(list, [...path, at], depth + 2);
			});
		});
	};
	visit(tree.nodes, [], 1);
	return rows;
}

export type LayerSource = {
	ref: string;
	tree: ElementTree;
	catalogue: Catalogue;
	label: string;
	pages?: number;
	counts?: Record<string, number>;
};

function forestRows(sources: readonly LayerSource[], collapsed: ReadonlySet<string>): LayerRow[] {
	const rows: LayerRow[] = [];
	const visit = (source: LayerSource, depth: number) => {
		const ownCollapsed = new Set(
			[...collapsed].filter((key) => key.startsWith(`${source.ref}:`)).map((key) => key.slice(source.ref.length + 1)),
		);
		const own = layerRows(source.tree, ownCollapsed);
		own.forEach((row, index) => {
			const placement = row.kind === "node" && row.node.type === "component" ? row.node : null;
			const nested = placement ? sources.find((each) => each.ref === `${source.ref}/${placement.id}`) : undefined;
			const key = `${source.ref}:${row.key}`;
			const expanded = nested ? !collapsed.has(key) : row.expanded;
			rows.push({
				...row,
				key,
				depth: row.depth + depth,
				source: source.ref,
				catalogue: source.catalogue,
				count: row.kind === "node" ? source.counts?.[`${source.ref}:${pathKey(row.path)}`] : undefined,
				...(index === 0 ? { divider: source.label } : {}),
				...(nested ? { expandable: true, expanded, pages: nested.pages } : {}),
			});
			if (nested && expanded) visit(nested, row.depth + depth);
		});
	};
	for (const source of sources.filter((each) => !each.ref.includes("/"))) visit(source, 0);
	return rows;
}

/** What remembers whether a row is open: an element's or Placement's id, else where it is. */
export function rowKey(node: TreeNode, path: NodePath): string {
	return node.type === "element" || node.type === "component" ? `#${node.id}` : pathKey(path);
}

/** The moves and changes the Layers panel offers, on the selected layer. */
export type LayerAction =
	| "moveUp"
	| "moveDown"
	| "moveIn"
	| "moveOut"
	| "cut"
	| "copy"
	| "paste"
	| "duplicate"
	| "rename"
	| "delete";

const ACTIONS: readonly { action: LayerAction; icon: LucideIcon; keys: string }[] = [
	{ action: "moveUp", icon: ArrowUpIcon, keys: "Alt+ArrowUp" },
	{ action: "moveDown", icon: ArrowDownIcon, keys: "Alt+ArrowDown" },
	{ action: "moveIn", icon: CornerDownRightIcon, keys: "Alt+ArrowRight" },
	{ action: "moveOut", icon: CornerUpLeftIcon, keys: "Alt+ArrowLeft" },
	{ action: "cut", icon: ScissorsIcon, keys: "Control+X" },
	{ action: "copy", icon: CopyIcon, keys: "Control+C" },
	{ action: "paste", icon: ClipboardPasteIcon, keys: "Control+V" },
	{ action: "duplicate", icon: CopyPlusIcon, keys: "Control+D" },
	{ action: "rename", icon: PencilIcon, keys: "F2" },
	{ action: "delete", icon: Trash2Icon, keys: "Delete" },
];

/** How far each level of the Layers panel is indented (classes, not inline styles). */
const INDENT = ["ps-0", "ps-0", "ps-3", "ps-6", "ps-9", "ps-12", "ps-15", "ps-18", "ps-21", "ps-24", "ps-27", "ps-30"];

/** Where a dragged layer goes, beside or inside another. */
export type { DropPosition } from "./tree.ts";

/**
 * The Layers panel: the tree of the Template or Component as an ARIA tree, the keyboard way to do
 * everything dragging does. One tab stop; the arrow keys move between layers and open and close
 * them; Alt with the arrows moves the selected layer (up, down, into the layer before it, out of
 * what holds it); Space picks a layer up so the arrows move it, Space puts it down and Escape puts
 * it back; Ctrl/⌘ with X, C, V and D cut, copy, paste and duplicate; Delete removes; F2 renames.
 * Every move is announced. A toolbar above offers the same on the selected layer, and rows drag.
 */
export function LayersPanel({
	tree,
	catalogue,
	selection,
	collapsed,
	grabbed,
	canPaste,
	onSelect,
	onToggle,
	onAction,
	onGrab,
	onRename,
	onDrop,
	onInsert,
	focusRequest,
	forest,
	activeSource,
	onSourceSelect,
	onHover,
	hovered,
	counts,
	onHidden,
}: {
	/** Changes when the selected row should take focus (after a click on the canvas). */
	focusRequest: number;
	forest?: readonly LayerSource[];
	activeSource?: string;
	onSourceSelect?(source: string, selection: Selection): void;
	onHover?(source: string | undefined, selection: Selection | null): void;
	hovered?: string | null;
	counts?: Record<string, number>;
	onHidden?(path: NodePath, hidden: boolean, source?: string): void;
	tree: ElementTree;
	catalogue: Catalogue;
	selection: Selection | null;
	collapsed: ReadonlySet<string>;
	/** Whether the selected layer is picked up: the arrow keys move it. */
	grabbed: boolean;
	canPaste: boolean;
	onSelect(selection: Selection): void;
	onToggle(key: string, open: boolean): void;
	onAction(action: LayerAction): void;
	/** Space: pick the selected layer up, put it down (`drop`) or back where it was (`cancel`). */
	onGrab(change: "pick" | "drop" | "cancel"): void;
	onRename(path: NodePath, label: string): void;
	onDrop(from: NodePath, to: NodePath, position: DropPosition): void;
	onInsert(): void;
}) {
	const t = useT();
	const rows = forest ? forestRows(forest, collapsed) : layerRows(tree, collapsed);
	const list = useRef<HTMLDivElement>(null);
	const afterRender = useAfterRender();
	const [renaming, setRenaming] = useState<string | null>(null);
	const handledRequest = useRef(focusRequest);
	const [dragging, setDragging] = useState<NodePath | null>(null);
	const [over, setOver] = useState<{ key: string; position: DropPosition } | null>(null);
	const selectedKey =
		selection?.kind === "node"
			? rows.find(
					(row) =>
						row.kind === "node" &&
						(!activeSource || row.source === activeSource) &&
						pathKey(row.path) === pathKey(selection.path),
				)?.key
			: rows.find(
					(row) =>
						row.kind === "list" &&
						(!activeSource || row.source === activeSource) &&
						selection?.kind === "list" &&
						pathKey(row.list.owner ?? []) === pathKey(selection.list.owner ?? []) &&
						row.list.list === selection.list.list,
				)?.key;
	const focusKey = selectedKey ?? rows[0]?.key;
	const selectedRow = rows.find((row) => row.key === selectedKey);
	const nodeSelected = selectedRow?.kind === "node";

	// The focused row follows the selection while focus is in the panel, and when something else
	// (a click on the canvas) asks for it, so the keyboard carries on from there.
	useEffect(() => {
		const element = list.current;
		const asked = focusRequest !== handledRequest.current;
		handledRequest.current = focusRequest;
		const active = (element?.getRootNode() as Document | ShadowRoot | undefined)?.activeElement;
		if (!element || renaming || (!asked && !element.contains(active ?? null))) return;
		const row = element.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(focusKey ?? "")}"]`);
		if (row && row !== active) row.focus();
	}, [focusKey, renaming, focusRequest]);

	const select = (row: LayerRow) => {
		const selection: Selection =
			row.kind === "node" ? { kind: "node", path: row.path } : { kind: "list", list: row.list };
		if (row.source && row.source !== activeSource && onSourceSelect) onSourceSelect(row.source, selection);
		else onSelect(selection);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (renaming) return;
		const index = rows.findIndex((row) => row.key === focusKey);
		const row = rows[index];
		if (!row) return;
		const mod = event.ctrlKey || event.metaKey;
		const handled = () => {
			event.preventDefault();
			event.stopPropagation();
		};
		if (event.key === " " && !mod && !event.altKey) {
			handled();
			if (row.kind === "node") onGrab(grabbed ? "drop" : "pick");
			return;
		}
		if (grabbed) {
			const move = { ArrowUp: "moveUp", ArrowDown: "moveDown", ArrowRight: "moveIn", ArrowLeft: "moveOut" }[
				event.key
			] as LayerAction | undefined;
			if (move) {
				handled();
				onAction(move);
			} else if (event.key === "Escape") {
				handled();
				onGrab("cancel");
			} else if (event.key === "Tab") {
				onGrab("drop");
			}
			return;
		}
		if (event.altKey && !mod) {
			const move = { ArrowUp: "moveUp", ArrowDown: "moveDown", ArrowRight: "moveIn", ArrowLeft: "moveOut" }[
				event.key
			] as LayerAction | undefined;
			if (move) {
				handled();
				onAction(move);
			}
			return;
		}
		if (mod && !event.altKey) {
			if (event.key.toLowerCase() === "i") {
				handled();
				onInsert();
				return;
			}
			const action = { x: "cut", c: "copy", v: "paste", d: "duplicate" }[event.key.toLowerCase()] as
				| LayerAction
				| undefined;
			if (action) {
				handled();
				onAction(action);
			}
			return;
		}
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp": {
				handled();
				const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
				if (next) select(next);
				return;
			}
			case "Home":
			case "End": {
				handled();
				const next = event.key === "Home" ? rows[0] : rows.at(-1);
				if (next) select(next);
				return;
			}
			case "ArrowRight": {
				handled();
				if (row.expandable && !row.expanded) onToggle(row.key, true);
				else if (row.expanded) {
					const child = rows[index + 1];
					if (child) select(child);
				}
				return;
			}
			case "ArrowLeft": {
				handled();
				if (row.expanded) {
					onToggle(row.key, false);
					return;
				}
				for (let at = index - 1; at >= 0; at--) {
					const parent = rows[at];
					if (parent && parent.depth < row.depth) {
						select(parent);
						return;
					}
				}
				return;
			}
			case "Delete":
			case "Backspace":
				handled();
				onAction("delete");
				return;
			case "F2":
				handled();
				if (row.kind === "node" && row.node.type === "element") setRenaming(row.key);
				else onAction("rename");
				return;
			case "Enter":
				if (row.expandable) {
					handled();
					onToggle(row.key, !row.expanded);
				}
				return;
		}
	};

	const startRename = () => {
		if (selectedRow?.kind === "node" && selectedRow.node.type === "element") setRenaming(selectedRow.key);
		else onAction("rename");
	};

	const dropProps = (row: LayerRow) => {
		if (row.kind !== "node") return {};
		return {
			onDragOver(event: DragEvent<HTMLElement>) {
				if (!dragging || (row.source && row.source !== activeSource)) return;
				event.preventDefault();
				const box = event.currentTarget.getBoundingClientRect();
				const y = (event.clientY - box.top) / Math.max(box.height, 1);
				const position = dropPositionAt(y, canHoldChildren(row.node));
				if (over?.key !== row.key || over.position !== position) setOver({ key: row.key, position });
			},
			onDragLeave() {
				if (over?.key === row.key) setOver(null);
			},
			onDrop(event: DragEvent<HTMLElement>) {
				event.preventDefault();
				if (dragging && over && (!row.source || row.source === activeSource)) onDrop(dragging, row.path, over.position);
				setDragging(null);
				setOver(null);
			},
		};
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
				<h2 id="layers-heading" className="text-sm font-semibold">
					{t("builder.layers.heading")}
				</h2>
				<Button type="button" size="sm" variant="outline" onClick={onInsert} aria-keyshortcuts="Control+I">
					<PlusIcon aria-hidden="true" />
					{t("builder.insert.open")}
				</Button>
			</div>
			<fieldset className="flex flex-wrap gap-0.5 border-b px-2 py-1">
				<legend className="sr-only">{t("builder.layers.actions")}</legend>
				{ACTIONS.map(({ action, icon: Icon, keys }) => {
					const disabled =
						action === "paste" ? !canPaste || !selectedRow : action === "rename" ? !nodeSelected : !nodeSelected;
					return (
						<Button
							key={action}
							type="button"
							variant="ghost"
							size="icon-sm"
							disabled={disabled}
							aria-label={t(`builder.layers.action.${action}`)}
							title={`${t(`builder.layers.action.${action}`)} (${keys.replace("Control", "Ctrl")})`}
							aria-keyshortcuts={keys}
							onClick={() => (action === "rename" ? startRename() : onAction(action))}
						>
							<Icon aria-hidden="true" />
						</Button>
					);
				})}
				{selectedRow?.kind === "node" && selectedRow.node.type === "component" && onHidden ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t(selectedRow.node.hidden ? "builder.layers.showPlacement" : "builder.layers.hidePlacement")}
						onClick={() => {
							if (selectedRow.node.type === "component")
								onHidden(selectedRow.path, !selectedRow.node.hidden, selectedRow.source);
						}}
					>
						{selectedRow.node.hidden ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
					</Button>
				) : null}
			</fieldset>
			<div className="min-h-0 flex-1 overflow-auto p-2">
				{rows.length === 0 ? (
					<p className="text-muted-foreground p-2 text-sm">{t("builder.layers.none")}</p>
				) : (
					<div
						ref={list}
						role="tree"
						aria-labelledby="layers-heading"
						aria-describedby="layers-keys"
						onKeyDown={onKeyDown}
						className="grid gap-px"
					>
						{forest
							?.filter((source) => source.tree.nodes.length === 0)
							.map((source) => (
								<div key={source.ref} className="layer-divider" role="presentation">
									{source.label}
								</div>
							))}
						{rows.map((row) => {
							const selected = row.key === selectedKey;
							const named =
								row.kind === "node"
									? layerName(t, row.node, row.catalogue ?? catalogue)
									: { name: listName(t, row.owner, row.list.list), detail: null, kind: "list" };
							const fixed = row.kind === "node" && isFixedText(row.node);
							const drop = over?.key === row.key ? over.position : undefined;
							return (
								<div role="none" key={row.key}>
									{row.divider ? (
										<div className="layer-divider" role="presentation">
											{row.divider}
										</div>
									) : null}
									<div
										role="treeitem"
										aria-level={row.depth}
										aria-selected={selected}
										aria-expanded={row.expandable ? row.expanded : undefined}
										data-grabbed={selected && grabbed ? true : undefined}
										tabIndex={row.key === focusKey ? 0 : -1}
										data-row-key={row.key}
										data-hidden={(row.kind === "node" && row.node.type === "component" && row.node.hidden) || undefined}
										data-hovered={hovered === row.key || undefined}
										onMouseEnter={() =>
											onHover?.(
												row.source,
												row.kind === "node" ? { kind: "node", path: row.path } : { kind: "list", list: row.list },
											)
										}
										onMouseLeave={() => onHover?.(row.source, null)}
										data-drop={drop}
										draggable={row.kind === "node" && renaming !== row.key}
										onDragStart={(event) => {
											if (row.kind !== "node") return;
											event.dataTransfer.effectAllowed = "move";
											event.dataTransfer.setData("text/plain", row.key);
											setDragging(row.path);
											select(row);
										}}
										onDragEnd={() => {
											setDragging(null);
											setOver(null);
										}}
										{...dropProps(row)}
										onClick={() => select(row)}
										// The tree hears the keys for every row (one tab stop, arrow keys).
										onKeyDown={() => {}}
										onFocus={(event) => {
											if (event.target === event.currentTarget && !selected) select(row);
										}}
										className={`${INDENT[Math.min(row.depth, INDENT.length - 1)]} focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground hover:bg-muted data-[drop=after]:border-b-primary data-[drop=before]:border-t-primary data-[drop=inside]:ring-primary data-[grabbed=true]:ring-primary flex min-w-0 cursor-default items-center gap-1 rounded-md border-y-2 border-transparent py-1 pe-2 text-sm outline-none focus-visible:ring-3 data-[drop=inside]:ring-2 data-[grabbed=true]:ring-2`}
									>
										{row.expandable ? (
											<span
												aria-hidden="true"
												className="text-muted-foreground flex size-4 shrink-0 items-center"
												onClick={(event) => {
													event.stopPropagation();
													onToggle(row.key, !row.expanded);
												}}
											>
												{row.expanded ? (
													<ChevronDownIcon className="size-3.5" />
												) : (
													<ChevronRightIcon className="size-3.5 rtl:rotate-180" />
												)}
											</span>
										) : (
											<span aria-hidden="true" className="size-4 shrink-0" />
										)}
										{renaming === row.key && row.kind === "node" && row.node.type === "element" ? (
											<RenameInput
												initial={row.node.label ?? ""}
												tag={row.node.tag}
												onDone={(label) => {
													setRenaming(null);
													if (label !== undefined && row.kind === "node") onRename(row.path, label);
													afterRender(() =>
														list.current
															?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(row.key)}"]`)
															?.focus(),
													);
												}}
											/>
										) : (
											<>
												<span
													className={`truncate ${named.kind === "value" ? "font-mono text-xs" : ""} ${named.kind === "list" ? "text-muted-foreground italic" : ""}`}
												>
													{row.kind === "node" && row.node.type === "component" ? (
														<ComponentIcon aria-hidden="true" />
													) : row.kind === "node" && row.node.type === "loop" ? (
														<RepeatIcon aria-hidden="true" />
													) : row.kind === "node" && row.node.type === "condition" ? (
														<GitBranchIcon aria-hidden="true" />
													) : row.kind === "node" && row.node.type === "value" ? (
														<BracesIcon aria-hidden="true" />
													) : null}
													{named.name}
													{row.kind === "node" &&
													row.node.type === "loop" &&
													(row.count ?? counts?.[`b:${pathKey(row.path)}`]) !== undefined
														? ` ×${row.count ?? counts?.[`b:${pathKey(row.path)}`]}`
														: ""}
												</span>
												{row.kind === "node" && row.node.type === "component" && onHidden ? (
													<button
														type="button"
														tabIndex={-1}
														aria-label={t(
															row.node.hidden ? "builder.layers.showPlacement" : "builder.layers.hidePlacement",
														)}
														onKeyDown={(event) => event.stopPropagation()}
														onClick={(event) => {
															event.stopPropagation();
															if (row.node.type === "component") onHidden(row.path, !row.node.hidden, row.source);
														}}
													>
														{row.node.hidden ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
													</button>
												) : null}
												{row.pages && row.pages > 1 ? (
													<span className="text-xs">{t("builder.layers.onPages", { count: row.pages })}</span>
												) : null}
												{named.detail ? (
													<span className="text-muted-foreground truncate text-xs">{named.detail}</span>
												) : null}
												{fixed ? (
													<Badge
														variant="outline"
														className="ms-auto shrink-0 border-amber-600 text-amber-800 dark:border-amber-400 dark:text-amber-200"
													>
														{t("builder.fixedText.badge")}
													</Badge>
												) : null}
											</>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
			<p id="layers-keys" className="text-muted-foreground border-t px-3 py-2 text-xs">
				{t("builder.layers.keys")}
			</p>
		</div>
	);
}

/** Renaming a layer in place: Enter keeps the name, Escape keeps the old one. Blank removes the label. */
function RenameInput({ initial, tag, onDone }: { initial: string; tag: string; onDone(label?: string): void }) {
	const t = useT();
	const [value, setValue] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	return (
		<Input
			ref={input}
			value={value}
			maxLength={100}
			aria-label={t("builder.layers.renameLabel", { tag })}
			className="h-7 text-sm"
			onChange={(event) => setValue(event.target.value)}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Enter") onDone(value);
				if (event.key === "Escape") onDone();
			}}
			onBlur={() => onDone(value)}
		/>
	);
}
