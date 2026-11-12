import { Link, useNavigate } from "@tanstack/react-router";
import type { CommandMenuData, FieldInput, Permission } from "@webcraft/core";
import { type Json, reverseChange, sameValue } from "@webcraft/core/draft-document";
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
	MonitorIcon,
	MoonIcon,
	PanelLeftIcon,
	PanelRightIcon,
	Redo2Icon,
	SmartphoneIcon,
	TabletIcon,
	TypeIcon,
	Undo2Icon,
	UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import { Checks } from "../Checks.tsx";
import { type SharedDraft, useSharedDraft } from "../co-editing/shared-draft.ts";
import { StatusBadge } from "../content/DraftParts.tsx";
import { errorCode, errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { BuilderNavigation, type ReturnPage } from "./BuilderNavigation.tsx";
import { Canvas, type CanvasTarget, type CanvasWidth } from "./Canvas.tsx";
import { CommandMenu, CommandMenuButton, type MenuState, ShortcutsDialog, useEditorKeys } from "./CommandMenu.tsx";
import { ComponentScriptPanel } from "./ComponentScriptPanel.tsx";
import { CssPanel, type CssPanelPort } from "./CssPanel.tsx";
import { loopCounts } from "./canvas-metadata.ts";
import { type EditorCommandTarget, editorCommands, historyCommandTarget, type WrapKind } from "./commands.ts";
import { editorAccessibility } from "./editor-accessibility.ts";
import { type EditorDrawer, focusInto, useEditorFit } from "./editor-fit.ts";
import { editorHistory, type HistoryLocation } from "./editor-history.ts";
import { FixedTextDialog, type MadeEditable } from "./FixedTextDialog.tsx";
import { type FixedTextLocation, rememberFixedText, resolveFixedText } from "./fixed-text.ts";
import { goToCommands } from "./go-to.ts";
import { historyLanguage } from "./history-language.ts";
import { inspectorHistoryTab, revealInspectorHistory } from "./history-reveal.ts";
import { connectHistory } from "./history-transport.ts";
import { InsertToolbar } from "./InsertToolbar.tsx";
import { Inspector } from "./Inspector.tsx";
import { elementBuilder, type InsertWhere, insertItems, insertNow } from "./insert-items.tsx";
import { type DropPosition, type LayerAction, LayersPanel, rowKey } from "./LayersPanel.tsx";
import { type LayerClipboard, layerLocation, runLayerAction } from "./layer-actions.ts";
import { type MarkupProblem, MarkupView } from "./MarkupView.tsx";
import {
	type BuilderDoc,
	type BuilderTarget,
	layerName,
	type Opened,
	type Selection,
	targetPath,
	targetTitle,
} from "./model.ts";
import { publishDraft, saveDraft } from "./save.ts";
import { selectionKey, selectionOf } from "./selection-ref.ts";
import { ariaKeys, matches, withKeys } from "./shortcuts.ts";
import {
	type Changed,
	canHoldChildren,
	canUnwrap,
	childLists,
	insertAt,
	insertionPlace,
	isFixedText,
	moveTo,
	type NodePath,
	nodeAt,
	type Place,
	pathOfFilter,
	pathOfId,
	type Refused,
	replaceAt,
	placeBy as sharedPlaceBy,
	treeProblem,
	unwrapAt,
	wrapAt,
} from "./tree.ts";
import { useEditorAnnouncement } from "./use-editor-announcement.ts";

/** A problem of a tree the server refused, where it is (`nodes[0].children[2]`, `styles.<element id>`). */
type TreeProblem = { at: string; message: string };

function docOf(opened: Opened): BuilderDoc {
	return { tree: opened.tree, styles: {}, props: (opened.props as FieldInput[] | null) ?? null };
}

/**
 * One Template or Component, full-screen, with shared Layers, Inspector and docked code panels.
 * The preview canvas and Code mode on a real page edit the same shared Draft. The top bar owns
 * preview data, navigation, history, saving and publishing.
 */
export function Builder({
	siteId,
	target,
	initial,
	back,
	select,
	returnPage,
	previewEntryId,
}: {
	siteId: string;
	target: BuilderTarget;
	initial: Opened;
	back: { to: "/sites/$siteId/templates" | "/sites/$siteId/components"; label: string };
	/** What is selected when the builder opens: where a Filter is placed (the Filter builder opens it so). */
	select?: { filter: string } | { element: string };
	returnPage?: ReturnPage;
	previewEntryId?: string;
}) {
	const t = useT();
	const navigate = useNavigate();
	const [opened, setOpened] = useState(initial);
	const [doc, setDoc] = useState<BuilderDoc>(() => docOf(initial));
	const [saved, setSaved] = useState(() => JSON.stringify(docOf(initial)));
	const history = editorHistory();
	useEffect(() => {
		void connectHistory(siteId, async (method, input) => {
			const api = await getApi();
			return api.builder[method]({ siteId, ...input } as never) as never;
		});
	}, [siteId]);
	const markupStep = useRef<number | undefined>(undefined);
	const styleStep = useRef<number | undefined>(undefined);
	const [, setHistoryVersion] = useState(0);
	const [selection, setSelection] = useState<Selection | null>(() => {
		if (select && "element" in select) return selectionOf(initial.tree, select.element);
		const path = select && "filter" in select ? pathOfFilter(initial.tree, select.filter) : undefined;
		return path ? { kind: "node", path } : initial.tree.nodes.length ? { kind: "node", path: [0] } : null;
	});
	const selectedHistoryKey = selection ? selectionKey(doc.tree, selection) : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new selection ends a typing group.
	useEffect(() => {
		history.boundary();
	}, [history, selectedHistoryKey]);
	const oneOffDeparture = useRef<(() => Promise<boolean>) | null>(null);
	const inputRevision = useRef(0);
	const jsDeparture = useRef<(() => Promise<boolean>) | null>(null);
	const cssDeparture = useRef<(() => Promise<boolean>) | null>(null);
	const [entryId, setEntryId] = useState(previewEntryId ?? "");
	const [locations, setLocations] = useState<{ text: string; ranges: { key: string; start: number; end: number }[] }>({
		text: "",
		ranges: [],
	});

	useEffect(() => {
		if (!selection && doc.tree.nodes.length) setSelection({ kind: "node", path: [0] });
	}, [selection, doc.tree]);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [grab, setGrab] = useState<{
		doc: BuilderDoc;
		selection: Selection;
		before?: Json;
		complete?(): void;
	} | null>(null);
	const finishGrab = useCallback(() => {
		const complete = grab?.complete;
		if (grab) grab.complete = undefined;
		complete?.();
		setGrab(null);
	}, [grab]);
	const [markup, setMarkup] = useState("");
	const [markupBase, setMarkupBase] = useState("");
	const [markupProblems, setMarkupProblems] = useState<MarkupProblem[]>([]);
	const [preview, setPreview] = useState<{
		html: string;
		css: string;
		checks: import("@webcraft/renderer").QualityCheck[];
	} | null>(null);
	const [problems, setProblems] = useState<TreeProblem[]>([]);
	const [theme, setTheme] = useState<"light" | "dark">("light");
	const [width, setWidth] = useState<CanvasWidth>("desktop");
	// The window's width (#138): the three-sided layout, the tree and the Inspector as drawers, or covered.
	const fit = useEditorFit();
	const [drawer, setDrawer] = useState<EditorDrawer | null>(null);
	const afterRender = useAfterRender();
	const drawerReturn = useRef<Element | null>(null);
	const layersSection = useRef<HTMLElement>(null);
	const inspectorSection = useRef<HTMLElement>(null);
	const notice = useRef<HTMLDivElement>(null);
	// Narrowing to the drawer layout keeps open, as a drawer, the side that has focus.
	const [layoutShown, setLayoutShown] = useState(fit.layout);
	if (layoutShown !== fit.layout) {
		setLayoutShown(fit.layout);
		const active = typeof document === "undefined" ? null : document.activeElement;
		if (fit.layout === "drawers" && !drawer && active) {
			if (layersSection.current?.contains(active)) setDrawer("layers");
			else if (inspectorSection.current?.contains(active)) setDrawer("inspector");
		}
	}
	const [showFixed, setShowFixed] = useState(true);
	const [showChecks, setShowChecks] = useState(false);
	const [announcement, announce] = useEditorAnnouncement();
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [menuData, setMenuData] = useState<CommandMenuData | null>(null);
	const [renameRequest, setRenameRequest] = useState(0);
	const [siteCssRequest, setSiteCssRequest] = useState(0);
	const [viewRequest, setViewRequest] = useState(0);
	const [confirmPublish, setConfirmPublish] = useState(false);
	const [insertWhere, setInsertWhere] = useState<InsertWhere>("inside");
	const [fixedTextAt, setFixedTextAt] = useState<FixedTextLocation | null>(null);
	const [conflict, setConflict] = useState<{ version: string | null } | null>(null);
	const [busy, setBusy] = useState<"save" | "publish" | "switch" | null>(null);
	const [designVersion, setDesignVersion] = useState(0);
	const [focusLayers, setFocusLayers] = useState(select && "element" in select ? 1 : 0);
	/** What Cut and Copy took: the layers, and the unsaved one-off styles of the elements in them. */
	const clipboard = useRef<LayerClipboard | null>(null);
	const fixedTextTrigger = useRef<HTMLElement | null>(null);
	const docRef = useRef(doc);
	docRef.current = doc;
	const markupPending = useRef<ReturnType<SharedDraft["prepare"]>>(null);
	const markupVersion = useRef(0);
	const appliedMarkupVersion = useRef(0);
	const markupRef = useRef(markup);
	markupRef.current = markup;

	const catalogue = opened.catalogue;
	const allows = useMemo(
		() => ({ elements: new Set(catalogue.elements), commands: new Set(catalogue.commands) }),
		[catalogue],
	);
	const title = targetTitle(t, opened, target);

	const status = opened.template?.status ?? opened.component?.status ?? null;
	const fixedTextAction = target.kind === "component" ? "prop" : target.kind === "entryTemplate" ? "field" : "global";
	/** A Component's Props, sent only when the builder changed them (else the Draft's stay as they are). */
	const propsChange = useCallback(
		(from: BuilderDoc): { props?: FieldInput[] } =>
			from.props && JSON.stringify(from.props) !== JSON.stringify(opened.props) ? { props: from.props } : {},
		[opened.props],
	);
	const openedRead = useRef(0);
	const readOpened = useCallback(async () => {
		const run = ++openedRead.current;
		const fresh = await (await getApi()).builder.open({ siteId, target });
		// Background reads must not replace a newer catalogue, including one created by a save.
		if (run === openedRead.current) setOpened(fresh);
		return fresh;
	}, [siteId, target]);
	const patchOpened = (change: (before: Opened) => Opened) => {
		openedRead.current++;
		setOpened(change);
	};

	useSharedDraft({
		path: `/api/drafts/${siteId}/designSystem`,
		onRemote() {
			setDesignVersion((count) => count + 1);
			void readOpened().catch((failure) => setProblems(treeProblemsOf(failure, t(errorMessage(failure)))));
		},
	});
	const documentId = opened.component?.id ?? opened.template?.id;
	const shared = useSharedDraft({
		path: documentId ? `/api/drafts/${siteId}/${opened.component ? "component" : "template"}/${documentId}` : null,
		onRemote(value) {
			const component = target.kind === "component" ? (value as { tree: Json; props: Json }) : null;
			const next: BuilderDoc = {
				...docRef.current,
				tree: (component ? component.tree : value) as unknown as ElementTree,
				props: component ? (component.props as unknown as FieldInput[]) : null,
			};
			if (JSON.stringify(next) === JSON.stringify(docRef.current)) return;
			finishGrab();
			docRef.current = next;
			setDoc(next);
			if (markupVersion.current === appliedMarkupVersion.current) void refreshMarkup(next);
			if (!Object.keys(next.styles).length) setSaved(JSON.stringify(next));
		},
		onRefused(refusal) {
			announce(t(errorMessage(refusal)), "interrupt");
			setProblems(treeProblemsOf(refusal, t(errorMessage(refusal))));
		},
		onSettled: async () => {
			try {
				await readOpened();
			} catch (failure) {
				setProblems(treeProblemsOf(failure, t(errorMessage(failure))));
			}
		},
	});
	const historyKey = `draft:${siteId}:${opened.component ? "component" : "template"}:${documentId ?? `new-${JSON.stringify(target)}`}`;
	const historyLocation = useCallback(
		(selected: Selection | null = selection, panel: HistoryLocation["panel"] = "tree"): HistoryLocation => ({
			siteId,
			draft: historyKey,
			inspectorTab: inspectorHistoryTab(),
			title,
			selection: selected ? selectionKey(docRef.current.tree, selected) : null,
			panel,
		}),
		[siteId, historyKey, title, selection],
	);
	useEffect(() => history.subscribe(() => setHistoryVersion((count) => count + 1)), [history]);
	history.configure(historyLanguage(t));
	useEffect(
		() =>
			history.register(historyKey, {
				reverse: async (from, to) => {
					if (!documentId) {
						const before = docRef.current.tree as unknown as Json;
						const after = reverseChange(from, to, before);
						const next = { ...docRef.current, tree: after as unknown as ElementTree };
						docRef.current = next;
						setDoc(next);
						return { ok: true, before, after };
					}
					return shared.reverse(from, to);
				},
			}),
		[history, historyKey, shared.reverse, documentId],
	);
	useEffect(
		() =>
			history.listen({
				finish: finishGrab,
				announce: (message, refused) => announce(message, refused ? "interrupt" : "polite"),
				reveal: (location) => {
					if (location.draft !== historyKey && !(location.panel === "js" && location.title === title)) return false;
					if (location.selection) setSelection(selectionOf(docRef.current.tree, location.selection));
					if (fit.layout === "drawers") setDrawer(location.panel === "inspector" ? "inspector" : "layers");
					setCollapsed(new Set());
					requestAnimationFrame(() => {
						revealInspectorHistory(location.inspectorTab);
						document.querySelector('[role="treeitem"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
						if (location.selection)
							for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[title^="Canvas"]'))
								frame.contentDocument
									?.querySelector(`[data-wc-code="b#${CSS.escape(location.selection)}"]`)
									?.scrollIntoView({ block: "nearest" });
						if (["html", "css", "js"].includes(location.panel))
							document
								.querySelector(`section[aria-label="${location.panel.toUpperCase()}"]`)
								?.scrollIntoView({ block: "nearest" });
					});
					return true;
				},
			}),
		[history, historyKey, announce, title, fit.layout, finishGrab],
	);
	useEffect(
		() =>
			history.register(`input:${historyKey}`, {
				reverse: async (from, to) => {
					const before = markupRef.current;
					let after: string;
					try {
						after = reverseChange(from, to, before) as string;
					} catch {
						return { ok: false, code: "HISTORY_OBSOLETE" };
					}
					markupPending.current?.cancel();
					markupPending.current = null;
					markupVersion.current++;
					appliedMarkupVersion.current = markupVersion.current;
					markupRef.current = after;
					setMarkup(after);
					setMarkupBase(after);
					setMarkupProblems([]);
					return { ok: true, before, after };
				},
			}),
		[history, historyKey],
	);
	useEffect(
		() =>
			history.register(`styles:${historyKey}`, {
				reverse: async (from, to) => {
					const before = docRef.current.styles;
					const after = reverseChange(from, to, before) as Record<string, string>;
					const next = { ...docRef.current, styles: after };
					docRef.current = next;
					setDoc(next);
					return { ok: true, before, after };
				},
			}),
		[history, historyKey],
	);
	const refreshMarkup = useCallback(
		async (next: BuilderDoc) => {
			const version = markupVersion.current;
			try {
				const printed = await (await getApi()).builder.markup({
					siteId,
					target,
					tree: next.tree,
					styles: next.styles,
					...(next.props ? { props: next.props } : {}),
				});
				if (docRef.current !== next || markupVersion.current !== version) return;
				markupPending.current?.cancel();
				markupPending.current = shared.prepare();
				markupRef.current = printed.markup;
				setMarkup(printed.markup);
				setMarkupBase(printed.markup);
			} catch (failure) {
				if (markupVersion.current === version) setMarkupProblems(markupProblemsOf(failure, t(errorMessage(failure))));
			}
		},
		[siteId, target, t, shared.prepare],
	);
	useEffect(() => {
		if (markupVersion.current === appliedMarkupVersion.current) void refreshMarkup(doc);
	}, [doc, refreshMarkup]);
	useEffect(() => {
		let current = true;
		void getApi()
			.then((api) => api.builder.read({ siteId, target, markup }))
			.then((read) => {
				if (current && markupRef.current === markup) setLocations({ text: markup, ranges: read.locations });
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [siteId, target, markup]);

	const dirty =
		(documentId ? shared.status === "saving" || Object.keys(doc.styles).length > 0 : JSON.stringify(doc) !== saved) ||
		markup !== markupBase;

	const writeShared = useCallback(
		(next: BuilderDoc) => {
			if (!documentId) return true;
			return shared.change((current) =>
				target.kind === "component"
					? {
							...(current as Record<string, Json>),
							tree: next.tree as unknown as Json,
							props: next.props as unknown as Json,
						}
					: (next.tree as unknown as Json),
			);
		},
		[documentId, shared.change, target.kind],
	);
	const acceptMarkup = useCallback(
		(
			read: { tree: ElementTree; styles: Record<string, string>; props?: FieldInput[] | null },
			text: string,
		): BuilderDoc | null => {
			if (markupRef.current !== text) return null;
			let next: BuilderDoc = { tree: read.tree, styles: read.styles, props: read.props ?? docRef.current.props };
			if (documentId) {
				const pending = markupPending.current ?? shared.prepare();
				if (!pending) return null;
				const value =
					target.kind === "component"
						? {
								...(pending.before as Record<string, Json>),
								tree: next.tree as unknown as Json,
								props: next.props as unknown as Json,
							}
						: (next.tree as unknown as Json);
				const before = shared.draft();
				if (!pending.apply(value, { keep: true })) {
					markupPending.current = null;
					return null;
				}
				markupPending.current = pending;
				const merged = shared.draft();
				history.attach(markupStep.current, { resource: historyKey, before, after: merged });
				next = {
					...next,
					tree: (target.kind === "component" ? (merged as { tree: Json }).tree : merged) as unknown as ElementTree,
					props: target.kind === "component" ? (merged as unknown as { props: FieldInput[] }).props : null,
				};
			}
			if (!documentId)
				history.attach(markupStep.current, {
					resource: historyKey,
					before: docRef.current.tree as unknown as Json,
					after: next.tree as unknown as Json,
				});
			if (!sameValue(docRef.current.styles, next.styles)) {
				history.attach(markupStep.current, {
					resource: `styles:${historyKey}`,
					before: docRef.current.styles,
					after: next.styles,
				});
				styleStep.current = markupStep.current;
			}
			history.settleInput(markupStep.current);
			docRef.current = next;
			setDoc(next);
			appliedMarkupVersion.current = markupVersion.current;
			setMarkupBase(text);
			void refreshMarkup(next);
			return next;
		},
		[documentId, shared.prepare, shared.draft, target.kind, refreshMarkup, history, historyKey],
	);
	useEffect(() => () => markupPending.current?.cancel(), []);

	// ---------------------------------------------------------------------------------------------
	// Changing the Draft

	/** Applies a change, kept for undo, once the tree still keeps every rule; answers why not. */
	const apply = useCallback(
		(
			next: BuilderDoc,
			select: Selection | null,
			message: string,
			finish = false,
			compoundStep?: number,
			panel: HistoryLocation["panel"] = "tree",
		): string | undefined => {
			const problem = treeProblem(next.tree, allows);
			if (problem) {
				announce(problem.message, "interrupt");
				return problem.message;
			}
			const before = documentId ? shared.draft() : (docRef.current.tree as unknown as Json);
			if (!writeShared(next)) {
				announce(t(`coEditing.status.${shared.status}`), "interrupt");
				return t(`coEditing.status.${shared.status}`);
			}
			const change = {
				step: compoundStep,
				resource: historyKey,
				before,
				after: documentId ? shared.draft() : (next.tree as unknown as Json),
				label: message.replace(/\.$/, ""),
				location: {
					...historyLocation(select, panel),
					selection:
						selection &&
						selectionKey(docRef.current.tree, selection) &&
						!selectionOf(next.tree, selectionKey(docRef.current.tree, selection) ?? "")
							? selectionKey(docRef.current.tree, selection)
							: select
								? selectionKey(next.tree, select)
								: selection
									? selectionKey(docRef.current.tree, selection)
									: null,
				},
			};
			let step: number | undefined;
			if (grab && !finish) {
				// Movement remains live to peers. Only its completed gesture enters history.
				grab.before ??= before;
				const initial = grab.before;
				grab.complete = () => {
					history.record({ ...change, before: initial });
				};
			} else {
				step = history.record({ ...change, before: grab?.before ?? before });
				if (grab) grab.complete = undefined;
			}
			if (!sameValue(docRef.current.styles, next.styles)) {
				const change = { resource: `styles:${historyKey}`, before: docRef.current.styles, after: next.styles };
				if (step) {
					history.attach(step, change);
					styleStep.current = step;
				} else
					styleStep.current = history.record({
						...change,
						label: message.replace(/\.$/, ""),
						location: historyLocation(select, panel),
					});
			}
			setDoc(next);
			docRef.current = next;
			setSelection(select);
			announce(message);
			return undefined;
		},
		[
			allows,
			announce,
			writeShared,
			shared.status,
			shared.draft,
			t,
			grab,
			history,
			historyKey,
			historyLocation,
			documentId,
			selection,
		],
	);

	const nameAt = (tree: ElementTree, path: NodePath) => {
		const node = nodeAt(tree, path);
		return node ? layerName(t, node, catalogue).name : "";
	};

	const whereIs = (tree: ElementTree, path: NodePath) => layerLocation(t, tree, path, catalogue);

	const applyMove = (result: Changed | Refused, name: string) => {
		if ("refused" in result) {
			announce(t(`builder.moves.refused.${result.refused as "first"}`, { name }), "interrupt");
			return;
		}
		apply(
			{ ...doc, tree: result.tree },
			{ kind: "node", path: result.path },
			t("builder.moves.moved", { name, where: whereIs(result.tree, result.path) }),
		);
	};

	const placeBy = (path: NodePath, position: DropPosition | InsertWhere): Place =>
		sharedPlaceBy(doc.tree, path, position);

	const act = (action: LayerAction) => {
		const result = runLayerAction(action, { doc, selection, clipboard: clipboard.current, catalogue }, t);
		if (!result) return;
		if (result.clipboard) clipboard.current = result.clipboard;
		if (result.change) {
			if (!apply(result.change.doc, result.change.selection, result.message)) setFocusLayers((count) => count + 1);
		} else announce(result.message, result.refused ? "interrupt" : "polite");
	};

	const grabChange = (change: "pick" | "drop" | "cancel") => {
		if (selection?.kind !== "node") return;
		const name = nameAt(doc.tree, selection.path);
		if (change === "pick") {
			history.boundary();
			setGrab({ doc, selection });
			announce(t("builder.moves.picked", { name }));
		} else if (change === "drop") {
			apply(doc, selection, t("builder.moves.dropped", { name, where: whereIs(doc.tree, selection.path) }), true);
			history.boundary();
			setGrab(null);
			announce(t("builder.moves.dropped", { name, where: whereIs(doc.tree, selection.path) }));
		} else if (grab) {
			if (!writeShared(grab.doc)) return;
			grab.complete = undefined;
			docRef.current = grab.doc;
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

	const undo = () => history.undo();
	const redo = () => history.redo();

	const insert = (nodes: TreeNode[], way: InsertWhere = insertWhere): string | undefined => {
		const place = insertionPlace(doc.tree, selection, way);
		const made = insertAt(doc.tree, place, nodes);
		const name = nameAt(made.tree, made.path);
		const refusal = apply(
			{ ...doc, tree: made.tree },
			{ kind: "node", path: made.path },
			t("builder.moves.inserted", { name, where: whereIs(made.tree, made.path) }),
		);
		if (!refusal) setFocusLayers((count) => count + 1);
		return refusal;
	};

	const replace = (
		path: NodePath,
		node: TreeNode,
		message: string,
		step?: number,
		panel: HistoryLocation["panel"] = "tree",
	) => apply({ ...doc, tree: replaceAt(doc.tree, path, node) }, { kind: "node", path }, message, false, step, panel);

	const generatedIds = useMemo(
		() => new Set(catalogue.classes.filter((each) => each.generated).map((each) => each.id)),
		[catalogue],
	);

	const madeEditable = (made: MadeEditable) => {
		const current = docRef.current;
		const path = fixedTextAt && resolveFixedText(current.tree, fixedTextAt);
		if (!path) return t("builder.fixedText.changed");
		const next: BuilderDoc = {
			...current,
			tree: replaceAt(current.tree, path, { type: "value", path: made.path }),
			props: made.props ?? current.props,
		};
		const refused = apply(next, { kind: "node", path }, t("builder.fixedText.made", { binding: `{{ ${made.path} }}` }));
		if (refused) return refused;
		if (!catalogue.values.some((value) => value.path === made.path)) {
			const group = made.path.startsWith("props.") ? "props" : made.path.startsWith("site.") ? "globals" : "entry";
			patchOpened((before) => ({
				...before,
				catalogue: {
					...before.catalogue,
					values: [...before.catalogue.values, { path: made.path, label: made.label, type: "text", group }],
				},
			}));
		}
		setFixedTextAt(null);
	};

	// ---------------------------------------------------------------------------------------------
	// The canvas

	// biome-ignore lint/correctness/useExhaustiveDependencies: a change to the Design system's Draft (`designVersion`) shows too.
	useEffect(() => {
		let current = true;
		const handle = setTimeout(async () => {
			try {
				const api = await getApi();
				const shown = await api.builder.preview({
					entryId: entryId || undefined,
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
	}, [doc, entryId, siteId, target, designVersion, t, propsChange]);

	// In the Template markup view the canvas follows the markup, read as switching back would read it.
	useEffect(() => {
		if (markup === markupBase) return;
		let current = true;
		const handle = setTimeout(async () => {
			try {
				const api = await getApi();
				const read = await api.builder.read({ siteId, target, markup, ...propsChange(doc) });
				if (!current) return;
				let next = docRef.current;
				if (markup !== markupBase) {
					const accepted = acceptMarkup(read, markup);
					if (!accepted) return;
					next = accepted;
				}
				const props = next.props;
				const shown = await api.builder.preview({
					entryId: entryId || undefined,
					siteId,
					target,
					tree: next.tree,
					styles: next.styles,
					...(props ? { props } : {}),
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
	}, [markup, markupBase, entryId, siteId, target, doc, t, propsChange, acceptMarkup]);

	const placeholderWords = useCallback(
		(kind: string, name: string | null) => {
			const known = ["outlet", "form", "filter", "search", "themeToggle", "languageSwitcher", "consentSettings"];
			const which = (known.includes(kind) ? kind : "outlet") as "outlet";
			return t(`builder.canvas.placeholders.${which}`, { name: name ?? "" });
		},
		[t],
	);

	const selectedNode = selection?.kind === "node" ? nodeAt(doc.tree, selection.path) : undefined;
	/** The CSS panel's way to the Design system's Draft on the Builder canvas: the Management API. */
	const cssPort = useMemo<CssPanelPort>(
		() => ({
			read: async (classes) => (await getApi()).builder.css({ siteId, classes: [...classes] }),
			save: async (cssTarget, text, version) =>
				(await getApi()).builder.saveCss({ siteId, target: cssTarget, text, version }),
			createClass: async (name, step) => {
				const api = await getApi();
				const before = await api.builder.historyDesign({ siteId });
				const made = await api.designSystem.createClass({ siteId, name });
				const fresh = await api.builder.historyDesign({ siteId });
				const created = fresh.classes.find((each) => each.id === made.class.id);
				if (created)
					history.record({
						step,
						resource: `draft:${siteId}:designSystem`,
						before: before as unknown as Json,
						after: { ...before, classes: [...before.classes, created] } as unknown as Json,
						label: t("builder.css.created", { name }),
						location: historyLocation(selection, "css"),
					});
				return { id: made.class.id, name: made.class.name };
			},
			renameClass: async (classId, name) => {
				const api = await getApi();
				const before = await api.builder.historyDesign({ siteId });
				await api.designSystem.updateClass({ siteId, classId, name });
				history.record({
					resource: `draft:${siteId}:designSystem`,
					before: before as unknown as Json,
					after: {
						...before,
						classes: before.classes.map((each) => (each.id === classId ? { ...each, name } : each)),
					} as unknown as Json,
					label: t("builder.css.renamed", { name }),
					location: historyLocation(selection, "css"),
				});
			},
		}),
		[siteId, history, historyLocation, selection, t],
	);
	const canvasSelected: CanvasTarget | null =
		selectedNode?.type === "element"
			? { kind: "element", id: selectedNode.id }
			: selectedNode?.type === "component"
				? { kind: "placement", id: selectedNode.id }
				: selection && selectionKey(doc.tree, selection)
					? { kind: "structural", id: selectionKey(doc.tree, selection) ?? "" }
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

	/** Saves the Draft; answers the builder reopened on what was saved, or null when it wasn't. */
	const saveActive = useRef(false);
	const save = async (over?: { version: string | null }, autosave = false): Promise<Opened | null> => {
		if (saveActive.current) return null;
		saveActive.current = true;
		setBusy("save");
		const revision = markupVersion.current;
		const textAtStart = markupRef.current;
		let historyStep = styleStep.current ?? markupStep.current;
		let started = docRef.current;
		try {
			if (cssDeparture.current && !(await cssDeparture.current())) return null;
			if (jsDeparture.current && !(await jsDeparture.current())) return null;
			const api = await getApi();
			if (markupVersion.current !== revision) return null;
			if (textAtStart !== markupBase) {
				const read = await api.builder.read({ siteId, target, markup: textAtStart, ...propsChange(started) });
				if (markupVersion.current !== revision) return null;
				const next = acceptMarkup(read, textAtStart);
				if (!next) return null;
				started = next;
				historyStep = styleStep.current ?? markupStep.current;
			}
			if (documentId && !(await shared.flush())) return null;
			const latest = documentId ? await readOpened() : opened;
			const pendingStyles = history.pendingChanges(`styles:${historyKey}`, historyStep);
			if (documentId && Object.keys(started.styles).length === 0 && !pendingStyles.length) {
				setSaved(JSON.stringify(docOf(latest)));
				announce(t("builder.saved", { name: title }), autosave ? "silent" : "polite");
				return markupVersion.current === revision && docRef.current === started ? latest : null;
			}
			// The snapshot and version must describe the same Draft; peers may edit while flushing.
			const snapshot = documentId ? { ...started, tree: latest.tree, props: latest.props } : started;
			let version = over ? over.version : latest.version;
			let previous = (documentId
				? (latest.component?.draft ?? latest.template?.draft ?? latest.tree)
				: snapshot.tree) as unknown as Json;
			let stored: Awaited<ReturnType<typeof saveDraft>> | undefined;
			// Keep every finished inline-style edit when pending declarations become Classes.
			// Each acknowledged save advances the version; a peer write still refuses the next one.
			const stages = pendingStyles.length
				? pendingStyles.map((change) => ({ id: change.id, styles: change.after as Record<string, string> }))
				: [{ id: historyStep, styles: snapshot.styles }];
			for (const stage of stages) {
				const text = (
					await api.builder.markup({
						siteId,
						target,
						tree: snapshot.tree,
						styles: stage.styles,
						...propsChange(snapshot),
					})
				).markup;
				const designBefore = await api.builder.historyDesign({ siteId });
				stored = await saveDraft(api, siteId, target, {
					markup: text,
					props: propsChange(snapshot).props ?? null,
					basedOn: version,
				});
				const designAfter = await api.builder.historyDesign({ siteId });
				const used = JSON.stringify(stored.history.after);
				const created = designAfter.classes.filter(
					(each) => !designBefore.classes.some((old) => old.id === each.id) && used.includes(`"${each.id}"`),
				);
				if (created.length)
					history.attach(stage.id, {
						resource: `draft:${siteId}:designSystem`,
						before: designBefore as unknown as Json,
						after: { ...designBefore, classes: [...designBefore.classes, ...created] } as unknown as Json,
					});
				history.attach(stage.id, {
					resource: historyKey,
					before: previous,
					after: stored.history.after as unknown as Json,
				});
				history.forgetResource(`styles:${historyKey}`, stage.id);
				previous = stored.history.after as unknown as Json;
				version = stored.version;
			}
			if (!stored) return null;
			history.renameResource(historyKey, stored.history.resource);
			if (styleStep.current === historyStep) styleStep.current = undefined;
			const fresh = await readOpened();
			setConflict(null);
			if (docRef.current === started) {
				const next = docOf(fresh);
				docRef.current = next;
				setDoc(next);
				setSaved(JSON.stringify(next));
				setSelection((before) => (before?.kind === "node" && !nodeAt(next.tree, before.path) ? null : before));
			} else {
				if (JSON.stringify(docRef.current.styles) === JSON.stringify(started.styles)) {
					const next = { ...docRef.current, styles: {} };
					docRef.current = next;
					setDoc(next);
				}
				setSaved(JSON.stringify(docOf(fresh)));
			}
			if (markupVersion.current === revision) {
				markupRef.current = stored.markup;
				setMarkup(stored.markup);
				setMarkupBase(stored.markup);
			}
			setProblems([]);
			setMarkupProblems([]);
			announce(t("builder.saved", { name: title }), autosave ? "silent" : "polite");
			return markupVersion.current === revision ? fresh : null;
		} catch (failure) {
			announce(t("builder.notSaved"), "interrupt");
			if (errorCode(failure) === "CHANGED_MEANWHILE") {
				const version = (failure as { data?: { version?: string | null } }).data?.version ?? null;
				setConflict({ version });
			} else {
				setMarkupProblems(markupProblemsOf(failure, t(errorMessage(failure))));
			}
			return null;
		} finally {
			saveActive.current = false;
			setBusy(null);
		}
	};
	const saveNow = useRef(save);
	saveNow.current = save;
	useEffect(() => {
		if (!Object.keys(doc.styles).length && (documentId || !dirty)) return;
		const timer = setTimeout(() => void saveNow.current(undefined, true), 400);
		return () => clearTimeout(timer);
	}, [doc.styles, documentId, dirty]);

	const depart = async () => {
		const revision = inputRevision.current;
		if (oneOffDeparture.current && !(await oneOffDeparture.current())) return false;
		return !!(await saveNow.current()) && inputRevision.current === revision;
	};

	const publish = async () => {
		if (oneOffDeparture.current && !(await oneOffDeparture.current())) return;
		const current = await save();
		if (!current) return;
		if (target.kind !== "component" && !current.template) {
			announce(t("builder.saveFirst"), "interrupt");
			return;
		}
		setBusy("publish");
		try {
			if (current.popup) {
				await navigate({ to: "/sites/$siteId/popups", params: { siteId }, search: { popup: current.popup.id } });
				return;
			}
			const api = await getApi();
			await publishDraft(api, siteId, target, current.template?.id ?? null);
			await readOpened();
			announce(t("builder.published", { name: title }));
		} catch (failure) {
			const listed = (failure as { data?: { problems?: { message: string }[] } }).data?.problems;
			const message = listed?.length ? listed.map((each) => each.message).join(" ") : t(errorMessage(failure));
			announce(message, "interrupt");
		} finally {
			setBusy(null);
		}
	};

	const reload = async () => {
		const api = await getApi();
		const fresh = await readOpened();
		const next = docOf(fresh);
		setDoc(next);
		setSaved(JSON.stringify(next));
		setSelection(null);
		setConflict(null);
		{
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

	// The shortcut registry supplies the bindings; Undo/Redo use the tab history even in code.
	/**
	 * Opens a drawer (or none) in the drawer layout. With `focus`, focus moves into it, and back to
	 * where it was before the first drawer opened when none is left open.
	 */
	const showDrawer = (next: EditorDrawer | null, focus = false) => {
		if (focus && next && !drawer) drawerReturn.current = document.activeElement;
		setDrawer(next);
		if (!focus) return;
		afterRender(() => {
			if (next) {
				focusInto(next === "layers" ? layersSection.current : inspectorSection.current);
				return;
			}
			const back = drawerReturn.current;
			drawerReturn.current = null;
			if (back instanceof HTMLElement && back.isConnected) back.focus();
			else document.getElementById("main")?.focus();
		});
	};
	const regionLayout = useRef({ fit, showDrawer });
	regionLayout.current = { fit, showDrawer };
	const [regionFocus, setRegionFocus] = useState<(() => void) | null>(null);
	useLayoutEffect(() => {
		regionFocus?.();
	}, [regionFocus]);
	useLayoutEffect(
		() =>
			editorAccessibility(document).registerRegionLayout({
				hiddenRegions: () =>
					regionLayout.current.fit.layout === "drawers" && !regionLayout.current.fit.covered
						? ["tree", "inspector"]
						: [],
				reveal(name, focus) {
					const { fit, showDrawer } = regionLayout.current;
					if (fit.covered) return;
					if (fit.layout === "drawers") {
						showDrawer(name === "tree" ? "layers" : name === "inspector" ? "inspector" : null);
						// A layout effect belongs to this commit; an earlier passive effect cannot consume it.
						setRegionFocus(() => focus);
					} else focus();
				},
			}),
		[],
	);

	// Below the smallest width, a notice covers the builder: nothing under it closes or can be reached,
	// and focus goes back where it was once the window is wide enough again.
	const coverReturn = useRef<Element | null>(null);
	useEffect(() => {
		if (!fit.covered) {
			const back = coverReturn.current;
			coverReturn.current = null;
			if (back instanceof HTMLElement && back.isConnected) back.focus();
			return;
		}
		coverReturn.current = document.activeElement;
		const shown = notice.current;
		const covered: Element[] = [];
		for (const child of document.body.children) {
			if (!shown || child.contains(shown) || child.hasAttribute("inert")) continue;
			child.setAttribute("inert", "");
			covered.push(child);
		}
		shown?.focus();
		return () => {
			for (const each of covered) each.removeAttribute("inert");
		};
	}, [fit.covered]);

	const keys = useRef({ save });
	keys.current = { save };
	const shortcut = useRef<(event: KeyboardEvent) => void>(() => {});
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// The shortcut registry decides which chords these are (`shortcuts.ts`).
			if (matches(event, "editor.save")) {
				event.preventDefault();
				void keys.current.save();
				return;
			}
		};
		shortcut.current = onKey;
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const openInsert = () => {
		const node = selection?.kind === "node" ? nodeAt(doc.tree, selection.path) : undefined;
		setInsertWhere(node && canHoldChildren(node) ? "inside" : "after");
		setMenu({ tab: "insert" });
	};

	// ---------------------------------------------------------------------------------------------
	// The Command menu (#131): the same commands as Code mode's, for this canvas

	const loadMenu = useCallback(async () => {
		try {
			setMenuData(await (await getApi()).builder.commandMenu({ siteId }));
		} catch (failure) {
			announce(t(errorMessage(failure)));
		}
	}, [siteId, announce, t]);
	// The menu's data loads when Actions or Go to first opens (Insert needs only `structure.edit`, which
	// opening the editor already proved); Go to reads its lists again each time it opens.
	const menuTab = menu?.tab;
	const menuLoaded = useRef(false);
	useEffect(() => {
		if (!menuTab || menuTab === "insert" || (menuLoaded.current && menuTab !== "goTo")) return;
		menuLoaded.current = true;
		void loadMenu();
	}, [menuTab, loadMenu]);
	/** `can()`'s answer for the Site, from the server; opening the Builder already needed `structure.edit`. */
	const can = useCallback(
		(permission: Permission) =>
			menuData ? (menuData.permissions as readonly Permission[]).includes(permission) : permission === "structure.edit",
		[menuData],
	);
	const leaveFor = (url: () => Promise<string> | string) => {
		const revision = inputRevision.current;
		void depart().then(async (saved) => {
			if (!saved) return;
			try {
				const destination = await history.departure(await url());
				if (revision === inputRevision.current) window.location.assign(destination);
			} catch (failure) {
				announce(t(errorMessage(failure)));
			}
		});
	};
	/** Every layer on the way to it opens. */
	const reveal = (path: NodePath) =>
		setCollapsed((before) => {
			const next = new Set(before);
			for (let length = 1; length < path.length; length += 2) {
				const owner = path.slice(0, length);
				const ownerNode = nodeAt(doc.tree, owner);
				if (ownerNode) next.delete(rowKey(ownerNode, owner));
			}
			return next;
		});
	const selectPath = (path: NodePath) => {
		setSelection({ kind: "node", path });
		reveal(path);
		announce(t("builder.selected", { name: nameAt(doc.tree, path) }));
	};
	const selectParent = () => {
		if (selection?.kind !== "node") return;
		if (selection.path.length > 1) selectPath(selection.path.slice(0, -2));
		else announce(t("builder.commandMenu.noParent", { name: nameAt(doc.tree, selection.path) }), "interrupt");
	};
	const wrapSelected = (wrapper: TreeNode): string | undefined => {
		if (selection?.kind !== "node") return t("builder.moves.refused.gone", { name: "" });
		const name = nameAt(doc.tree, selection.path);
		const wrapped = wrapAt(doc.tree, selection.path, wrapper);
		if ("refused" in wrapped) return t("builder.moves.refused.gone", { name });
		return apply(
			{ ...doc, tree: wrapped.tree },
			{ kind: "node", path: wrapped.path },
			t("builder.commandMenu.wrapped", { name, what: layerName(t, wrapper, catalogue).name }),
		);
	};
	const wrap = (kind: WrapKind) => {
		if (kind === "loop" || kind === "condition") {
			setMenu({ tab: "insert", step: { item: kind === "loop" ? "command-loop" : "command-if", mode: "wrap" } });
			return;
		}
		const made = elementBuilder(doc.tree)(kind, [], kind === "a" ? { href: "/" } : {});
		if (!wrapSelected(made)) setFocusLayers((count) => count + 1);
	};
	const unwrap = () => {
		if (selection?.kind !== "node") return;
		const name = nameAt(doc.tree, selection.path);
		const result = unwrapAt(doc.tree, selection.path);
		if ("refused" in result)
			announce(
				t(
					result.refused === "other-branches"
						? "builder.commandMenu.cannotUnwrapBranches"
						: "builder.commandMenu.cannotUnwrap",
					{ name },
				),
				"interrupt",
			);
		else
			apply(
				{ ...doc, tree: result.tree },
				{ kind: "node", path: result.path },
				t("builder.commandMenu.unwrapped", { name }),
			);
	};
	const go = {
		page: (path: string) =>
			leaveFor(async () => (await (await getApi()).editMode.open({ siteId, path, code: true })).url),
		builder: (next: BuilderTarget) => leaveFor(() => `/builder/${siteId}/${targetPath(next)}`),
		layer: (_ref: string, path: NodePath) => selectPath(path),
	};
	const commandSelected = selection?.kind === "node" ? nodeAt(doc.tree, selection.path) : undefined;
	const commandTarget: EditorCommandTarget = {
		canvas: "builder",
		selection: commandSelected
			? {
					kind:
						commandSelected.type === "element"
							? "element"
							: commandSelected.type === "component"
								? "placement"
								: "other",
					name: layerName(t, commandSelected, catalogue).name,
					hidden: commandSelected.type === "component" ? !!commandSelected.hidden : undefined,
					canUnwrap: canUnwrap(commandSelected),
				}
			: null,
		history: historyCommandTarget(history),
		save: () => void save(),
		publish: () => setConfirmPublish(true),
		switchCanvas: () => setViewRequest((count) => count + 1),
		openSiteCss: () => setSiteCssRequest((count) => count + 1),
		layer: (action) =>
			action === "parent" ? selectParent() : action === "rename" ? setRenameRequest((count) => count + 1) : act(action),
		wrap,
		unwrap,
		...(commandSelected?.type === "component"
			? {
					editComponent: () => go.builder({ kind: "component", componentId: commandSelected.component }),
					toggleHidden: () => {
						if (selection?.kind === "node")
							replace(
								selection.path,
								{ ...commandSelected, hidden: !commandSelected.hidden },
								t("builder.inspector.changed"),
							);
					},
				}
			: {}),
	};
	const editorKeys = useEditorKeys({
		enabled: conflict === null && fixedTextAt === null && !confirmPublish && !fit.covered,
		menu,
		setMenu,
		openShortcuts: () => setShortcutsOpen(true),
		history: commandTarget.history,
		element: commandSelected
			? { duplicate: () => act("duplicate"), delete: () => act("delete"), parent: selectParent }
			: null,
	});

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
	const full = fit.layout === "full";
	const goBack = (event: { preventDefault(): void }) => {
		event.preventDefault();
		void depart().then((saved) => {
			if (saved) void navigate({ to: back.to, params: { siteId } });
		});
	};

	return (
		<div
			className="bg-background flex h-svh flex-col"
			onInputCapture={() => inputRevision.current++}
			onChangeCapture={() => inputRevision.current++}
		>
			<header data-editor-region="topbar" className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<Link
					onClick={goBack}
					to={back.to}
					params={{ siteId }}
					className={buttonVariants({ variant: "ghost", size: "sm" })}
				>
					<ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
					{back.label}
				</Link>
				<div className="flex min-w-0 items-center gap-2">
					<h1 className="truncate text-base font-semibold">{title}</h1>
					<Badge variant="outline">{t(`builder.kinds.${target.kind}`)}</Badge>
					{status ? <StatusBadge status={status} /> : <Badge variant="outline">{t("builder.status.new")}</Badge>}
					{dirty ? <Badge variant="secondary">{t("builder.status.unsaved")}</Badge> : null}
				</div>
				<BuilderNavigation
					siteId={siteId}
					target={target}
					entryId={entryId}
					onEntry={setEntryId}
					revision={opened.version}
					returnPage={returnPage}
					selection={selection ? selectionKey(doc.tree, selection) : null}
					beforeLeave={depart}
					viewRequest={viewRequest}
				/>
				<div className="ms-auto flex flex-wrap items-center gap-1">
					{fit.layout === "drawers" ? (
						<>
							<Button
								type="button"
								size="sm"
								variant={drawer === "layers" ? "secondary" : "ghost"}
								aria-expanded={drawer === "layers"}
								aria-controls="builder-layers"
								aria-keyshortcuts="F6"
								onClick={() => showDrawer(drawer === "layers" ? null : "layers", drawer !== "layers")}
							>
								<PanelLeftIcon aria-hidden="true" className="rtl:rotate-180" />
								{t("builder.layers.heading")}
							</Button>
							<Button
								type="button"
								size="sm"
								variant={drawer === "inspector" ? "secondary" : "ghost"}
								aria-expanded={drawer === "inspector"}
								aria-controls="builder-inspector"
								aria-keyshortcuts="F6"
								onClick={() => showDrawer(drawer === "inspector" ? null : "inspector", drawer !== "inspector")}
							>
								<PanelRightIcon aria-hidden="true" className="rtl:rotate-180" />
								{t("builder.inspector.heading")}
							</Button>
						</>
					) : null}
					<CommandMenuButton onOpen={() => setMenu({ tab: "actions" })} />
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
						title={withKeys(
							history.state().undo ? t("editorHistory.undo", { label: history.state().undo ?? "" }) : t("builder.undo"),
							"editor.undo",
						)}
						aria-keyshortcuts={ariaKeys("editor.undo")}
						disabled={!history.state().undo || history.state().busy}
						onClick={undo}
					>
						<Undo2Icon aria-hidden="true" />
					</Button>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label={t("builder.redo")}
						title={withKeys(
							history.state().redo ? t("editorHistory.redo", { label: history.state().redo ?? "" }) : t("builder.redo"),
							"editor.redo",
						)}
						aria-keyshortcuts={ariaKeys("editor.redo")}
						disabled={!history.state().redo || history.state().busy}
						onClick={redo}
					>
						<Redo2Icon aria-hidden="true" />
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						aria-keyshortcuts={ariaKeys("editor.save")}
						title={withKeys(t("builder.save"), "editor.save")}
						disabled={busy !== null || (!dirty && shared.status === "saved") || (!!documentId && !shared.writable)}
						onClick={() => void save()}
					>
						{busy === "save" ? t("builder.saving") : t("builder.save")}
					</Button>
					<Button type="button" size="sm" disabled={busy !== null} onClick={() => void publish()}>
						<UploadIcon aria-hidden="true" />
						{opened.popup
							? t("popups.reviewPublish")
							: busy === "publish"
								? t("builder.publishing")
								: t("builder.publish")}
					</Button>
				</div>
				<p aria-live="off" className="text-muted-foreground basis-full text-sm empty:hidden">
					{announcement}
				</p>
			</header>
			<main
				id="main"
				tabIndex={-1}
				className={`grid min-h-0 flex-1 grid-rows-[minmax(16rem,1fr)_minmax(15rem,35vh)] outline-none ${full ? "grid-cols-[16rem_minmax(0,1fr)_18rem]" : "grid-cols-[minmax(0,1fr)]"}`}
			>
				{
					<section
						data-editor-region="tree"
						id="builder-layers"
						ref={layersSection}
						tabIndex={-1}
						aria-labelledby="layers-heading"
						className={`min-h-0 flex-col border-e outline-none ${full ? "col-start-1 row-span-2 row-start-1 flex" : `bg-background z-10 col-start-1 row-start-1 w-64 justify-self-start shadow-lg ${drawer === "layers" ? "flex" : "hidden"}`}`}
					>
						<fieldset disabled={!!documentId && !shared.writable} className="contents">
							<InsertToolbar
								where={insertWhere}
								canInside={!!selectedNode && canHoldChildren(selectedNode)}
								onWhere={setInsertWhere}
								onPick={(item) => {
									if (item === null) return setMenu({ tab: "insert" });
									if (item === "components") return setMenu({ tab: "insert", only: "components" });
									const found = insertItems(t, doc.tree, catalogue).find((each) => each.id === item);
									if (!found) return;
									const nodes = insertNow(found, doc.tree, catalogue);
									if (!nodes) setMenu({ tab: "insert", step: { item, mode: "insert" } });
									else if (!insert(nodes)) setFocusLayers((count) => count + 1);
								}}
							/>
							<LayersPanel
								counts={preview ? loopCounts(new DOMParser().parseFromString(preview.html, "text/html")) : undefined}
								onHidden={(path, hidden) => {
									const node = nodeAt(doc.tree, path);
									if (node?.type === "component") replace(path, { ...node, hidden }, t("builder.inspector.changed"));
								}}
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
								renameRequest={renameRequest}
								onInsert={openInsert}
							/>
						</fieldset>
					</section>
				}
				<section
					aria-label={t("builder.canvas.label")}
					className={`bg-muted row-start-1 flex min-h-0 flex-col ${full ? "col-start-2" : "col-start-1"}`}
				>
					{problems.length > 0 ? (
						<div className="border-destructive/40 bg-destructive/5 border-b px-3 py-2 text-sm">
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
					{preview ? (
						<details
							className="max-h-56 overflow-y-auto border-b p-2 text-sm"
							onToggle={(event) => setShowChecks(event.currentTarget.open)}
						>
							<summary className="cursor-pointer font-semibold">
								{t("checks.heading")} ({preview.checks.length})
							</summary>
							{showChecks ? (
								<Checks
									checks={preview.checks.map((check) => ({
										...check,
										...(check.componentId
											? {
													href: `/builder/${siteId}/component/${check.componentId}?element=${encodeURIComponent((check.at.split("#").at(-1) ?? "").replace(/(?:\.\d+)+$/, ""))}`,
												}
											: {}),
									}))}
									onSelect={(at) => {
										const id = at
											.split("#")
											.at(-1)
											?.replace(/(?:\.\d+)+$/, "");
										const path = id ? pathOfId(doc.tree, id) : undefined;
										if (path) setSelection({ kind: "node", path });
									}}
								/>
							) : null}
						</details>
					) : null}
					<Canvas
						html={preview?.html ?? null}
						css={preview?.css ?? ""}
						language={opened.language.code}
						direction={opened.language.direction}
						theme={theme}
						width={width}
						title={t("builder.canvas.title", { name: title })}
						selected={canvasSelected}
						selectedName={selectedNode ? layerName(t, selectedNode, catalogue).name : null}
						fixedText={fixedIds}
						placeholderWords={placeholderWords}
						onSelect={(found) => {
							const next = selectionOf(doc.tree, found.id);
							if (!next) return;
							setSelection(next);
							const path = next.kind === "node" ? next.path : next.list.owner;
							if (!path) return;
							const node = nodeAt(doc.tree, path);
							if (node) announce(t("builder.selected", { name: layerName(t, node, catalogue).name }));
						}}
						onMove={canvasMove}
						onShortcut={(event) => {
							if (editorAccessibility(document).handleRegionKey(event)) return;
							shortcut.current(event);
							editorKeys(event);
						}}
					/>
				</section>
				{
					<section
						data-editor-region="inspector"
						id="builder-inspector"
						ref={inspectorSection}
						tabIndex={-1}
						aria-labelledby="inspector-heading"
						className={`min-h-0 flex-col border-s outline-none ${full ? "col-start-3 row-span-2 row-start-1 flex" : `bg-background z-10 col-start-1 row-start-1 w-72 justify-self-end shadow-lg ${drawer === "inspector" ? "flex" : "hidden"}`}`}
					>
						<Inspector
							departure={oneOffDeparture}
							cssInDock
							siteId={siteId}
							tree={doc.tree}
							selection={selection}
							catalogue={catalogue}
							oneOffOf={oneOffOf}
							fixedTextAction={fixedTextAction}
							onReplace={(path, node, message) => replace(path, node, message, undefined, "inspector")}
							onClasses={(path, classIds, message) => {
								const node = nodeAt(doc.tree, path);
								if (node?.type === "element")
									replace(path, { ...node, classes: classIds }, message, undefined, "inspector");
							}}
							onOneOff={async (_path, elementId, declarations) => {
								try {
									for (;;) {
										// The shared tree can receive a generated Class before its background catalogue read.
										const current = docRef.current;
										const run = openedRead.current + 1;
										const fresh = await readOpened();
										// A peer may move or restyle this element while the catalogue is in flight.
										if (current !== docRef.current || run !== openedRead.current) continue;
										const generated = new Set(
											fresh.catalogue.classes.filter((each) => each.generated).map((each) => each.id),
										);
										const path = pathOfId(current.tree, elementId);
										const node = path && nodeAt(current.tree, path);
										if (!path || node?.type !== "element") return false;
										const styles = { ...current.styles };
										if (declarations) styles[elementId] = declarations;
										else delete styles[elementId];
										return (
											apply(
												{
													...current,
													tree: replaceAt(current.tree, path, {
														...node,
														classes: node.classes.filter((id) => !generated.has(id)),
													}),
													styles,
												},
												{ kind: "node", path },
												declarations ? t("builder.style.oneOffApplied") : t("builder.style.oneOffRemoved"),
												false,
												undefined,
												"inspector",
											) === undefined
										);
									}
								} catch (failure) {
									announce(t(errorMessage(failure)));
									return false;
								}
							}}
							refreshCatalogue={async () => {
								await readOpened();
								setDesignVersion((count) => count + 1);
							}}
							onMakeEditable={(path, trigger) => {
								fixedTextTrigger.current = trigger;
								setFixedTextAt(rememberFixedText(docRef.current.tree, path));
							}}
						/>
					</section>
				}
				<div
					data-code-panel=""
					className={`row-start-2 grid min-h-0 overflow-auto border-t ${full ? "col-start-2" : "col-start-1"} ${target.kind === "component" ? "grid-cols-3" : "grid-cols-2"}`}
				>
					<section data-editor-region="html" aria-label="HTML" className="flex min-h-0 flex-col">
						<MarkupView
							value={markup}
							problems={markupProblems}
							selected={
								locations.text === markup
									? locations.ranges.find(
											(range) => range.key === (selection ? selectionKey(doc.tree, selection) : null),
										)
									: undefined
							}
							onCaret={(offset) => {
								if (locations.text !== markup) return;
								const found = locations.ranges
									.filter((range) => range.start <= offset && offset < range.end)
									.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
								if (found) setSelection(selectionOf(doc.tree, found.key));
							}}
							onChange={(text) => {
								markupStep.current = history.record({
									resource: `input:${historyKey}`,
									before: markupRef.current,
									after: text,
									label: t("editorHistory.html", { name: title }),
									location: historyLocation(selection, "html"),
									group: `html:${historyKey}`,
								});
								markupVersion.current++;
								markupRef.current = text;
								markupPending.current ??= shared.prepare();
								setMarkup(text);
							}}
						/>
					</section>
					<section
						data-editor-region="css"
						aria-label={t("builder.css.heading")}
						className="bg-background flex min-h-0 flex-col overflow-auto border-t p-3"
					>
						<CssPanel
							historyLocation={historyLocation(selection, "css")}
							port={cssPort}
							departure={cssDeparture}
							onEdit={() => inputRevision.current++}
							element={selectedNode?.type === "element" ? { id: selectedNode.id, classes: selectedNode.classes } : null}
							catalogue={catalogue}
							editable={!documentId || shared.writable}
							designVersion={designVersion}
							showSiteCss={siteCssRequest}
							onClasses={(classes, message, step) =>
								selection?.kind === "node" && selectedNode?.type === "element"
									? replace(selection.path, { ...selectedNode, classes }, message, step, "css")
									: t("coEditing.status.readOnly")
							}
							refreshCatalogue={async () => {
								// The same refresh as the Inspector's: the Builder's own ordered catalogue read.
								await readOpened();
								setDesignVersion((count) => count + 1);
							}}
						/>
					</section>
					{target.kind === "component" ? (
						<ComponentScriptPanel
							siteId={siteId}
							componentId={target.componentId}
							name={title}
							departure={jsDeparture}
						/>
					) : null}
				</div>
			</main>
			<CommandMenu
				canvas="builder"
				state={menu}
				onState={setMenu}
				can={can}
				actions={editorCommands(commandTarget, t)}
				goTo={
					menu?.tab === "goTo" && menuData
						? goToCommands(t, menuData, [{ ref: "builder", tree: doc.tree, catalogue }], go)
						: null
				}
				insert={{
					siteId,
					tree: doc.tree,
					catalogue,
					where: insertWhere === "inside" ? "inside" : "after",
					canInside: selectedNodeForInsert ? canHoldChildren(selectedNodeForInsert) : selection?.kind === "list",
					onWhere: setInsertWhere,
					selected: selectedNodeForInsert ? layerName(t, selectedNodeForInsert, catalogue).name : null,
					onInsert: (nodes, way) => insert(nodes, way),
					onWrap: wrapSelected,
				}}
				onRowFocus={() => setFocusLayers((count) => count + 1)}
			/>
			<ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} can={can} />
			<Dialog open={confirmPublish} onOpenChange={setConfirmPublish}>
				<DialogContent closeLabel={t("builder.commandMenu.close")}>
					<DialogHeader>
						<DialogTitle>{t("builder.commandMenu.publishConfirm.title", { name: title })}</DialogTitle>
						<DialogDescription>{t("builder.commandMenu.publishConfirm.body")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setConfirmPublish(false)}>
							{t("builder.commandMenu.publishConfirm.cancel")}
						</Button>
						<Button
							type="button"
							onClick={() => {
								setConfirmPublish(false);
								void publish();
							}}
						>
							{t("builder.commandMenu.publishConfirm.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{fixedTextAt ? (
				<FixedTextDialog
					open
					onOpenChange={(open) => {
						if (!open) setFixedTextAt(null);
					}}
					finalFocus={fixedTextTrigger}
					target={fixedTextAction}
					text={fixedTextAt.text.trim()}
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
			{fit.covered
				? createPortal(
						<div
							ref={notice}
							role="dialog"
							aria-modal="true"
							aria-labelledby="builder-too-narrow-title"
							aria-describedby="builder-too-narrow-text"
							tabIndex={-1}
							className="bg-background text-foreground fixed inset-0 z-[100] grid place-items-center p-6 outline-none"
						>
							<div className="grid max-w-md justify-items-center gap-3 text-center">
								<h2 id="builder-too-narrow-title" className="text-lg font-semibold">
									{t("builder.tooNarrow.title")}
								</h2>
								<p id="builder-too-narrow-text" className="text-muted-foreground text-sm">
									{t("builder.tooNarrow.text")}
								</p>
								<Link
									onClick={goBack}
									to={back.to}
									params={{ siteId }}
									className={buttonVariants({ variant: "outline", size: "sm" })}
								>
									<ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
									{back.label}
								</Link>
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
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
