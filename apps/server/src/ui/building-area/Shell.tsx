import { type ElementTree, readExpression, type TreeNode } from "@webcraft/renderer/builder";
import { PencilIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useEditorFit } from "../editor/editor-fit.ts";
import { editorHistory } from "../editor/editor-history.ts";
import { childLists, newElement, withNewIds } from "../editor/tree.ts";
import { BUILDING_STAND_IN_PREFIX } from "./agent/contract.ts";
import { type EditAnswer, editRequests, fill, type PageState, type ShellConfig } from "./api.ts";
import { BottomBar, sitePreview } from "./bottom-bar/BottomBar.tsx";
import { DocumentNav } from "./bottom-bar/DocumentNav.tsx";
import { draftStateOf } from "./bottom-bar/DraftState.tsx";
import { InsertRow, KIND_ICONS } from "./bottom-bar/InsertRow.tsx";
import type { PageLanguage } from "./bottom-bar/LanguageMenu.tsx";
import { Frame, type FrameHandle, type PageTheme } from "./canvas/Frame.tsx";
import { NoDocument } from "./canvas/NoDocument.tsx";
import { tagName } from "./canvas/overlay.ts";
import { chosenRefOf, readFormNames } from "./canvas/placed-form.ts";
import type { SavingStatus } from "./canvas/regions.ts";
import type { MenuHost } from "./command-menu/host.ts";
import { CommandMenuHost, useCommandMenu } from "./command-menu/loader.tsx";
import { DocumentSwitcher, titleText } from "./DocumentSwitcher.tsx";
import { DockArea, useDocks } from "./docks/Docks.tsx";
import { PanelButton } from "./docks/PanelFrame.tsx";
import { PanelsMenu } from "./docks/PanelsMenu.tsx";
import type { PanelContext } from "./docks/panels.ts";
import { componentInPlace, type InPlaceTarget, rootsOf } from "./editing/component-in-place.ts";
import { reverseElsewhere } from "./editing/drafts.ts";
import { pageEditing } from "./editing/editing.ts";
import { shellHistory } from "./editing/history.ts";
import { InsertLine } from "./editing/InsertLine.tsx";
import { anchorName, type DocumentKind, KIND_TAGS, inserter as makeInserter } from "./editing/insert.ts";
import { layerOps } from "./editing/layer-ops.ts";
import { pageLayoutEditor } from "./editing/page-layout.ts";
import { refOf, type StructureSnapshot, structure } from "./editing/selection.ts";
import { TextToolbar } from "./editing/TextToolbar.tsx";
import { type RegionCycle, regionCycle } from "./keyboard.ts";
import { managementApi } from "./management.ts";
import { NarrowNotice } from "./NarrowNotice.tsx";
import { useOpenDocument } from "./open-document.ts";
import { ComponentNameDialog, type ComponentNameRequest } from "./panels/ComponentNameDialog.tsx";
import { AddPropButton, ComponentPanel } from "./panels/ComponentPanel.tsx";
import { codePaneParts, useCodePanes } from "./panels/code-panes.tsx";
import { EmptyPage } from "./panels/EmptyPage.tsx";
import { EntryPanel, EntryPanelActions, useEntryPanelView } from "./panels/EntryFields.tsx";
import { FormPanel, FormPanelHeading } from "./panels/FormPanel.tsx";
import { Inspector } from "./panels/Inspector.tsx";
import { Layers } from "./panels/Layers.tsx";
import { conditionName, loopAround } from "./panels/LoopPanel.tsx";
import { MediaShellHost } from "./places/media/host.tsx";
import { pickMedia } from "./places/media/pick.ts";
import { PlaceLoader } from "./places/PlaceLoader.tsx";
import {
	PLACE_EVENT,
	PLACE_KEYS,
	type PlaceBar,
	type PlaceKey,
	placeEntry,
	placeKeyOf,
	reopenPlace,
} from "./places/registry.ts";
import { BreakpointLines } from "./places/styles/BreakpointLines.tsx";
import { Publish } from "./publish/Publish.tsx";
import { PUBLISH_OPEN_EVENT } from "./publish/sources.ts";
import { Rail } from "./rail/Rail.tsx";
import { useElementSelection, useFilterSelection } from "./select-filter.ts";

/**
 * The building area's shell (ADR 0037, SPEC 2 and 4): the rail on the left (48 wide; the logo tile
 * goes back to the admin), the canvas with the page in its frame, and the bottom bar (48 high). The
 * chrome is always dark; the page inside the frame follows the device, or Dark preview.
 */
/** Puts focus in the page shown in the frame, or in the place open over it (BA-20). */
function focusFrame(): void {
	const place = document.querySelector<HTMLElement>("[data-wc-place-frame]");
	if (place) {
		place.querySelector<HTMLElement>("[data-wc-place-back]")?.focus();
		return;
	}
	const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
	if (!frame) return;
	frame.focus();
	frame.contentWindow?.focus();
}

/** Whether a key press is meant for a text field rather than the shell's shortcuts. */
function typingIn(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable || target.matches("input, textarea, select, [role='textbox']"))
	);
}

/** What the bottom bar shows of the page in the frame. */
type ShownPage = { address: string; changes: number; inReview: boolean };

/**
 * What a Placement selected is called (its Component's name), for the canvas's chip and the Inspector's
 * title; null when the reference names no Placement (a Page's, `content/<id>`, or a Template's node).
 */
