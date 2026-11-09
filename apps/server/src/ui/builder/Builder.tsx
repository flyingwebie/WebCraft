import { Link } from "@tanstack/react-router";
import type { FieldInput } from "@webcraft/core";
import { type ElementTree, hasText, type TreeNode } from "@webcraft/renderer/builder";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	ArrowLeftIcon,
	CodeIcon,
	LayoutPanelLeftIcon,
	MonitorIcon,
	MoonIcon,
	Redo2Icon,
	SmartphoneIcon,
	TabletIcon,
	TypeIcon,
	Undo2Icon,
	UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { StatusBadge } from "../content/DraftParts.tsx";
import { Announcer } from "../content/reorder.tsx";
import { errorCode, errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { Canvas, type CanvasTarget, type CanvasWidth } from "./Canvas.tsx";
import { FixedTextDialog, type MadeEditable } from "./FixedTextDialog.tsx";
import { InsertDialog, type InsertWhere } from "./InsertDialog.tsx";
import { Inspector } from "./Inspector.tsx";
import { type DropPosition, type LayerAction, LayersPanel, rowKey } from "./LayersPanel.tsx";
import { type MarkupProblem, MarkupView } from "./MarkupView.tsx";
import {
	type BuilderDoc,
	type BuilderTarget,
	type Catalogue,
	layerName,
	type Opened,
	type Selection,
	targetTitle,
} from "./model.ts";
import { publishDraft, saveDraft } from "./save.ts";
import {
	type Changed,
	canHoldChildren,
	childLists,
	copiedIds,
	insertAt,
	isFixedText,
	isFormatting,
	listAt,
	moveDown,
	moveIntoPrevious,
	moveOut,
	moveTo,
	moveUp,
	type NodePath,
	nodeAt,
	type Place,
	pathOfId,
	placeOf,
	type Refused,
	removeAt,
	replaceAt,
	treeProblem,
	withNewIds,
} from "./tree.ts";

/** The most steps undo goes back. */
const HISTORY = 200;

/** A problem of a tree the server refused, where it is (`nodes[0].children[2]`, `styles.<element id>`). */
type TreeProblem = { at: string; message: string };

function docOf(opened: Opened): BuilderDoc {
	return { tree: opened.tree, styles: {}, props: (opened.props as FieldInput[] | null) ?? null };
}

/**
 * The visual builder (#66): one Template or Component, full-screen, for Staff. Its own top bar (back
 * to the admin, the name, where its Draft stands, the Visual and Template markup views, the canvas's
 * width and light/dark preview, fixed text shown or not, undo and redo, Save and Publish), then the
 * Layers panel, the canvas and the selected layer's settings and styles. The builder and the Template
 * markup view are two views of one Draft: both save through the same markup save.
 */
export function Builder({
	siteId,
	target,
	initial,
	back,
}: {
	siteId: string;
	target: BuilderTarget;
	initial: Opened;
	back: { to: "/sites/$siteId/templates" | "/sites/$siteId/components"; label: string };
}) {
	const t = useT();
	const [opened, setOpened] = useState(initial);
	const [doc, setDoc] = useState<BuilderDoc>(() => docOf(initial));
	const [saved, setSaved] = useState(() => JSON.stringify(docOf(initial)));
	const history = useRef<{ past: BuilderDoc[]; future: BuilderDoc[] }>({ past: [], future: [] });
	const [, setHistoryVersion] = useState(0);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [grab, setGrab] = useState<{ doc: BuilderDoc; selection: Selection; past: BuilderDoc[] } | null>(null);
	const [view, setView] = useState<"visual" | "markup">("visual");
	const [markup, setMarkup] = useState("");
	const [markupBase, setMarkupBase] = useState("");
	const [markupProblems, setMarkupProblems] = useState<MarkupProblem[]>([]);
	const [preview, setPreview] = useState<{ html: string; css: string } | null>(null);
	const [problems, setProblems] = useState<TreeProblem[]>([]);
	const [theme, setTheme] = useState<"light" | "dark">("light");
	const [width, setWidth] = useState<CanvasWidth>("desktop");
	const [showFixed, setShowFixed] = useState(true);
	const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
	const [insertOpen, setInsertOpen] = useState(false);
	const [insertWhere, setInsertWhere] = useState<InsertWhere>("inside");
	const [fixedTextAt, setFixedTextAt] = useState<NodePath | null>(null);
	const [conflict, setConflict] = useState<{ version: string | null } | null>(null);
	const [busy, setBusy] = useState<"save" | "publish" | "switch" | null>(null);
	const [designVersion, setDesignVersion] = useState(0);
	const [focusLayers, setFocusLayers] = useState(0);
	/** What Cut and Copy took: the layers, and the unsaved one-off styles of the elements in them. */
	const clipboard = useRef<{ nodes: TreeNode[]; styles: Record<string, string> } | null>(null);
	const insertTrigger = useRef<HTMLButtonElement | null>(null);
	const fixedTextTrigger = useRef<HTMLElement | null>(null);
	const docRef = useRef(doc);
	docRef.current = doc;

	const catalogue = opened.catalogue;
	const allows = useMemo(
		() => ({ elements: new Set(catalogue.elements), commands: new Set(catalogue.commands) }),
		[catalogue],
	);
	const title = targetTitle(t, opened, target);
	const dirty = JSON.stringify(doc) !== saved || (view === "markup" && markup !== markupBase);
	const status = opened.template?.status ?? opened.component?.status ?? null;
	const fixedTextAction = target.kind === "component" ? "prop" : target.kind === "entryTemplate" ? "field" : "global";
	/** A Component's Props, sent only when the builder changed them (else the Draft's stay as they are). */
	const propsChange = useCallback(
		(from: BuilderDoc): { props?: FieldInput[] } =>
			from.props && JSON.stringify(from.props) !== JSON.stringify(opened.props) ? { props: from.props } : {},
		[opened.props],
	);

	const announce = useCallback((text: string) => {
		setAnnouncement((before) => ({ text, count: before.count + 1 }));
	}, []);

	// ---------------------------------------------------------------------------------------------
	// Changing the Draft

	/** Applies a change, kept for undo, once the tree still keeps every rule; answers why not. */
	const apply = useCallback(
		(next: BuilderDoc, select: Selection | null, message: string): string | undefined => {
			const problem = treeProblem(next.tree, allows);
			if (problem) {
				announce(problem.message);
				return problem.message;
			}
			history.current = {
				past: [...history.current.past.slice(-HISTORY + 1), docRef.current],
				future: [],
			};
			setHistoryVersion((count) => count + 1);
			setDoc(next);
			setSelection(select);
			announce(message);
			return undefined;
		},
		[allows, announce],
	);

	const nameAt = (tree: ElementTree, path: NodePath) => {
		const node = nodeAt(tree, path);
		return node ? layerName(t, node, catalogue).name : "";
	};

	/** Where a layer is now, in words: "2 of 4 in section · Hero". */
	const whereIs = (tree: ElementTree, path: NodePath) => {
		const place = placeOf(path);
		const siblings = listAt(tree, place)
			.map((node, index) => ({ node, index }))
			.filter(({ node }) => !isFormatting(node));
		const position = siblings.findIndex(({ index }) => index === place.index) + 1;
		const owner = place.owner ? nameAt(tree, place.owner) : t("builder.moves.top");
		return t("builder.moves.where", { position, count: siblings.length, owner });
	};

	const applyMove = (result: Changed | Refused, name: string) => {
		if ("refused" in result) {
			announce(t(`builder.moves.refused.${result.refused as "first"}`, { name }));
			return;
		}
		apply(
			{ ...doc, tree: result.tree },
			{ kind: "node", path: result.path },
			t("builder.moves.moved", { name, where: whereIs(result.tree, result.path) }),
		);
	};

	/** Where something goes beside or inside a layer. */
	const placeBy = (path: NodePath, position: DropPosition | InsertWhere): Place => {
		const node = nodeAt(doc.tree, path);
		const place = placeOf(path);
		if (position === "inside" && node && canHoldChildren(node)) {
			return { owner: path, list: 0, index: childLists(node)[0]?.length ?? 0 };
		}
		return position === "before" ? place : { ...place, index: place.index + 1 };
	};

	const act = (action: LayerAction) => {
		if (action === "paste") return paste();
		if (selection?.kind !== "node") return;
		const { path } = selection;
		const node = nodeAt(doc.tree, path);
		if (!node) return;
		const name = layerName(t, node, catalogue).name;
		switch (action) {
			case "moveUp":
				return applyMove(moveUp(doc.tree, path), name);
			case "moveDown":
				return applyMove(moveDown(doc.tree, path), name);
			case "moveIn":
				return applyMove(moveIntoPrevious(doc.tree, path), name);
			case "moveOut":
				return applyMove(moveOut(doc.tree, path), name);
			case "copy":
				clipboard.current = { nodes: [node], styles: doc.styles };
				announce(t("builder.moves.copied", { name }));
				return;
			case "cut":
			case "delete": {
				if (action === "cut") clipboard.current = { nodes: [node], styles: doc.styles };
				const tree = removeAt(doc.tree, path);
				const place = placeOf(path);
				const siblings = listAt(tree, place);
				const next =
					siblings.findIndex((each, index) => index >= place.index && !isFormatting(each)) >= 0
						? {
								kind: "node" as const,
								path: [
									...path.slice(0, -1),
									siblings.findIndex((each, index) => index >= place.index && !isFormatting(each)),
								],
							}
						: place.owner
							? { kind: "node" as const, path: place.owner }
							: null;
				const styles = { ...doc.styles };
				if (node.type === "element") delete styles[node.id];
				apply(
					{ ...doc, tree, styles },
					next,
					t(action === "cut" ? "builder.moves.cut" : "builder.moves.deleted", { name }),
				);
				return;
			}
			case "duplicate": {
				const copies = withNewIds(doc.tree, [node]);
				const made = insertAt(doc.tree, placeBy(path, "after"), copies);
				apply(
					{ ...doc, tree: made.tree, styles: withCopiedStyles(doc.styles, [node], copies, doc.styles) },
					{ kind: "node", path: made.path },
					t("builder.moves.duplicated", { name, where: whereIs(made.tree, made.path) }),
				);
				return;
			}
			case "rename":
				announce(t("builder.layers.renameElementsOnly"));
				return;
		}
	};

	const paste = () => {
		const copied = clipboard.current;
		if (!copied || !selection) {
			announce(t("builder.moves.nothingToPaste"));
			return;
		}
		const nodes = withNewIds(doc.tree, copied.nodes);
		const place: Place =
			selection.kind === "list"
				? { ...selection.list, index: listAt(doc.tree, selection.list).length }
				: placeBy(selection.path, "after");
		const made = insertAt(doc.tree, place, nodes);
		const name = nameAt(made.tree, made.path);
		apply(
			{ ...doc, tree: made.tree, styles: withCopiedStyles(doc.styles, copied.nodes, nodes, copied.styles) },
			{ kind: "node", path: made.path },
			t("builder.moves.pasted", { name, where: whereIs(made.tree, made.path) }),
		);
	};

	const grabChange = (change: "pick" | "drop" | "cancel") => {
		if (selection?.kind !== "node") return;
		const name = nameAt(doc.tree, selection.path);
		if (change === "pick") {
			setGrab({ doc, selection, past: history.current.past });
			announce(t("builder.moves.picked", { name }));
		} else if (change === "drop") {
			setGrab(null);
			announce(t("builder.moves.dropped", { name, where: whereIs(doc.tree, selection.path) }));
		} else if (grab) {
			history.current = { past: grab.past, future: [] };
			setHistoryVersion((count) => count + 1);
			setDoc(grab.doc);
			setSelection(grab.selection);
			setGrab(null);
			announce(
				t("builder.moves.putBack", { name: nameAt(grab.doc.tree, (grab.selection as { path: NodePath }).path) }),
			);
		}
	};

	const dropOn = (from: NodePath, to: NodePath, position: DropPosition) => {
		const name = nameAt(doc.tree, from);
		applyMove(moveTo(doc.tree, from, placeBy(to, position)), name);
	};

	const canvasMove = (from: CanvasTarget, to: CanvasTarget, position: DropPosition) => {
		const fromPath = pathOfId(doc.tree, from.id);
		const toPath = pathOfId(doc.tree, to.id);
		if (fromPath && toPath) dropOn(fromPath, toPath, position);
	};

	const undo = useCallback(() => {
		const { past, future } = history.current;
		const previous = past.at(-1);
		if (!previous) return;
		history.current = { past: past.slice(0, -1), future: [docRef.current, ...future] };
		setHistoryVersion((count) => count + 1);
		setDoc(previous);
		announce(t("builder.undone"));
	}, [announce, t]);

	const redo = useCallback(() => {
		const { past, future } = history.current;
		const next = future[0];
		if (!next) return;
		history.current = { past: [...past, docRef.current], future: future.slice(1) };
		setHistoryVersion((count) => count + 1);
		setDoc(next);
		announce(t("builder.redone"));
	}, [announce, t]);

	const insert = (nodes: TreeNode[]): string | undefined => {
		const place: Place =
			selection?.kind === "node"
				? placeBy(selection.path, insertWhere)
				: selection?.kind === "list"
					? { ...selection.list, index: listAt(doc.tree, selection.list).length }
					: { owner: null, list: 0, index: doc.tree.nodes.length };
		const made = insertAt(doc.tree, place, nodes);
		const name = nameAt(made.tree, made.path);
		return apply(
			{ ...doc, tree: made.tree },
			{ kind: "node", path: made.path },
			t("builder.moves.inserted", { name, where: whereIs(made.tree, made.path) }),
		);
	};

	const replace = (path: NodePath, node: TreeNode, message: string) =>
		apply({ ...doc, tree: replaceAt(doc.tree, path, node) }, { kind: "node", path }, message);

	const generatedIds = useMemo(
		() => new Set(catalogue.classes.filter((each) => each.generated).map((each) => each.id)),
		[catalogue],
	);

	const madeEditable = (made: MadeEditable) => {
		if (!fixedTextAt) return;
		const next: BuilderDoc = {
			...doc,
			tree: replaceAt(doc.tree, fixedTextAt, { type: "value", path: made.path }),
			props: made.props ?? doc.props,
		};
		if (!catalogue.values.some((value) => value.path === made.path)) {
			const group = made.path.startsWith("props.") ? "props" : made.path.startsWith("site.") ? "globals" : "entry";
			setOpened((before) => ({
				...before,
				catalogue: {
					...before.catalogue,
					values: [...before.catalogue.values, { path: made.path, label: made.label, type: "text", group }],
				},
			}));
		}
		apply(next, { kind: "node", path: fixedTextAt }, t("builder.fixedText.made", { binding: `{{ ${made.path} }}` }));
		setFixedTextAt(null);
	};

	// ---------------------------------------------------------------------------------------------
	// The canvas

	// biome-ignore lint/correctness/useExhaustiveDependencies: a change to the Design system's Draft (`designVersion`) shows too.
	useEffect(() => {
		if (view !== "visual") return;
		let current = true;
		const handle = setTimeout(async () => {
			try {
				const api = await getApi();
				const shown = await api.builder.preview({
					siteId,
					target,
					tree: doc.tree,
					styles: doc.styles,
					...propsChange(doc),
				});
				if (!current) return;
				setPreview(shown);
				setProblems([]);
			} catch (failure) {
				if (current) setProblems(treeProblemsOf(failure, t(errorMessage(failure))));
			}
		}, 150);
		return () => {
			current = false;
			clearTimeout(handle);
		};
	}, [doc, view, siteId, target, designVersion, t, propsChange]);

	// In the Template markup view the canvas follows the markup, read as switching back would read it.
	useEffect(() => {
		if (view !== "markup") return;
		let current = true;
		const handle = setTimeout(async () => {
			try {
				const api = await getApi();
				const read = await api.builder.read({ siteId, target, markup, ...propsChange(doc) });
				const shown = await api.builder.preview({
					siteId,
					target,
					tree: read.tree,
					styles: read.styles,
					...propsChange(doc),
				});
				if (!current) return;
				setPreview(shown);
				setMarkupProblems([]);
			} catch (failure) {
				if (current) setMarkupProblems(markupProblemsOf(failure, t(errorMessage(failure))));
			}
		}, 400);
		return () => {
			current = false;
			clearTimeout(handle);
		};
	}, [markup, view, siteId, target, doc, t, propsChange]);

	const placeholderWords = useCallback(
		(kind: string, name: string | null) => {
			const known = ["outlet", "form", "filter", "search", "themeToggle", "languageSwitcher", "consentSettings"];
			const which = (known.includes(kind) ? kind : "outlet") as "outlet";
			return t(`builder.canvas.placeholders.${which}`, { name: name ?? "" });
		},
		[t],
	);

	const selectedNode = selection?.kind === "node" ? nodeAt(doc.tree, selection.path) : undefined;
	const canvasSelected: CanvasTarget | null =
		selectedNode?.type === "element"
			? { kind: "element", id: selectedNode.id }
			: selectedNode?.type === "component"
				? { kind: "placement", id: selectedNode.id }
				: null;
	const fixedIds = useMemo(() => {
		if (!showFixed) return [];
		const ids: string[] = [];
		const visit = (nodes: readonly TreeNode[]) => {
			for (const node of nodes) {
				if (node.type === "element" && node.children.some(isFixedText)) ids.push(node.id);
				for (const list of childLists(node)) visit(list);
			}
		};
		visit(doc.tree.nodes);
		return ids;
	}, [doc.tree, showFixed]);
	const fixedCount = useMemo(() => {
		let count = 0;
		const visit = (nodes: readonly TreeNode[]) => {
			for (const node of nodes) {
				if (node.type === "text" && hasText(node)) count++;
				for (const list of childLists(node)) visit(list);
			}
		};
		visit(doc.tree.nodes);
		return count;
	}, [doc.tree]);

	// ---------------------------------------------------------------------------------------------
	// Views, saving and publishing

	const switchView = async (next: "visual" | "markup") => {
		if (next === view || busy) return;
		setBusy("switch");
		try {
			const api = await getApi();
			if (next === "markup") {
				const printed = await api.builder.markup({
					siteId,
					target,
					tree: doc.tree,
					styles: doc.styles,
					...propsChange(doc),
				});
				setMarkup(printed.markup);
				setMarkupBase(printed.markup);
				setMarkupProblems([]);
				setView("markup");
				announce(t("builder.view.toMarkup"));
			} else {
				if (markup !== markupBase) {
					const read = await api.builder.read({ siteId, target, markup, ...propsChange(doc) });
					apply({ ...doc, tree: read.tree, styles: read.styles }, null, t("builder.view.toVisual"));
				} else {
					announce(t("builder.view.toVisual"));
				}
				setView("visual");
			}
		} catch (failure) {
			if (next === "visual") setMarkupProblems(markupProblemsOf(failure, t(errorMessage(failure))));
			else setProblems(treeProblemsOf(failure, t(errorMessage(failure))));
			announce(t("builder.view.cantSwitch"));
		} finally {
			setBusy(null);
		}
	};

	/** Saves the Draft; answers the builder reopened on what was saved, or null when it wasn't. */
	const save = async (over?: { version: string | null }): Promise<Opened | null> => {
		setBusy("save");
		const started = docRef.current;
		try {
			const api = await getApi();
			const text =
				view === "markup"
					? markup
					: (
							await api.builder.markup({
								siteId,
								target,
								tree: started.tree,
								styles: started.styles,
								...propsChange(started),
							})
						).markup;
			const stored = await saveDraft(api, siteId, target, {
				markup: text,
				props: propsChange(started).props ?? null,
				basedOn: over ? over.version : opened.version,
			});
			const fresh = await api.builder.open({ siteId, target });
			setOpened(fresh);
			setConflict(null);
			if (docRef.current === started) {
				const next = docOf(fresh);
				setDoc(next);
				setSaved(JSON.stringify(next));
				setSelection((before) => (before?.kind === "node" && !nodeAt(next.tree, before.path) ? null : before));
			} else {
				setSaved(JSON.stringify(docOf(fresh)));
			}
			if (view === "markup") {
				setMarkup(stored.markup);
				setMarkupBase(stored.markup);
			}
			setProblems([]);
			setMarkupProblems([]);
			toast.success(t("builder.saved", { name: title }));
			announce(t("builder.saved", { name: title }));
			return fresh;
		} catch (failure) {
			if (errorCode(failure) === "CHANGED_MEANWHILE") {
				const version = (failure as { data?: { version?: string | null } }).data?.version ?? null;
				setConflict({ version });
			} else if (view === "markup") {
				setMarkupProblems(markupProblemsOf(failure, t(errorMessage(failure))));
				toast.error(t("builder.notSaved"));
			} else {
				setProblems(treeProblemsOf(failure, t(errorMessage(failure))));
				toast.error(t("builder.notSaved"));
			}
			return null;
		} finally {
			setBusy(null);
		}
	};

	const publish = async () => {
		let current: Opened | null = opened;
		if (dirty) current = await save();
		if (!current) return;
		if (target.kind !== "component" && !current.template) {
			toast.error(t("builder.saveFirst"));
			return;
		}
		setBusy("publish");
		try {
			const api = await getApi();
			await publishDraft(api, siteId, target, current.template?.id ?? null);
			setOpened(await api.builder.open({ siteId, target }));
			toast.success(t("builder.published", { name: title }));
			announce(t("builder.published", { name: title }));
		} catch (failure) {
			const listed = (failure as { data?: { problems?: { message: string }[] } }).data?.problems;
			toast.error(listed?.length ? listed.map((each) => each.message).join(" ") : t(errorMessage(failure)));
		} finally {
			setBusy(null);
		}
	};

	const reload = async () => {
		const api = await getApi();
		const fresh = await api.builder.open({ siteId, target });
		const next = docOf(fresh);
		setOpened(fresh);
		setDoc(next);
		setSaved(JSON.stringify(next));
		setSelection(null);
		history.current = { past: [], future: [] };
		setConflict(null);
		if (view === "markup") {
			const printed = await api.builder.markup({ siteId, target, tree: next.tree });
			setMarkup(printed.markup);
			setMarkupBase(printed.markup);
		}
	};

	// Leaving with unsaved changes asks first.
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	// Ctrl/⌘ S saves; Ctrl/⌘ Z and Shift+Z (or Y) undo and redo, outside text being typed; Ctrl/⌘ I inserts.
	const keys = useRef({ save, undo, redo, view });
	keys.current = { save, undo, redo, view };
	const shortcut = useRef<(event: KeyboardEvent) => void>(() => {});
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
			const key = event.key.toLowerCase();
			if (key === "s") {
				event.preventDefault();
				void keys.current.save();
				return;
			}
			const typing = (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
			if (typing || keys.current.view !== "visual") return;
			if (key === "z" || key === "y") {
				event.preventDefault();
				if (key === "y" || event.shiftKey) keys.current.redo();
				else keys.current.undo();
			} else if (key === "i") {
				event.preventDefault();
				setInsertOpen(true);
			}
		};
		shortcut.current = onKey;
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const openInsert = () => {
		const node = selection?.kind === "node" ? nodeAt(doc.tree, selection.path) : undefined;
		setInsertWhere(node && canHoldChildren(node) ? "inside" : "after");
		setInsertOpen(true);
	};

	const oneOffOf = (elementId: string, classIds: readonly string[]) =>
		doc.styles[elementId] ??
		classIds
			.filter((id) => generatedIds.has(id))
			.map((id) => catalogue.classes.find((each) => each.id === id)?.styles ?? "")
			.join(" ");

	const problemPath = (at: string): NodePath | undefined => {
		if (at.startsWith("styles.")) return pathOfId(doc.tree, at.slice(7));
		return pathFromAt(doc.tree, at);
	};

	const widths: readonly { width: CanvasWidth; icon: typeof MonitorIcon }[] = [
		{ width: "desktop", icon: MonitorIcon },
		{ width: "tablet", icon: TabletIcon },
		{ width: "phone", icon: SmartphoneIcon },
	];
	const selectedNodeForInsert = selection?.kind === "node" ? nodeAt(doc.tree, selection.path) : undefined;

	return (
		<div className="bg-background flex h-svh flex-col">
			<header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<Link to={back.to} params={{ siteId }} className={buttonVariants({ variant: "ghost", size: "sm" })}>
					<ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
					{back.label}
				</Link>
				<div className="flex min-w-0 items-center gap-2">
					<h1 className="truncate text-base font-semibold">{title}</h1>
					<Badge variant="outline">{t(`builder.kinds.${target.kind}`)}</Badge>
					{status ? <StatusBadge status={status} /> : <Badge variant="outline">{t("builder.status.new")}</Badge>}
					{dirty ? <Badge variant="secondary">{t("builder.status.unsaved")}</Badge> : null}
				</div>
				<div className="ms-auto flex flex-wrap items-center gap-1">
					<fieldset className="flex rounded-md border p-0.5">
						<legend className="sr-only">{t("builder.view.label")}</legend>
						<Button
							type="button"
							size="sm"
							variant={view === "visual" ? "secondary" : "ghost"}
							aria-pressed={view === "visual"}
							disabled={busy !== null}
							onClick={() => void switchView("visual")}
						>
							<LayoutPanelLeftIcon aria-hidden="true" />
							{t("builder.view.visual")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant={view === "markup" ? "secondary" : "ghost"}
							aria-pressed={view === "markup"}
							disabled={busy !== null}
							onClick={() => void switchView("markup")}
						>
							<CodeIcon aria-hidden="true" />
							{t("builder.view.markup")}
						</Button>
					</fieldset>
					<fieldset className="flex rounded-md border p-0.5">
						<legend className="sr-only">{t("builder.width.label")}</legend>
						{widths.map(({ width: each, icon: Icon }) => (
							<Button
								key={each}
								type="button"
								size="icon-sm"
								variant={width === each ? "secondary" : "ghost"}
								aria-pressed={width === each}
								aria-label={t(`builder.width.${each}`)}
								title={t(`builder.width.${each}`)}
								onClick={() => setWidth(each)}
							>
								<Icon aria-hidden="true" />
							</Button>
						))}
					</fieldset>
					<Button
						type="button"
						size="sm"
						variant={theme === "dark" ? "secondary" : "ghost"}
						aria-pressed={theme === "dark"}
						onClick={() => {
							const next = theme === "dark" ? "light" : "dark";
							setTheme(next);
							announce(
								next === "dark"
									? opened.darkMode
										? t("builder.theme.darkOn")
										: t("builder.theme.noDarkMode")
									: t("builder.theme.lightOn"),
							);
						}}
					>
						<MoonIcon aria-hidden="true" />
						{t("builder.theme.dark")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant={showFixed ? "secondary" : "ghost"}
						aria-pressed={showFixed}
						onClick={() => setShowFixed((before) => !before)}
					>
						<TypeIcon aria-hidden="true" />
						{t("builder.fixedText.show", { count: fixedCount })}
					</Button>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label={t("builder.undo")}
						title={t("builder.undo")}
						aria-keyshortcuts="Control+Z"
						disabled={view !== "visual" || history.current.past.length === 0}
						onClick={undo}
					>
						<Undo2Icon aria-hidden="true" />
					</Button>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label={t("builder.redo")}
						title={t("builder.redo")}
						aria-keyshortcuts="Control+Shift+Z"
						disabled={view !== "visual" || history.current.future.length === 0}
						onClick={redo}
					>
						<Redo2Icon aria-hidden="true" />
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						aria-keyshortcuts="Control+S"
						disabled={busy !== null || !dirty}
						onClick={() => void save()}
					>
						{busy === "save" ? t("builder.saving") : t("builder.save")}
					</Button>
					<Button type="button" size="sm" disabled={busy !== null} onClick={() => void publish()}>
						<UploadIcon aria-hidden="true" />
						{busy === "publish" ? t("builder.publishing") : t("builder.publish")}
					</Button>
				</div>
			</header>
			<main
				id="main"
				tabIndex={-1}
				className={`grid min-h-0 flex-1 outline-none ${view === "visual" ? "lg:grid-cols-[18rem_minmax(0,1fr)_20rem]" : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"}`}
			>
				{view === "visual" ? (
					<section aria-labelledby="layers-heading" className="flex min-h-0 flex-col border-e">
						<LayersPanel
							tree={doc.tree}
							catalogue={catalogue}
							selection={selection}
							collapsed={collapsed}
							grabbed={grab !== null}
							canPaste={clipboard.current !== null}
							onSelect={setSelection}
							onToggle={(key, open) =>
								setCollapsed((before) => {
									const next = new Set(before);
									if (open) next.delete(key);
									else next.add(key);
									return next;
								})
							}
							onAction={act}
							onGrab={grabChange}
							onRename={(path, label) => {
								const node = nodeAt(doc.tree, path);
								if (node?.type !== "element" || (node.label ?? "") === label) return;
								const { label: _, ...rest } = node;
								replace(
									path,
									label.trim() ? { ...rest, label } : rest,
									label.trim() ? t("builder.layers.renamed", { name: label }) : t("builder.layers.unnamed"),
								);
							}}
							onDrop={dropOn}
							focusRequest={focusLayers}
							onInsert={() => {
								insertTrigger.current = document.activeElement as HTMLButtonElement;
								openInsert();
							}}
						/>
					</section>
				) : (
					<section aria-label={t("builder.markup.label")} className="flex min-h-0 flex-col border-e">
						<MarkupView value={markup} onChange={setMarkup} problems={markupProblems} />
					</section>
				)}
				<section aria-label={t("builder.canvas.label")} className="bg-muted flex min-h-[24rem] flex-col">
					{problems.length > 0 && view === "visual" ? (
						<div aria-live="polite" className="border-destructive/40 bg-destructive/5 border-b px-3 py-2 text-sm">
							<p className="font-medium">{t("builder.problems")}</p>
							<ul className="grid gap-1">
								{problems.map((problem, index) => {
									const path = problemPath(problem.at);
									return (
										// biome-ignore lint/suspicious/noArrayIndexKey: problems come in the order they are found.
										<li key={index} className="text-destructive">
											{problem.message}{" "}
											{path ? (
												<button
													type="button"
													className="focus-visible:ring-ring/50 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-3"
													onClick={() => setSelection({ kind: "node", path })}
												>
													{t("builder.showLayer")}
												</button>
											) : null}
										</li>
									);
								})}
							</ul>
						</div>
					) : null}
					{theme === "dark" && !opened.darkMode ? (
						<p className="text-muted-foreground border-b px-3 py-2 text-sm">{t("builder.theme.noDarkMode")}</p>
					) : null}
					<Canvas
						html={preview?.html ?? null}
						css={preview?.css ?? ""}
						language={opened.language.code}
						direction={opened.language.direction}
						theme={theme}
						width={width}
						title={t("builder.canvas.title", { name: title })}
						selected={view === "visual" ? canvasSelected : null}
						selectedName={selectedNode ? layerName(t, selectedNode, catalogue).name : null}
						fixedText={view === "visual" ? fixedIds : []}
						placeholderWords={placeholderWords}
						onSelect={(found) => {
							const path = pathOfId(doc.tree, found.id);
							if (!path || view !== "visual") return;
							setSelection({ kind: "node", path });
							setFocusLayers((count) => count + 1);
							const node = nodeAt(doc.tree, path);
							if (node) announce(t("builder.selected", { name: layerName(t, node, catalogue).name }));
							// Every layer on the way to it opens.
							setCollapsed((before) => {
								const next = new Set(before);
								for (let length = 1; length < path.length; length += 2) {
									const owner = path.slice(0, length);
									const ownerNode = nodeAt(doc.tree, owner);
									if (ownerNode) next.delete(rowKey(ownerNode, owner));
								}
								return next;
							});
						}}
						onMove={canvasMove}
						onShortcut={(event) => shortcut.current(event)}
					/>
				</section>
				{view === "visual" ? (
					<section aria-labelledby="inspector-heading" className="flex min-h-0 flex-col border-s">
						<Inspector
							siteId={siteId}
							tree={doc.tree}
							selection={selection}
							catalogue={catalogue}
							oneOffOf={oneOffOf}
							fixedTextAction={fixedTextAction}
							onReplace={replace}
							onClasses={(path, classIds, message) => {
								const node = nodeAt(doc.tree, path);
								if (node?.type === "element") replace(path, { ...node, classes: classIds }, message);
							}}
							onOneOff={(path, elementId, declarations) => {
								const node = nodeAt(doc.tree, path);
								if (node?.type !== "element") return;
								const styles = { ...doc.styles };
								if (declarations) styles[elementId] = declarations;
								else delete styles[elementId];
								apply(
									{
										...doc,
										tree: replaceAt(doc.tree, path, {
											...node,
											classes: node.classes.filter((id) => !generatedIds.has(id)),
										}),
										styles,
									},
									{ kind: "node", path },
									declarations ? t("builder.style.oneOffApplied") : t("builder.style.oneOffRemoved"),
								);
							}}
							onCatalogue={(classes: Catalogue["classes"]) => {
								setOpened((before) => ({ ...before, catalogue: { ...before.catalogue, classes } }));
								setDesignVersion((count) => count + 1);
							}}
							onMakeEditable={(path, trigger) => {
								fixedTextTrigger.current = trigger;
								setFixedTextAt(path);
							}}
						/>
					</section>
				) : null}
				<Announcer message={`${announcement.text}${announcement.count % 2 === 0 ? "" : " "}`} />
			</main>
			<InsertDialog
				open={insertOpen}
				onOpenChange={setInsertOpen}
				finalFocus={insertTrigger}
				siteId={siteId}
				tree={doc.tree}
				catalogue={catalogue}
				where={insertWhere}
				canInside={selectedNodeForInsert ? canHoldChildren(selectedNodeForInsert) : selection?.kind === "list"}
				hasSelection={selection?.kind === "node"}
				onWhere={setInsertWhere}
				onInsert={insert}
			/>
			{fixedTextAt ? (
				<FixedTextDialog
					open
					onOpenChange={(open) => {
						if (!open) setFixedTextAt(null);
					}}
					finalFocus={fixedTextTrigger}
					target={fixedTextAction}
					text={(() => {
						const node = nodeAt(doc.tree, fixedTextAt);
						return node?.type === "text" ? node.text.trim() : "";
					})()}
					siteId={siteId}
					postTypeId={target.kind === "entryTemplate" ? target.postTypeId : null}
					props={doc.props}
					onMade={madeEditable}
				/>
			) : null}
			<Dialog open={conflict !== null} onOpenChange={(open) => (open ? undefined : setConflict(null))}>
				<DialogContent closeLabel={t("builder.conflict.close")}>
					<DialogHeader>
						<DialogTitle>{t("builder.conflict.title")}</DialogTitle>
						<DialogDescription>{t("builder.conflict.body", { name: title })}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => void reload()}>
							{t("builder.conflict.reload")}
						</Button>
						<Button type="button" onClick={() => void save({ version: conflict?.version ?? null })}>
							{t("builder.conflict.overwrite")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** One-off styles with those of copied elements given to their copies too. */
function withCopiedStyles(
	styles: Record<string, string>,
	originals: readonly TreeNode[],
	copies: readonly TreeNode[],
	from: Record<string, string>,
): Record<string, string> {
	const next = { ...styles };
	for (const [original, copy] of copiedIds(originals, copies)) {
		const style = from[original];
		if (style) next[copy] = style;
	}
	return next;
}

/** The problems of a tree the server refused, else one problem in the admin's words. */
function treeProblemsOf(failure: unknown, fallback: string): TreeProblem[] {
	const listed = (failure as { data?: { problems?: { at?: string; message: string }[] } }).data?.problems;
	if (listed?.length) return listed.map((problem) => ({ at: problem.at ?? "", message: problem.message }));
	return [{ at: "", message: fallback }];
}

/** The problems of markup that can't be read, with their lines and columns. */
function markupProblemsOf(failure: unknown, fallback: string): MarkupProblem[] {
	const listed = (failure as { data?: { problems?: { line?: number; column?: number; message: string }[] } }).data
		?.problems;
	if (listed?.length) {
		return listed.map((problem) => ({
			line: problem.line ?? 1,
			column: problem.column ?? 1,
			message: problem.message,
		}));
	}
	return [{ line: 1, column: 1, message: fallback }];
}

/** The node a stored tree's problem is at (`nodes[0].children[2].attributes[1]`), as far as it names one. */
function pathFromAt(tree: ElementTree, at: string): NodePath | undefined {
	const steps = [...at.matchAll(/(nodes|children|otherwise|empty|branches)\[(\d+)\]/g)];
	const path: number[] = [];
	let node: TreeNode | undefined;
	for (let index = 0; index < steps.length; index++) {
		const [, kind = "", raw = "0"] = steps[index] ?? [];
		const number = Number(raw);
		if (kind === "nodes") {
			path.push(number);
		} else if (kind === "children" && node?.type === "condition") {
			continue;
		} else if (kind === "branches") {
			const child = steps[index + 1];
			if (!child) break;
			path.push(number, Number(child[2]));
			index++;
		} else if (kind === "children") {
			path.push(0, number);
		} else if (kind === "otherwise" && node?.type === "condition") {
			path.push(node.branches.length, number);
		} else if (kind === "empty") {
			path.push(1, number);
		}
		node = nodeAt(tree, path);
		if (!node) return path.length > 1 ? path.slice(0, -2) : undefined;
	}
	return path.length > 0 ? path : undefined;
}