function placementName(snapshot: StructureSnapshot, ref: string | null): string | null {
	if (!ref) return null;
	if (!ref.includes("#")) return snapshot.layout?.find((each) => `content/${each.id}` === ref)?.name ?? null;
	const selection = snapshot.selection?.ref === ref ? snapshot.selection : null;
	const node = selection?.node;
	if (node?.type !== "component") return null;
	return (
		snapshot.sources.get(`${selection?.source}/${node.id}`)?.name ??
		snapshot.sources.get(selection?.source ?? "")?.catalogue.components.find((each) => each.id === node.component)
			?.name ??
		null
	);
}

/**
 * The Component a Placement selected places, as editing it in place needs it: its source on the page,
 * its id and name, and what Done selects again. Null when the selection is no Placement.
 */
function inPlaceTargetOf(snapshot: StructureSnapshot): InPlaceTarget | null {
	const selection = snapshot.selection;
	if (selection?.kind !== "placement") return null;
	if (!selection.key) {
		const placement = snapshot.layout?.find((each) => `content/${each.id}` === selection.ref);
		return placement
			? { source: selection.ref, componentId: placement.component, name: placement.name, placement: selection.ref }
			: null;
	}
	const node = selection.node;
	if (node?.type !== "component") return null;
	const source = `${selection.source}/${node.id}`;
	const name = placementName(snapshot, selection.ref) ?? node.component;
	return { source, componentId: node.component, name, placement: selection.ref };
}

/** The reference of the Site template's element that holds the outlet (where a Page's content goes), or null. */
function outletHolder(tree: ElementTree | undefined): string | null {
	const visit = (nodes: readonly TreeNode[], owner: TreeNode | null): string | null => {
		for (const node of nodes) {
			if (node.type === "outlet") return owner && "id" in owner ? `site#${owner.id}` : null;
			for (const list of childLists(node)) {
				const found = visit(list, node);
				if (found !== null || list.some((each) => each.type === "outlet")) return found;
			}
		}
		return null;
	};
	return tree ? visit(tree.nodes, null) : null;
}

/** What Done selects for a Component's source on the page: a Page's Placement, or the Placement node in its Template. */
function placementOfSource(snapshot: StructureSnapshot, source: string): string {
	const page = snapshot.sources.get("site")?.pageLayout;
	if (page && /^content\/[^/#]+$/.test(source)) return source;
	const at = source.lastIndexOf("/");
	return at < 0 ? source : `${source.slice(0, at)}#${source.slice(at + 1)}`;
}

export function Shell({ config }: { config: ShellConfig }) {
	const { words } = config;
	const request = useMemo(() => editRequests(config.token), [config.token]);
	const cycle = useRef<RegionCycle | null>(null);
	const frame = useRef<FrameHandle | null>(null);
	const [message, setMessage] = useState({ text: "", urgent: false, count: 0 });
	const fit = useEditorFit();

	// The rail's switches: Dark preview starts as the page shows itself (dark where the device is, if
	// the Site has Dark mode), and sets the page's theme only once the person uses it.
	const [darkPreview, setDarkPreview] = useState(
		() => config.darkMode && window.matchMedia("(prefers-color-scheme: dark)").matches,
	);
	const [theme, setTheme] = useState<PageTheme>(null);
	const [hidden, setHidden] = useState(false);
	const [exiting, setExiting] = useState(false);

	// The page in the frame and the Draft state beside Publish.
	const [shown, setShown] = useState<ShownPage | null>(null);
	// The page's languages, kept while the next page loads, so the language menu stays and keeps focus.
	const [pageLanguages, setPageLanguages] = useState<PageLanguage[]>([]);
	// What is selected on the canvas, which the docks' panels follow.
	const [selection, setSelection] = useState<PanelContext["selection"]>(null);
	const [saving, setSaving] = useState<"idle" | "saving" | "failed">("idle");
	const shownAddress = useRef<string | null>(null);
	// What Edit mode says of the page now: the Entry panel and Page details read its Entry from it (BA-13).
	const [pageState, setPageState] = useState<PageState | null>(null);

	const announce = useCallback((text: string, urgent = false) => {
		// Alternating a trailing space makes the same words twice in a row heard twice.
		setMessage((last) => ({ text: `${text}${last.count % 2 ? " " : ""}`, urgent, count: last.count + 1 }));
	}, []);

	const announceRef = useRef(announce);
	announceRef.current = announce;

	// The tab's one Undo history (ADR 0036, ADR 0037 › 1.5) and Content typed in place (BA-07): made once,
	// for the shell's life. A step on a Draft no page shows now opens that Draft for the step alone.
	const undoHistory = useMemo(
		() =>
			shellHistory({
				siteId: config.site.id,
				words,
				announce: (text, urgent) => announceRef.current(text, urgent),
				fallback: async (resource) => {
					const prefix = `draft:${config.site.id}:`;
					if (!resource.startsWith(prefix)) return undefined;
					const item = resource.slice(prefix.length);
					return { reverse: (from, to) => reverseElsewhere(item, config.token, from, to) };
				},
			}),
		[config.site.id, config.token, words],
	);
	useEffect(() => () => undoHistory.destroy(), [undoHistory]);
	const refreshRef = useRef<() => void>(() => {});
	const editing = useMemo(
		() =>
			pageEditing({
				token: config.token,
				siteId: config.site.id,
				words,
				history: undoHistory,
				announce: (text, urgent) => announceRef.current(text, urgent),
				refresh: () => refreshRef.current(),
				failed: () => setSaving("failed"),
			}),
		[config.token, config.site.id, words, undoHistory],
	);
	useEffect(() => () => editing.destroy(), [editing]);

	// The page's Structure, for Staff (BA-08): its Templates and Components, what is selected among their
	// elements, and the changes Layers and the Inspector make, each one Undo step, the page drawn again in place.
	const staff = config.permissions.includes("structure.edit");
	const selectedRef = useRef<(ref: string | null) => void>(() => {});
	const pageStructure = useMemo(
		() =>
			structure({
				token: config.token,
				siteId: config.site.id,
				words,
				request,
				history: undoHistory,
				announce: (text, urgent) => announceRef.current(text, urgent),
				rerender: () => frame.current?.rerender() ?? Promise.resolve(),
				onSelect: (ref) => selectedRef.current(ref),
				failed: () => setSaving("failed"),
			}),
		[config.token, config.site.id, words, request, undoHistory],
	);
	useEffect(() => () => pageStructure.destroy(), [pageStructure]);
	const structureNow = useSyncExternalStore(pageStructure.subscribe, pageStructure.snapshot);

	// A Page's Page layout (BA-09): its Placements moved, hidden, duplicated, deleted and their Props'
	// values changed, each one Undo step through the Page's shared Draft; then read and drawn again.
	const layoutEditor = useMemo(
		() =>
			pageLayoutEditor({
				siteId: config.site.id,
				drafts: editing.drafts(),
				words,
				announce: (text, urgent) => announceRef.current(text, urgent),
				changed: () => {
					void pageStructure.reloadLayout();
					void frame.current?.rerender();
				},
				failed: () => setSaving("failed"),
			}),
		[config.site.id, words, pageStructure, editing],
	);
	useEffect(() => () => layoutEditor.destroy(), [layoutEditor]);
	useEffect(
		() => layoutEditor.page(staff ? structureNow.layoutInfo : null),
		[layoutEditor, staff, structureNow.layoutInfo],
	);

	// A Component edited in place (BA-09, `builder/06`): the rest of the page dimmed and locked, the
	// Component panel in the left dock, Done in the bar.
	const inPlace = useMemo(
		() => componentInPlace({ words: { editing: (name) => fill(words.placements.component.editing, { name }) } }),
		[words],
	);
	useEffect(() => () => inPlace.destroy(), [inPlace]);
	const inPlaceTarget = useSyncExternalStore(inPlace.subscribe, inPlace.current);
	const editInPlace = useCallback(
		(target: InPlaceTarget) => {
			if (inPlace.current()?.source === target.source) return;
			inPlace.done();
			pageStructure.editInPlace(target.source);
			inPlace.start(target);
			announce(fill(words.placements.component.started, { name: target.name }));
			// Its first element is selected, as the Section button will leave a new one (`builder/06`).
			const page = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentDocument;
			const first = page ? rootsOf(page, target.source)[0]?.getAttribute("data-wc-code") : null;
			if (first) pageStructure.select(first);
		},
		[inPlace, pageStructure, announce, words],
	);
	const doneInPlace = useCallback(() => {
		const was = inPlace.done();
		pageStructure.editInPlace(null);
		if (!was) return;
		announce(fill(words.placements.component.ended, { name: was.name }));
		pageStructure.select(was.placement);
	}, [inPlace, pageStructure, announce, words]);
	// Inserting (BA-10): the insert row, the Command menu's Insert and the empty Page, one rule
	// (`editing/insert.ts`); the tree row's menu and the menu's Actions on the selection (`layer-ops.ts`).
	const documentKind = useRef<DocumentKind>(null);
	const editInPlaceRef = useRef(editInPlace);
	editInPlaceRef.current = editInPlace;
	const insert = useMemo(
		() =>
			makeInserter({
				token: config.token,
				siteId: config.site.id,
				words,
				structure: pageStructure,
				layout: layoutEditor,
				document: () => documentKind.current,
				announce: (text, urgent) => announceRef.current(text, urgent),
				editInPlace: (target) => editInPlaceRef.current(target),
				pick: async (kind) => {
					const item = await pickMedia({ kind });
					return item ? { id: item.id } : null;
				},
			}),
		[config.token, config.site.id, words, pageStructure, layoutEditor],
	);
	const ops = useMemo(
		() =>
			layerOps({
				token: config.token,
				siteId: config.site.id,
				words,
				structure: pageStructure,
				layout: layoutEditor,
				announce: (text, urgent) => announceRef.current(text, urgent),
			}),
		[config.token, config.site.id, words, pageStructure, layoutEditor],
	);
	// The Command menu (BA-10): ⌘K, ⌘P and ⌘I; its own file loads the first time it opens.
	const menu = useCommandMenu({ tabs: ["actions", "goTo", "insert"], announce });
	/** The name dialog of Make Component and New Component, while one asks. */
	const [naming, setNaming] = useState<ComponentNameRequest | null>(null);
	/** Make Component (the tree row's menu, Actions): the selection's name, in PascalCase, as the suggestion. */
	const makeComponent = () => {
		const snapshot = pageStructure.snapshot();
		const selected = snapshot.selection;
		if (!selected?.node) return;
		const name = anchorName(snapshot, selected.ref);
		const words_ = name
			.split(/[^A-Za-z0-9]+/)
			.filter(Boolean)
			.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
			.join("")
			.replace(/^[^A-Za-z]+/, "");
		setNaming({
			kind: "make",
			suggested: /[a-z]/.test(words_) ? words_ : "NewComponent",
			text: fill(words.componentDialog.makeText, { name }),
			node: selected.node,
			submit: (chosen, texts) => ops.makeComponent(chosen, texts),
		});
	};
	/** What the canvas selected last: its name as its chip says it, and its reference when it has one. */
	const [canvasSelection, setCanvasSelection] = useState<{ ref: string | null; name: string } | null>(null);

	/** Reads what Edit mode says of the page in the frame, for the Draft state and the languages. */
	const takeState = useCallback(
		(address: string, answer: Promise<EditAnswer<PageState>>) => {
			void answer.then((state) => {
				if (shownAddress.current !== address) return;
				setPageLanguages(state.ok ? state.data.languages : []);
				if (!state.ok) return;
				editing.pageState(state.data);
				setPageState(state.data);
				setShown({
					address,
					changes: state.data.changes.length,
					inReview: state.data.reviews.some((review) => review.status === "inReview"),
				});
			});
		},
		[editing],
	);

	// The open document (BA-06): what the address names, and where the frame shows it. Before another
	// opens, what was typed and not saved yet is saved (BA-34; the code panes come further down).
	const leavingRef = useRef<() => Promise<void>>(async () => {});
	const leaving = useCallback(() => leavingRef.current(), []);
	const opened = useOpenDocument(config, announce, leaving);
	const { framed } = opened;

	const onPage = useCallback(
		(address: string, answer: Promise<EditAnswer<PageState>>) => {
			shownAddress.current = address;
			// A page loaded: a Component edited in place on the one before is done (its Draft keeps every change).
			if (inPlace.done()) pageStructure.editInPlace(null);
			if (staff)
				pageStructure.page(address.startsWith(`${BUILDING_STAND_IN_PREFIX}/`) ? null : (address.split("?")[0] ?? "/"));
			setSaving("idle");
			setShown(null);
			setPageState(null);
			takeState(address, answer);
			framed(address, answer);
		},
		[takeState, framed, staff, pageStructure, inPlace],
	);

	// The place open over the canvas (BA-20): it takes the canvas's and the docks' room; the canvas stays
	// as it was underneath (its page, selection and panels), hidden and inert until the place is left.
	const placeKey = placeKeyOf(opened.address.place);
	const place = placeKey ? placeEntry(placeKey) : null;
	const placeOpener = useRef<Element | null>(null);
	const openPlace = useCallback(
		(key: PlaceKey) => {
			// Other places are locked while a Component is edited in place (`builder/06`): Done first.
			if (inPlace.current() && key !== placeKey) {
				announce(words.placements.component.placesLocked, true);
				return;
			}
			if (key === placeKey) {
				opened.documents.openPlace(null);
				return;
			}
			const at = reopenPlace(key);
			if (!at) return;
			if (!placeKey) placeOpener.current = document.activeElement;
			opened.documents.openPlace(at.place, at.view);
		},
		[placeKey, opened.documents, inPlace, announce, words],
	);
	const leavePlace = useCallback(() => opened.documents.openPlace(null), [opened.documents]);
	// What the open place has of its own for the bottom bar (its Draft state and Publish: the Forms
	// place's Form); the page's again once the place is left.
	const [placeBar, setPlaceBar] = useState<PlaceBar | null>(null);
	useEffect(() => {
		if (!placeKey) setPlaceBar(null);
	}, [placeKey]);
	// A Form opened from the page it is placed on ("Edit this Form", BA-27): the bar says "Back to {page}".
	const [formFrom, setFormFrom] = useState<string | null>(null);
	useEffect(() => {
		if (placeKey !== "forms") setFormFrom(null);
	}, [placeKey]);
	// The Command menu's way in and out of places (it comes with BA-10): `webcraft:place` on the shell's
	// document, its detail the place to open (`{ place: "content" }`) or none to leave (`{ place: null }`).
	useEffect(() => {
		const onPlaceEvent = (event: Event) => {
			const wanted = (event as CustomEvent<{ place?: unknown } | null>).detail?.place;
			if (wanted === null) leavePlace();
			// Opening the place that is open already leaves it open (the rail's button is the toggle).
			else if (typeof wanted === "string" && wanted !== placeKey && PLACE_KEYS.includes(wanted as PlaceKey))
				openPlace(wanted as PlaceKey);
		};
		document.addEventListener(PLACE_EVENT, onPlaceEvent);
		return () => document.removeEventListener(PLACE_EVENT, onPlaceEvent);
	}, [leavePlace, openPlace, placeKey]);
	// Said as a place opens and as it is left; leaving puts focus back where it was before the place opened.
	const lastPlace = useRef<PlaceKey | null>(null);
	useEffect(() => {
		const was = lastPlace.current;
		lastPlace.current = placeKey;
		if (was === placeKey) return;
		if (placeKey) announce(fill(words.place.opened, { place: words.places[placeKey] }));
		else if (was) {
			announce(words.place.left);
			const opener = placeOpener.current;
			placeOpener.current = null;
			const back =
				opener instanceof HTMLElement && opener.isConnected && !opener.closest("[data-wc-place-frame]")
					? opener
					: document.querySelector<HTMLElement>(`[data-wc-place="${was}"]`);
			back?.focus();
		}
	}, [placeKey, announce, words]);

	/** Reads the page's `state` again: its Draft changed (a save, someone else's change, a step taken back). */
	const refreshState = useCallback(() => {
		const address = shownAddress.current;
		if (address) takeState(address, request<PageState>("state", { path: address.split("?")[0] ?? "/" }));
	}, [request, takeState]);
	refreshRef.current = refreshState;

	const onSaving = useCallback(
		(status: SavingStatus) => {
			setSaving(status === "saving" ? "saving" : status === "failed" ? "failed" : "idle");
			// A save changes the page's Draft: its count of changes is read again.
			if (status === "saved") refreshState();
		},
		[refreshState],
	);

	// What Publish covers is read again whenever the page's state or a save changes (BA-12).
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new token each time either changes.
	const publishChanged = useMemo(() => ({}), [shown, saving]);

	useEffect(() => {
		const keys = regionCycle({ document, focusFrame });
		cycle.current = keys;
		const onKey = (event: KeyboardEvent) => {
			// Under the narrow-window notice nothing else can be reached.
			if (document.querySelector("[data-wc-narrow]")) return;
			if (keys.key(event)) return;
			// Undo and Redo of the shell's history, outside the shell's own text fields (a place's form keeps
			// the browser's). The page's text reaches the history through its agent (`editing/editing.ts`).
			if (typingIn(event.target)) return;
			if (undoHistory.key(event)) event.preventDefault();
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			cycle.current = null;
		};
	}, [undoHistory]);

	// What the selection in the Structure (the tree, Undo, the address) and on the canvas tells the rest:
	// the canvas outlines it, and the address keeps it (`wc-select`, in place).
	const documentsRef = useRef(opened.documents);
	documentsRef.current = opened.documents;
	selectedRef.current = (ref) => {
		frame.current?.select(ref, placementName(pageStructure.snapshot(), ref));
		documentsRef.current.select(ref);
	};
	// The address's selection is selected once the page shows what it names: as the shell starts (a
	// reload) and when the address changes it (Back, Forward), not again after the person selects.
	const wanted = opened.address.select;
	const siteOpen = structureNow.sources.has("site");
	const appliedSelection = useRef<string | null>(null);
	useEffect(() => {
		const key = `${shown?.address ?? ""}|${wanted ?? ""}`;
		if (!staff || !siteOpen || appliedSelection.current === key) return;
		appliedSelection.current = key;
		if (wanted && pageStructure.snapshot().selection?.ref !== wanted) pageStructure.select(wanted);
	}, [staff, siteOpen, wanted, shown?.address, pageStructure]);
	// A Filter the address asks to select (the admin's Filters screen, BA-34): where it is placed.
	useFilterSelection(staff ? pageStructure : null, opened.address.filter ?? null, shown?.address ?? null);
	// An element the address asks to select by its id (the admin's Checks, BA-28).
	useElementSelection(
		staff ? pageStructure : null,
		opened.address.element ?? null,
		shown?.address ?? null,
		opened.address.document?.kind === "siteTemplate",
	);

	// The open document is a page for now (documents come with a later part of the building area).
	// What the panels' rules read: the selection and the open document's kind (a Template of any kind is a Template).
	const kind = opened.address.document?.kind ?? null;
	documentKind.current = kind;
	const chosen = structureNow.selection;
	const chosenNode = chosen?.node;
	const panelSelection = useMemo<PanelContext["selection"]>(() => {
		if (!staff || !chosen) return selection;
		const placed = chosen.kind === "placement" ? placementName(structureNow, chosen.ref) : null;
		const name = placed
			? placed
			: chosenNode?.type === "loop"
				? chosenNode.source
				: chosenNode?.type === "condition"
					? conditionName(words, chosenNode)
					: canvasSelection?.ref === chosen.ref
						? canvasSelection.name
						: chosenNode?.type === "element"
							? `${chosenNode.tag} · ${chosenNode.label ?? tagName(chosenNode.tag, words)}`
							: (selection?.name ?? "");
		return { kind: chosen.kind, name };
	}, [staff, chosen, chosenNode, canvasSelection, selection, words, structureNow]);
	// An element a Loop repeats: the Inspector is the Loop's (`builder/07`), with the element's own below.
	const chosenSource = chosen ? structureNow.sources.get(chosen.source) : undefined;
	const loopOfElement =
		chosen?.kind === "element" && chosenSource && chosen.path ? loopAround(chosenSource.tree, chosen.path) : null;
	const context = useMemo<PanelContext>(
		() => ({
			selection: panelSelection,
			document: kind === null ? null : kind === "page" || kind === "component" || kind === "form" ? kind : "template",
			componentInPlace: inPlaceTarget !== null,
		}),
		[panelSelection, kind, inPlaceTarget],
	);
	const editTarget = staff ? inPlaceTargetOf(structureNow) : null;
	// The Entry panel (BA-13): the page's Entry filled in without leaving it; a page never published
	// follows its new slug. (A Member gets Page details in client editing's side panel instead.)
	const entryView = useEntryPanelView();
	// The code panes (BA-11): their own file, fetched the first time something is selected.
	const codePanes = useCodePanes(
		{
			config,
			words,
			structure: pageStructure,
			history: undoHistory,
			frame,
			announce,
			path: () => {
				const address = shownAddress.current;
				return address && !address.startsWith(`${BUILDING_STAND_IN_PREFIX}/`) ? (address.split("?")[0] ?? "/") : null;
			},
		},
		staff && panelSelection !== null,
	);
	const codeParts = staff ? codePaneParts(codePanes, words, panelSelection?.name ?? "") : null;
	leavingRef.current = async () => {
		await frame.current?.flush();
		await codePanes.panes?.flush();
	};
	const docks = useDocks({
		config,
		context,
		announce,
		panelActions: {
			entry: <EntryPanelActions words={words} view={entryView} />,
			...codeParts?.actions,
			...(staff && editTarget && !inPlaceTarget
				? {
						inspector: (
							<PanelButton
								icon={PencilIcon}
								label={words.placements.props.edit}
								onClick={() => editInPlace(editTarget)}
								data={{ "data-wc-edit-component": "" }}
							/>
						),
					}
				: {}),
			...(staff && inPlaceTarget
				? { component: <AddPropButton structure={pageStructure} words={words} target={inPlaceTarget} /> }
				: {}),
		},
		menus: codeParts?.menus,
		wide: codePanes.wide,
		headings: {
			...(chosenNode?.type === "form" ? { inspector: <FormPanelHeading words={words} /> } : {}),
			layers: (
				<DocumentSwitcher
					words={words}
					title={opened.title}
					current={opened.address.document}
					data={opened.switchable}
					onOpen={opened.open}
				/>
			),
			// The Component edited in place: its name in the Component colour (`builder/06`).
			...(inPlaceTarget
				? {
						component: (
							<span className="truncate text-[12px] font-semibold text-[#a78bfa]" data-wc-in-place-title="">
								{inPlaceTarget.name}
							</span>
						),
					}
				: {}),
		},
		bodies: {
			entry: (
				<EntryPanel
					token={config.token}
					siteId={config.site.id}
					words={words}
					request={request}
					page={pageState}
					onSaving={onSaving}
					onMoved={(path) => opened.documents.replace({ kind: "page", page: path })}
					announce={announce}
					view={entryView}
					admin={config.admin}
					onLanguage={(path) => frame.current?.navigate(path)}
				/>
			),
			...(staff
				? {
						layers: (
							<Layers
								structure={pageStructure}
								words={words}
								layout={layoutEditor}
								menu={{
									ops,
									makeComponent,
									ask: (question) => menu.setRequest({ tab: "insert", step: question }),
								}}
							/>
						),
						inspector: (
							// A placed Form is one thing: its own panel (BA-27); anything else, the Inspector.
							<FormPanel
								config={config}
								words={words}
								structure={pageStructure}
								announce={announce}
								onEdit={(formId) => {
									setFormFrom(opened.title.name || titleText(words, opened.title));
									opened.documents.openPlace(`forms/${formId}`);
								}}
								fallback={
									<Inspector
										structure={pageStructure}
										words={words}
										token={config.token}
										siteId={config.site.id}
										layout={layoutEditor}
										onOpenComponent={(componentId, source) => {
											// Placed on this page: edited in place; else opened as the document.
											const snapshot = pageStructure.snapshot();
											const placed = snapshot.sources.get(source);
											if (placed)
												editInPlace({
													source,
													componentId,
													name: placed.name ?? componentId,
													placement: placementOfSource(snapshot, source),
												});
											else opened.open({ kind: "component", componentId });
										}}
										onOpenLoop={(loopId) => opened.documents.openPlace(`loops/${loopId}`)}
									/>
								}
							/>
						),
						...(inPlaceTarget
							? { component: <ComponentPanel structure={pageStructure} words={words} target={inPlaceTarget} /> }
							: {}),
						...codeParts?.bodies,
					}
				: {}),
		},
		titles: loopOfElement ? { inspector: words.inspectorTitles.loop } : {},
		subs: { ...codeParts?.subs, ...(loopOfElement ? { inspector: loopOfElement.node.source } : {}) },
	});

	const exit = async () => {
		setExiting(true);
		announce(words.exiting);
		// Whatever was typed and not saved yet is saved before the session ends (the page, the code panes).
		await frame.current?.flush();
		await codePanes.panes?.flush();
		const answer = await request("end", {});
		if (!answer.ok && answer.code !== "EDIT_MODE_ENDED") {
			setExiting(false);
			announce(fill(words.exitFailed, { reason: answer.code }), true);
			return;
		}
		window.location.assign(config.returnTo);
	};

	/** New Component (Actions, Insert): placed where Insert would put it, then opened to build it. */
	const newComponent = () => {
		const landing = insert.landing("component");
		const anchor =
			landing.kind !== "refused" && landing.anchor ? anchorName(pageStructure.snapshot(), landing.anchor) : null;
		setNaming({
			kind: "new",
			suggested: "NewComponent",
			text: fill(words.componentDialog.newText, {
				where: anchor ? fill(words.insert.whereAfter, { name: anchor }) : words.insert.wherePage,
			}),
			submit: async (name) => {
				try {
					const { component } = await managementApi(config.token).components.create({ siteId: config.site.id, name });
					const at = insert.landing("component");
					if (at.kind === "page") await insert.placeComponent(component.id, at);
					else if (at.kind === "tree") {
						const source = pageStructure.snapshot().sources.get(at.source);
						const placed = { type: "component", id: "new", component: component.id, props: [] } as TreeNode;
						if (source) insert.insertNodes(withNewIds(source.tree, [placed]), name, at);
					}
					announce(fill(words.componentDialog.made, { name }));
					opened.open({ kind: "component", componentId: component.id });
					return null;
				} catch (error) {
					return fill(words.componentDialog.refused, {
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			},
		});
	};
	const selectedPlacement = staff
		? (structureNow.layout?.find((each) => `content/${each.id}` === structureNow.selection?.ref) ?? null)
		: null;
	const menuHost: MenuHost = {
		config,
		words,
		announce,
		history: {
			undo: () => undoHistory.undo(),
			redo: () => undoHistory.redo(),
			state: () => editorHistory().state(),
		},
		publish: () => document.dispatchEvent(new CustomEvent(PUBLISH_OPEN_EVENT)),
		places: PLACE_KEYS.filter((key) => placeEntry(key)).map((key) => ({ key, name: words.places[key] })),
		place: placeKey,
		openPlace: (key) => openPlace(key as PlaceKey),
		leavePlace,
		open: opened.open,
		exit: () => void exit(),
		hidden: { on: hidden, set: setHidden },
		staff: staff
			? {
					structure: pageStructure,
					ops,
					inserter: insert,
					editComponent: editTarget && !inPlaceTarget ? () => editInPlace(editTarget) : null,
					toggleHidden: selectedPlacement
						? {
								hidden: selectedPlacement.hidden,
								run: () => {
									const refused = layoutEditor.hide(structureNow.layout ?? [], selectedPlacement.id);
									if (refused) announce(refused, true);
								},
							}
						: null,
					makeComponent,
					newComponent,
					parts: {
						icons: KIND_ICONS,
						tags: KIND_TAGS,
						anchorName,
						childLists,
						newElement,
						withNewIds,
						readExpression,
					},
				}
			: undefined,
	};
	const siteSource = structureNow.sources.get("site");
	const isPage = Boolean(siteSource?.pageLayout) && kind !== "siteTemplate";
	// An empty Page says how to start (`builder/04`), on a Page that shows nothing yet.
	const emptyPage =
		staff &&
		isPage &&
		kind === "page" &&
		structureNow.layout?.length === 0 &&
		!place &&
		!inPlaceTarget &&
		opened.shown?.status === "shown";

	return (
		<div
			className="bg-chrome text-chrome-text grid h-dvh w-full grid-cols-[48px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_48px] overflow-hidden font-sans text-[12px]"
			data-interface={hidden ? "hidden" : "shown"}
			data-place={placeKey ?? undefined}
			data-wc-staff=""
		>
			{/* The page itself is the main content: following the link puts focus in the frame (see <main>). */}
			<a
				href="#wc-canvas"
				className="focus:ring-chrome-focus focus:ring-offset-chrome sr-only rounded-md bg-white px-3 py-2 text-[13px] font-medium text-[#121214] focus:not-sr-only focus:fixed focus:start-14 focus:top-2 focus:z-50 focus:ring-2 focus:ring-offset-2"
			>
				{words.skipToContent}
			</a>
			<Rail
				config={config}
				place={placeKey}
				onPlace={openPlace}
				darkPreview={darkPreview}
				onDarkPreview={(on) => {
					setDarkPreview(on);
					setTheme(on ? "dark" : "light");
				}}
				hidden={hidden}
				onHidden={setHidden}
				onExit={() => void exit()}
				exiting={exiting}
				panelsMenu={<PanelsMenu docks={docks} />}
			/>
			{/* Before the canvas in the Tab order, so the page (and whatever it holds) comes last; F6 still goes rail, page, bar. */}
			<BottomBar
				words={words}
				language={config.language}
				languages={place || inPlaceTarget ? [] : pageLanguages}
				onLanguage={(language) => frame.current?.navigate(language.path)}
				nav={
					place ? (
						placeKey === "forms" && formFrom ? (
							<DocumentNav
								words={words}
								back={{ title: formFrom, onBack: () => opened.documents.openPlace(null) }}
								preview={null}
								renderedBy={null}
							/>
						) : null
					) : (
						<DocumentNav words={words} back={opened.back} preview={opened.preview} renderedBy={opened.renderedBy} />
					)
				}
				insertRow={!place}
				insert={
					staff ? (
						<InsertRow
							words={words}
							inserter={insert}
							onMenu={menu.setRequest}
							onPage={isPage}
							template={kind === "siteTemplate" && Boolean(siteSource?.catalogue.commands.includes("outlet"))}
						/>
					) : null
				}
				preview={shown && !inPlaceTarget ? sitePreview(config, shown.address) : null}
				onUndo={() => void undoHistory.undo()}
				onRedo={() => void undoHistory.redo()}
				draft={draftStateOf(saving, place && placeBar ? { changes: placeBar.changes, inReview: false } : shown)}
				publish={
					<>
						{inPlaceTarget && !place ? (
							<button
								type="button"
								onClick={doneInPlace}
								className="border-chrome-line text-chrome-strong hover:bg-chrome-hover focus-visible:ring-chrome-focus h-8 shrink-0 rounded-md border px-5 text-[13px] font-medium outline-none focus-visible:ring-2"
								data-wc-done=""
							>
								{words.placements.component.done}
							</button>
						) : null}
						<Publish
							config={config}
							request={request}
							path={shown ? (shown.address.split("?")[0] ?? "/") : null}
							document={opened.address.document}
							changed={publishChanged}
							handedIn={place && placeBar ? placeBar : null}
							announce={announce}
							onPublished={refreshState}
						/>
					</>
				}
			/>
			{/*
			  The working area: the docks around the canvas (left and right full height, the bottom one under
			  the canvas). The docks come before the canvas in the Tab order, so the page is still the last stop.
			  A place replaces the canvas and the docks (SPEC 8): it covers the whole working area, while both
			  stay as they were underneath, hidden and inert, until the place is left.
			*/}
			<div
				className="relative col-start-2 row-start-1 grid min-h-0 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] [grid-template-areas:'left_canvas_right'_'left_bottom_right']"
				data-wc-work=""
			>
				<div
					className={`contents ${place ? "invisible" : ""}`}
					inert={place ? true : undefined}
					data-wc-docks-under-place=""
				>
					<DockArea
						docks={docks}
						fit={fit.layout}
						hidden={hidden}
						onHideFocus={() => document.querySelector<HTMLElement>('[data-wc-rail="panels"]')?.focus()}
					/>
				</div>
				<main
					id="wc-canvas"
					tabIndex={-1}
					onFocus={(event) => {
						// Reached by the skip link: focus goes on into the page, and the address keeps no fragment.
						if (event.target !== event.currentTarget) return;
						focusFrame();
						if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
					}}
					aria-label={place && placeKey ? words.places[placeKey] : words.canvas}
					data-building-region="canvas"
					// Not positioned, so an open place (absolute, inset 0) covers the working area, docks included.
					className="min-h-0 min-w-0 [grid-area:canvas]"
				>
					{/* While a place is open the canvas stays as it was (its page, selection and panels), hidden and inert. */}
					<div
						className={`relative h-full w-full ${place ? "invisible" : ""}`}
						inert={place ? true : undefined}
						data-wc-under-place=""
					>
						{opened.shown?.status === "missing" || opened.shown?.status === "later" ? (
							<NoDocument words={words} why={opened.shown.status} />
						) : null}
						{/* An empty Page says how to start (`builder/04`); before the frame, so the page stays the last stop. */}
						{emptyPage ? (
							<EmptyPage
								words={words}
								frame={frame}
								outlet={outletHolder(siteSource?.tree)}
								onAddComponent={() => menu.setRequest({ tab: "insert", only: "components" })}
								onNewSection={() => void insert.newSection(0)}
							/>
						) : null}
						{/* Before the frame in the Tab order: the page stays the last stop. */}
						{opened.shown?.status === "shown" ? <TextToolbar editing={editing} words={words} /> : null}
						{opened.shown?.status === "shown" ? (
							<Frame
								address={opened.shown.frame}
								following={hidden}
								onFollow={opened.follow}
								words={words}
								request={request}
								cycle={() => cycle.current}
								announce={announce}
								breakpoints={config.breakpoints}
								theme={theme}
								handle={frame}
								onPage={onPage}
								onSaving={onSaving}
								onSelect={(selected) => {
									setSelection(selected ? { kind: "element", name: selected.name } : null);
									const ref = selected ? (chosenRefOf(selected.element) ?? refOf(selected.element)) : null;
									setCanvasSelection(selected ? { ref, name: selected.name } : null);
									if (!staff) return;
									// The canvas selected it: the Structure, the tree and the address follow.
									pageStructure.select(ref, "canvas");
									// What the Structure selected (a Page's Placement for its element; what was, when refused).
									documentsRef.current.select(pageStructure.snapshot().selection?.ref ?? null);
								}}
								onReady={(document) => {
									if (staff) pageStructure.found(document);
									// The Component edited in place stays locked and dimmed on the page as drawn now.
									inPlace.page(document, frame.current?.overlay() ?? null);
									readFormNames(document, () => managementApi(config.token).forms.list({ siteId: config.site.id }));
								}}
								editing={editing}
							/>
						) : null}
						{/* The Breakpoints switched on in Styles (BA-24), drawn where the frame's edges would be. */}
						<BreakpointLines />
					</div>
					{/* Each place's code is fetched the first time it opens (BA-30): its frame shows at once meanwhile. */}
					{place && opened.address.place ? (
						<PlaceLoader
							entry={place}
							config={config}
							words={words}
							place={opened.address.place}
							view={opened.address.view ?? null}
							documents={opened.documents}
							documentName={opened.title.name}
							leave={leavePlace}
							open={opened.open}
							announce={announce}
							onSaving={(status) => setSaving(status === "saving" ? "saving" : status === "failed" ? "failed" : "idle")}
							onBar={setPlaceBar}
						/>
					) : null}
				</main>
			</div>
			<div className="sr-only" data-wc-messages="">
				<p role="status" aria-live="polite" aria-atomic="true">
					{message.urgent ? "" : message.text}
				</p>
				<p role="alert" aria-live="assertive" aria-atomic="true">
					{message.urgent ? message.text : ""}
				</p>
			</div>
			<NarrowNotice covered={fit.covered} words={words} back={config.returnTo} />
			{staff ? <InsertLine inserter={insert} frame={frame} /> : null}
			<CommandMenuHost host={menuHost} request={menu.request} onRequest={menu.setRequest} />
			{naming ? <ComponentNameDialog words={words} request={naming} onDone={() => setNaming(null)} /> : null}
			{/* The Media picker (`pickMedia()`) and the toasts of the Media parts (BA-22). */}
			<MediaShellHost config={config} />
		</div>
	);
}
