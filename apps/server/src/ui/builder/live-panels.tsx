import type { CommandMenuData, FieldInput, MadeComponent, Permission } from "@webcraft/core";
import { type Json, reverseChange, sameValue } from "@webcraft/core/draft-document";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import { DialogContainer } from "@webcraft/ui/components/dialog.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { type SharedDraft, useSharedDraft } from "../co-editing/shared-draft.ts";
import { errorMessage } from "../errors.ts";
import { AdminIntl, adminMessages, useT } from "../i18n.tsx";
import { type BindKind, BindPropDialog, type Bound } from "./BindPropDialog.tsx";
import { CommandMenu, type MenuState, ShortcutsDialog, useEditorKeys, useHistoryKeys } from "./CommandMenu.tsx";
import { ComponentDialog, type ComponentPrompt, componentNameFrom, componentRefusal } from "./ComponentDialog.tsx";
import { CssPanel, type CssPanelPort, type CssTarget } from "./CssPanel.tsx";
import { loopCounts } from "./canvas-metadata.ts";
import { type ClassReceipt, classHistoryPort } from "./class-history.ts";
import {
	type CommandTab,
	type EditorCommandTarget,
	editorCommands,
	historyCommandTarget,
	type WrapKind,
} from "./commands.ts";
import type { AnnouncementPriority } from "./editor-accessibility.ts";
import { type EditorApi, EditorApiContext, EditorEnvironment } from "./editor-api.tsx";
import { editorHistory, type HistoryLocation } from "./editor-history.ts";
import { FixedTextDialog } from "./FixedTextDialog.tsx";
import { type FixedTextLocation, rememberFixedText, resolveFixedText } from "./fixed-text.ts";
import { goToCommands } from "./go-to.ts";
import { historyLanguage } from "./history-language.ts";
import { recordSourceHistory } from "./history-receipt.ts";
import { inspectorHistoryTab, revealInspectorHistory } from "./history-reveal.ts";
import { connectHistory } from "./history-transport.ts";
import { InsertToolbar } from "./InsertToolbar.tsx";
import { Inspector } from "./Inspector.tsx";
import { elementBuilder, type InsertWhere, insertItems, insertNow } from "./insert-items.tsx";
import { type LayerAction, type LayerSource, LayersPanel, rowKey } from "./LayersPanel.tsx";
import { type LayerClipboard, layerLocation, runLayerAction } from "./layer-actions.ts";
import { type BuilderTarget, layerName, type Opened, type Selection, targetPath } from "./model.ts";
import { identifyNewProps } from "./prop-identities.ts";
import { hoveredRow, selectionKey, selectionOf } from "./selection-ref.ts";
import { serverChangeArrived } from "./server-change.ts";
import { ariaKeys, withKeys } from "./shortcuts.ts";
import {
	canHoldChildren,
	canUnwrap,
	childLists,
	insertAt,
	insertionPlace,
	listAt,
	moveTo,
	type NodePath,
	nodeAt,
	pathIn,
	pathOfId,
	placeBy,
	replaceAt,
	treeProblem,
	unwrapAt,
	wrapAt,
} from "./tree.ts";
import { useEditorAnnouncement } from "./use-editor-announcement.ts";

export type PanelSource = {
	opened: Opened;
	target: BuilderTarget;
	ref: string;
	siteId: string;
	adminOrigin: string;
	editable: boolean;
	name: string | null;
	pageLayout: { id: string; title: string } | null;
	contentAvailable: boolean;
};
export type LivePanelBridge = {
	root: ShadowRoot;
	historyToken?: string | null;
	initialFocus?: string | null;
	/** Where the CSS panel draws: Code mode's CSS panel, below the page. */
	cssHost?: HTMLElement;
	/** Shows unsaved CSS on the page, or (null) the Draft again. */
	previewCss?(change: { target: CssTarget; text: string } | null): void;
	/** A shared panel changed authored input without a native input event. */
	edited?(): void;
	language: "en" | "it";
	call<T>(action: string, body: object): Promise<T>;
	select(ref: string, inspectorRef?: string): void;
	revealHistory(ref: string, panel: string, resource?: string): Promise<void>;
	changed(ref: string, markup: string, preserveAuthored?: boolean): void;
	hover(ref: string | null): void;
	ready(ref: string, editable: boolean): void;
	refresh(): void;
	insertPreview(
		ref: string | null,
		where: InsertWhere,
		context?: { ref: string; markup: string; offset: number; label: string },
	): void;
	/** What only Code mode's own panels and the editing bar do, for the Command menu (#131). */
	commands?: CodeModeCommands;
};
export type CodeModeCommands = {
	/** Whether this browser is in Safe mode (ADR 0022). */
	safeMode: boolean;
	/** Saves the HTML, CSS and JS panels, as Ctrl+S does in each. */
	save(): Promise<void>;
	openBuilder(): void;
	showPanels(): void;
	openPageScript(): void;
	/** Leaves for another address once every panel saved (switching pages keeps the Draft). */
	leaveTo(url: string): Promise<void>;
	/** The editing bar's own actions: Publish opens its confirmation. */
	bar(action: "publish" | "safeMode" | "preview" | "leave"): void;
};
type PanelCommands = {
	save(): Promise<boolean>;
	markup(ref: string): Promise<string | null>;
};

/** Panels follow the shared document when connected; an HTTP refresh supplies only its catalogue. */
function currentDraft(source: PanelSource, shared?: SharedDraft): Pick<Opened, "tree" | "props"> {
	const draft = shared?.draft();
	if (!draft) return { tree: source.opened.tree, props: source.opened.props };
	return source.opened.component
		? {
				tree: (draft as unknown as { tree: ElementTree }).tree,
				props: (draft as unknown as { props: Opened["props"] }).props,
			}
		: { tree: draft as unknown as ElementTree, props: null };
}

/** Save one-off styles against the version of the tree being printed, never a later version. */
async function saveOneOffStyles(
	bridge: LivePanelBridge,
	ref: string,
	styles: Record<string, string>,
	replaceElement?: string,
) {
	const { opened } = await bridge.call<PanelSource>("code/editor", { ref });
	let tree = opened.tree;
	// The Inspector replaces that element's one-off declarations, including clearing them.
	if (replaceElement) {
		const path = pathOfId(tree, replaceElement);
		const node = path && nodeAt(tree, path);
		if (path && node?.type === "element") {
			const generated = new Set(opened.catalogue.classes.filter((each) => each.generated).map((each) => each.id));
			tree = replaceAt(tree, path, { ...node, classes: node.classes.filter((id) => !generated.has(id)) });
		}
	}
	const { markup } = await bridge.call<{ markup: string }>("code/editorMarkup", {
		ref,
		draft: { tree, styles, ...(opened.props ? { props: opened.props } : {}) },
	});
	return bridge.call<{ history: { resource: string; before: Json; after: Json }[] }>("code/save", {
		ref,
		markup,
		version: opened.version,
	});
}

export function mount(bridge: LivePanelBridge) {
	void bridge
		.call<PanelSource>("code/editor", { ref: "site" })
		.then((source) =>
			connectHistory(source.siteId, (method, input) => bridge.call(`code/${method}`, input), true, bridge.historyToken),
		);
	const container = document.createElement("div");
	container.className = "editor-panels dark";
	bridge.root.append(container);
	const react = createRoot(container);
	const request = <T,>(method: string, input: unknown) => bridge.call<T>("code/editorService", { method, input });
	const api: EditorApi = {
		designSystem: {
			createClass: (input) => request("classes.create", input),
			updateClass: (input) => request("classes.update", input),
		},
		media: { list: (input) => request("media.list", input) },
		globals: {
			get: (input) => request("globals.get", input),
			setFields: (input) => request("globals.setFields", input),
		},
		postTypes: {
			get: (input) => request("postTypes.get", input),
			update: (input) => request("postTypes.update", input),
		},
	};
	const getApi = async () => api;
	let selection: string | null = null;
	let hovered: string | null = null;
	const commands: PanelCommands = { save: async () => false, markup: async () => null };
	const oneOffDeparture = { current: null as (() => Promise<boolean>) | null };
	const cssDeparture = { current: null as (() => Promise<boolean>) | null };
	/** Opens the Command menu: Code mode's own toolbar button calls it. */
	const menuOpener = { current: null as ((tab: CommandTab) => void) | null };
	const opener = adminMessages[bridge.language].builder.commandMenu.open;
	const show = (ref: string | null) => {
		selection = ref;
		react.render(
			<AdminIntl language={bridge.language}>
				<EditorApiContext value={getApi}>
					<DialogContainer value={container}>
						<LivePanels
							bridge={bridge}
							selected={selection}
							hovered={hovered}
							commands={commands}
							oneOffDeparture={oneOffDeparture}
							cssDeparture={cssDeparture}
							menuOpener={menuOpener}
						/>
					</DialogContainer>
				</EditorApiContext>
			</AdminIntl>,
		);
	};
	show(null);
	return {
		history: editorHistory(),
		historyShortcuts: {
			undo: { keys: ariaKeys("editor.undo"), title: (label: string) => withKeys(label, "editor.undo") },
			redo: { keys: ariaKeys("editor.redo"), title: (label: string) => withKeys(label, "editor.redo") },
		},
		select: show,
		refresh: () => show(selection),
		depart: async () =>
			(!oneOffDeparture.current || (await oneOffDeparture.current())) &&
			(!cssDeparture.current || (await cssDeparture.current())) &&
			(await commands.save()),
		save: async () => (!cssDeparture.current || (await cssDeparture.current())) && (await commands.save()),
		markup: (ref: string) => commands.markup(ref),
		openCommandMenu: () => menuOpener.current?.("actions"),
		/** The toolbar button's name, tooltip and keys, from the shortcut registry. */
		commandButton: { label: opener, title: withKeys(opener, "menu.actions"), keys: ariaKeys("menu.actions") },
		hover: (ref: string | null) => {
			hovered = ref;
			show(selection);
		},
	};
}

function LivePanels({
	bridge,
	selected,
	hovered,
	commands,
	oneOffDeparture,
	cssDeparture,
	menuOpener,
}: {
	menuOpener: { current: ((tab: CommandTab) => void) | null };
	bridge: LivePanelBridge;
	selected: string | null;
	hovered: string | null;
	commands: PanelCommands;
	oneOffDeparture: { current: (() => Promise<boolean>) | null };
	cssDeparture: { current: (() => Promise<boolean>) | null };
}) {
	const t = useT();
	const history = editorHistory();
	history.configure(historyLanguage(t));
	useHistoryKeys(historyCommandTarget(history));
	const [sources, setSources] = useState<Record<string, PanelSource>>({});
	const [active, setActive] = useState<string | null>(null);
	const [error, setErrorText] = useState("");
	const [, announceError] = useEditorAnnouncement();
	const setError = useCallback(
		(message: string, priority: AnnouncementPriority = "polite") => {
			setErrorText(message);
			announceError(message, priority);
		},
		[announceError],
	);
	const [creating, setCreating] = useState(false);
	const [connectionVersion, connectionChanged] = useState(0);
	const [requested, requestSelection] = useState<{ ref: string; selection: Selection } | null>(null);
	const [designVersion, designChanged] = useState(0);
	const connections = useRef(new Map<string, SharedDraft>());
	const loading = useRef(new Set<string>());
	const selectedNow = useRef(selected);
	selectedNow.current = selected;
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;
	useEffect(
		() =>
			history.listen({
				reveal: async (location) => {
					const source = Object.values(sourcesRef.current).find(
						(each) =>
							`draft:${each.siteId}:${each.opened.component ? "component" : "template"}:${each.opened.component?.id ?? each.opened.template?.id}` ===
							location.draft,
					);
					if (!source) return location.panel !== "js" && !location.draft && location.title === document.title;
					const id = source.opened.component?.id ?? source.opened.template?.id;
					const tree = currentDraft(source, connections.current.get(id ?? source.ref)).tree;
					const selection = location.selection ? selectionOf(tree, location.selection) : null;
					if (selection) requestSelection({ ref: source.ref, selection });
					setActive(source.ref);
					await bridge.revealHistory(
						selection && location.selection ? `${source.ref}#${location.selection}` : source.ref,
						location.panel,
						location.resource,
					);
					requestAnimationFrame(() => revealInspectorHistory(location.inspectorTab));
					return true;
				},
			}),
		[history, bridge],
	);
	const typing = useRef(false);
	const draftChangeCount = useRef(0);
	/** Peer snapshots invalidate a pending keyboard move, across every Placement of its Draft. */
	const remoteRevisions = useRef(new Map<string, number>());
	const paintRuns = useRef(new Map<string, number>());
	const paint = useCallback(
		(ref: string, tree: ElementTree) => {
			const source = sourcesRef.current[ref];
			if (!source) return;
			const id = source.opened.component?.id ?? source.opened.template?.id;
			const key = id ?? ref;
			const run = (paintRuns.current.get(key) ?? 0) + 1;
			paintRuns.current.set(key, run);
			const { props } = currentDraft(source, connections.current.get(id ?? ref));
			bridge
				.call<{ markup: string }>("code/editorMarkup", { ref, draft: { tree, ...(props ? { props } : {}) } })
				.then(({ markup }) => {
					if (paintRuns.current.get(key) !== run) return;
					const sourceNow = sourcesRef.current[ref];
					if (!sourceNow) return;
					const currentId = sourceNow.opened.component?.id ?? sourceNow.opened.template?.id;
					const current = currentDraft(sourceNow, connections.current.get(currentId ?? ref));
					if (!sameValue(tree, current.tree) || !sameValue(props, current.props)) return;
					const refs = id
						? Object.values(sourcesRef.current)
								.filter((each) => (each.opened.component?.id ?? each.opened.template?.id) === id)
								.map((each) => each.ref)
						: [ref];
					for (const each of refs) bridge.changed(each, markup, typing.current);
				})
				.catch((failure) => setError(t(errorMessage(failure))));
		},
		[bridge, t, setError],
	);
	const update = useCallback((ref: string, tree: ElementTree, props?: Opened["props"]) => {
		draftChangeCount.current++;
		setSources((before) => {
			const source = before[ref];
			if (!source) return before;
			const id = source.opened.component?.id ?? source.opened.template?.id;
			return Object.fromEntries(
				Object.entries(before).map(([key, each]) => [
					key,
					(id ? (each.opened.component?.id ?? each.opened.template?.id) === id : key === ref)
						? { ...each, opened: { ...each.opened, tree, ...(props !== undefined ? { props } : {}) } }
						: each,
				]),
			);
		});
	}, []);
	const receive = useCallback(
		(ref: string, tree: ElementTree, props?: Opened["props"]) => {
			const before = sourcesRef.current[ref]?.opened;
			if (before && sameValue(before.tree, tree) && (props === undefined || sameValue(before.props, props))) return;
			const id = before?.component?.id ?? before?.template?.id ?? ref;
			remoteRevisions.current.set(id, (remoteRevisions.current.get(id) ?? 0) + 1);
			update(ref, tree, props);
			paint(ref, tree);
		},
		[update, paint],
	);
	const sourceRead = useRef(0);
	const sourceReads = useRef(new Map<string | null, number>());
	const load = useCallback(
		async (ref: string | null): Promise<PanelSource> => {
			const run = ++sourceRead.current;
			sourceReads.current.set(ref, run);
			const source = await bridge.call<PanelSource>("code/editor", { ref });
			// Catalogue reads belong to their source and cannot replace a newer read of that source.
			if (sourceReads.current.get(ref) !== run || (sourceReads.current.get(source.ref) ?? 0) > run) return source;
			sourceReads.current.set(source.ref, run);
			setSources((before) => {
				if (sourceReads.current.get(source.ref) !== run) return before;
				const id = source.opened.component?.id ?? source.opened.template?.id;
				const draft = id ? connections.current.get(id)?.draft() : null;
				return {
					...before,
					[source.ref]: draft
						? {
								...source,
								opened: {
									...source.opened,
									tree: (source.opened.component ? (draft as { tree: Json }).tree : draft) as unknown as ElementTree,
									...(source.opened.component ? { props: (draft as unknown as { props: Opened["props"] }).props } : {}),
								},
							}
						: source,
				};
			});
			return source;
		},
		[bridge],
	);
	const designLoaded = useRef(false);
	useEffect(() => {
		commands.markup = async (ref) => {
			const loaded = sourcesRef.current[ref] ?? (await load(ref));
			for (;;) {
				const source = sourcesRef.current[ref] ?? loaded;
				const id = source.opened.component?.id ?? source.opened.template?.id;
				const draft = currentDraft(source, connections.current.get(id ?? ref));
				const { markup } = await bridge.call<{ markup: string }>("code/editorMarkup", {
					ref,
					draft: { tree: draft.tree, ...(draft.props ? { props: draft.props } : {}) },
				});
				const current = sourcesRef.current[ref] ?? loaded;
				const currentId = current.opened.component?.id ?? current.opened.template?.id;
				// A source switch must display the shared Draft even if a peer changed it while printing.
				if (sameValue(draft, currentDraft(current, connections.current.get(currentId ?? ref)))) return markup;
			}
		};
	}, [bridge, commands, load]);
	useSharedDraft({
		path: "/_webcraft/edit/drafts/designSystem",
		token: document.querySelector('meta[name="webcraft-edit-token"]')?.getAttribute("content") ?? "",
		onRemote() {
			// The initial snapshot is already rendered on the page. Replacing it would steal focus.
			if (designLoaded.current) {
				bridge.refresh();
				designChanged((count) => count + 1);
			}
			designLoaded.current = true;
			void Promise.all(Object.keys(sourcesRef.current).map(load)).catch((failure) =>
				setError(t(errorMessage(failure))),
			);
		},
	});
	useEffect(() => {
		let current = true;
		const ref = selected?.split("#")[0] ?? null;
		const existing = ref ? sourcesRef.current[ref] : undefined;
		if (existing) {
			setActive(existing.ref);
			return;
		}
		load(ref)
			.then((source) => {
				if (current) setActive(source.ref);
			})
			.catch((failure) => setError(t(errorMessage(failure))));
		return () => {
			current = false;
		};
	}, [selected, load, t, setError]);
	useEffect(() => {
		const requested = new Set(["site"]);
		for (const element of document.querySelectorAll("[data-wc-code]")) {
			const ref = element.getAttribute("data-wc-code")?.split("#")[0];
			if (ref && (ref.startsWith("site") || sources.site?.contentAvailable)) requested.add(ref);
		}
		const visit = (ref: string, nodes: readonly TreeNode[]) => {
			for (const node of nodes) {
				if (node.type === "component") requested.add(`${ref}/${node.id}`);
				for (const list of childLists(node)) visit(ref, list);
			}
		};
		for (const source of Object.values(sources)) visit(source.ref, source.opened.tree.nodes);
		for (const ref of requested)
			if (!sources[ref] && !loading.current.has(ref)) {
				loading.current.add(ref);
				void load(ref).catch(() => {});
			}
	}, [sources, load]);
	const unique = [
		...new Map(
			Object.values(sources)
				.filter((source) => source.opened.component || source.opened.template)
				.map((source) => [source.opened.component?.id ?? source.opened.template?.id, source]),
		).values(),
	];
	useEffect(() => {
		const area = bridge.root.querySelector<HTMLTextAreaElement>(".language-markup textarea");
		if (!area) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let generation = 0;
		let pending: ReturnType<SharedDraft["prepare"]> = null;
		let pendingRef: string | undefined;
		let step: number | undefined;
		let previousText = area.value;
		const resourceOf = (source: PanelSource) =>
			`draft:${source.siteId}:${source.opened.component ? "component" : "template"}:${source.opened.component?.id ?? source.opened.template?.id}`;
		const begin = () => {
			const ref = area.dataset.editorRef;
			const source = ref ? sourcesRef.current[ref] : undefined;
			const id = source?.opened.component?.id ?? source?.opened.template?.id;
			const shared = id ? connections.current.get(id) : undefined;
			if (pendingRef !== ref) {
				pending?.cancel();
				pending = null;
			}
			if (shared) pending ??= shared.prepare();
			pendingRef = ref;
			return { ref, source, shared };
		};
		const performCommit = async (): Promise<boolean> => {
			clearTimeout(timer);
			const { ref, source, shared } = begin();
			if (!ref || !source) return false;
			const run = generation;
			const committedStep = step;
			const markup = area.value;
			try {
				const read = await bridge.call<{ tree: ElementTree; styles: Record<string, string>; props?: Json | null }>(
					"code/editorRead",
					{ ref, markup },
				);
				if (run !== generation) return false;
				if (!shared) {
					const saved = await bridge.call<{ history: { resource: string; before: Json; after: Json }[] }>("code/save", {
						ref,
						markup,
						version: source.opened.version,
					});
					for (const change of saved.history) history.attach(committedStep, change);
					const draft = saved.history.at(-1);
					if (draft) history.renameResource(resourceOf(source), draft.resource);
					await load(ref);
				} else {
					if (!pending) return false;
					const next = source.opened.component
						? {
								...(pending.before as Record<string, Json>),
								tree: read.tree as unknown as Json,
								...(read.props ? { props: read.props } : {}),
							}
						: (read.tree as unknown as Json);
					const before = shared.draft();
					if (!pending.apply(next, { keep: true })) {
						pending = null;
						setError(t("coEditing.status.readOnly"), "interrupt");
						return false;
					}
					const draft = shared.draft();
					history.attach(committedStep, { resource: resourceOf(source), before, after: draft });
					const tree = (source.opened.component ? (draft as { tree: Json }).tree : draft) as unknown as ElementTree;
					update(ref, tree, source.opened.component ? (draft as unknown as { props: Opened["props"] }).props : null);
					if (!(await shared.flush())) return false;
					if (Object.keys(read.styles).length) {
						// Inline styles become generated Classes through the existing validated markup saver.
						const saved = await saveOneOffStyles(bridge, ref, read.styles);
						for (const change of saved.history) history.attach(committedStep, change);
						await load(ref);
					}
				}
				history.settleInput(committedStep);
				while (run === generation) {
					const changeCount = draftChangeCount.current;
					const saved = await bridge.call<{ markup: string }>("code/open", { ref });
					if (run !== generation) return false;
					// A peer may change the Draft after the server prints it but before this response arrives.
					if (draftChangeCount.current !== changeCount) continue;
					setError("");
					pending?.cancel();
					pending = null;
					typing.current = false;
					bridge.changed(ref, saved.markup);
					return true;
				}
				return false;
			} catch (failure) {
				setError(t(errorMessage(failure)));
				return false;
			}
		};
		let committing: { generation: number; promise: Promise<boolean> } | null = null;
		const commit = async (): Promise<boolean> => {
			clearTimeout(timer);
			if (committing) {
				if (committing.generation === generation) return committing.promise;
				await committing.promise;
				return commit();
			}
			const promise = performCommit();
			committing = { generation, promise };
			try {
				return await promise;
			} finally {
				committing = null;
			}
		};
		const sourceChanged = () => {
			history.boundary();
			previousText = area.value;
			generation++;
			clearTimeout(timer);
			pending?.cancel();
			pending = null;
			pendingRef = undefined;
			typing.current = false;
		};
		const input = () => {
			const { source, ref } = begin();
			if (source) {
				const resource = `input:${resourceOf(source)}`;
				step = history.record({
					resource,
					before: previousText,
					after: area.value,
					label: t("editorHistory.html", { name: source.name ?? source.ref }),
					location: {
						siteId: source.siteId,
						draft: resourceOf(source),
						title: document.title,
						ref,
						panel: "html",
						selection: selectedNow.current?.split("#")[1],
					},
					group: resource,
				});
				history.register(resource, {
					reverse: async (from, to) => {
						const before = area.value;
						let after: string;
						try {
							after = reverseChange(from, to, before) as string;
						} catch {
							return { ok: false, code: "HISTORY_OBSOLETE" };
						}
						sourceChanged();
						previousText = after;
						bridge.changed(source.ref, after);
						return { ok: true, before, after };
					},
				});
			}
			previousText = area.value;
			typing.current = true;
			generation++;
			clearTimeout(timer);
			timer = setTimeout(() => void commit(), 350);
		};
		commands.save = commit;
		area.addEventListener("input", input);
		area.addEventListener("editor-source", sourceChanged);
		return () => {
			generation++;
			clearTimeout(timer);
			pending?.cancel();
			area.removeEventListener("input", input);
			area.removeEventListener("editor-source", sourceChanged);
		};
	}, [bridge, update, load, t, commands, history, setError]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: registration is held in a ref; its status version drives readiness.
	useEffect(() => {
		for (const source of Object.values(sources)) {
			const id = source.opened.component?.id ?? source.opened.template?.id;
			bridge.ready(source.ref, source.editable && (!id || !!connections.current.get(id)?.writable));
		}
	}, [sources, bridge, connectionVersion]);
	const source = active ? sources[active] : undefined;
	const counts = loopCounts(document.body);
	const forest: LayerSource[] = Object.values(sources).map((each) => ({
		ref: each.ref,
		tree: each.opened.tree,
		catalogue: each.opened.catalogue,
		label:
			each.target.kind === "component"
				? t("builder.layers.componentSource", { name: each.name ?? "" })
				: each.ref === "site"
					? t("builder.layers.pageTemplate")
					: (each.opened.postType?.name ?? ""),
		pages: each.opened.usage?.pages,
		counts,
	}));
	const pageLayout = sources.site?.pageLayout;
	if (pageLayout && sources.site)
		forest.push({
			ref: "layout",
			tree: { version: 1, nodes: [] },
			catalogue: sources.site.opened.catalogue,
			label: t("builder.layers.pageLayout", { name: pageLayout.title }),
		});
	return (
		<>
			{error ? <p>{error}</p> : null}
			{unique.map((each) => (
				<DraftConnection
					key={each.opened.component?.id ?? each.opened.template?.id}
					source={each}
					register={(shared) =>
						connections.current.set((each.opened.component?.id ?? each.opened.template?.id) as string, shared)
					}
					onStatus={() => connectionChanged((n) => n + 1)}
					onRefused={(failure) => setError(t(errorMessage(failure)), "interrupt")}
					onRemote={(tree, props) => receive(each.ref, tree, props)}
					onSettled={() => {
						const id = each.opened.component?.id ?? each.opened.template?.id;
						const shared = id ? connections.current.get(id) : undefined;
						const draft = shared?.draft();
						if (draft) {
							const tree = (each.opened.component ? (draft as { tree: Json }).tree : draft) as unknown as ElementTree;
							receive(
								each.ref,
								tree,
								each.opened.component ? (draft as unknown as { props: Opened["props"] }).props : null,
							);
						}
						const refs = each.opened.component ? Object.keys(sourcesRef.current) : [each.ref];
						void Promise.all(refs.map(load)).catch((failure) => setError(t(errorMessage(failure))));
					}}
				/>
			))}
			{source ? (
				<SourcePanels
					menuOpener={menuOpener}
					oneOffDeparture={oneOffDeparture}
					cssDeparture={cssDeparture}
					bridge={bridge}
					source={source}
					designVersion={designVersion}
					reload={async () => {
						await load(source.ref);
					}}
					remoteRevision={
						remoteRevisions.current.get(source.opened.component?.id ?? source.opened.template?.id ?? source.ref) ?? 0
					}
					creating={creating}
					onCreate={async (tree, message, selectedKey) => {
						setCreating(true);
						try {
							const printed = await bridge.call<{ markup: string }>("code/editorMarkup", {
								ref: source.ref,
								draft: { tree },
							});
							const saved = await bridge.call<{ history: { resource: string; before: Json; after: Json }[] }>(
								"code/save",
								{
									ref: source.ref,
									markup: printed.markup,
									version: source.opened.version,
								},
							);
							await history.compound(message.replace(/\.$/, ""), async (step) => {
								for (const change of saved.history)
									history.record({
										...change,
										step,
										label: message,
										location: {
											siteId: source.siteId,
											draft: saved.history.at(-1)?.resource,
											ref: source.ref,
											selection: selectedKey,
											panel: "tree",
											title: document.title,
										},
									});
							});
							await load(source.ref);
						} catch (failure) {
							setError(t(errorMessage(failure)));
							await load(source.ref);
						} finally {
							setCreating(false);
						}
					}}
					selected={selected}
					forest={forest}
					hovered={hovered}
					requested={requested?.ref === source.ref ? requested.selection : null}
					onHidden={(path, hidden, ref = source.ref) => {
						const owner = sources[ref];
						const shared =
							owner && connections.current.get((owner.opened.component?.id ?? owner.opened.template?.id) as string);
						if (!owner || !shared) return false;
						let updated = false;
						const before = shared.draft();
						const changed = shared.change((current) => {
							const tree = (owner.opened.component
								? (current as { tree: Json }).tree
								: current) as unknown as ElementTree;
							const node = nodeAt(tree, path);
							if (node?.type !== "component" || node.hidden === hidden) return current;
							updated = true;
							const next = replaceAt(tree, path, { ...node, hidden });
							update(ref, next);
							paint(ref, next);
							return owner.opened.component
								? { ...(current as Record<string, Json>), tree: next as unknown as Json }
								: (next as unknown as Json);
						});
						if (changed && updated)
							history.record({
								resource: `draft:${owner.siteId}:${owner.opened.component ? "component" : "template"}:${owner.opened.component?.id ?? owner.opened.template?.id}`,
								before,
								after: shared.draft(),
								label: t("builder.inspector.changed"),
								location: {
									siteId: owner.siteId,
									title: document.title,
									ref,
									panel: "inspector",
									inspectorTab: "builder-style",
									selection: selectionKey(owner.opened.tree, { kind: "node", path }),
								},
							});
						if (changed && updated)
							void shared.flush().then((saved) => {
								if (saved) bridge.refresh();
							});
						return changed && updated;
					}}
					shared={connections.current.get((source.opened.component?.id ?? source.opened.template?.id) as string)}
					onTree={(tree) => {
						update(source.ref, tree);
						paint(source.ref, tree);
					}}
					onSourceSelect={(ref, selection) => {
						const target = sources[ref];
						const node = selection.kind === "node" && target ? nodeAt(target.opened.tree, selection.path) : null;
						requestSelection({ ref, selection });
						setActive(ref);
						bridge.select(
							node?.type === "component"
								? `${ref}/${node.id}`
								: target
									? `${ref}#${selectionKey(target.opened.tree, selection)}`
									: ref,
							node?.type === "component" ? `${ref}#${node.id}` : undefined,
						);
					}}
				/>
			) : null}
		</>
	);
}

/** The CSS panel's way to the Design system's Draft on Code mode's canvas: its Edit mode endpoint. */
function useCssPort(bridge: LivePanelBridge): CssPanelPort {
	const t = useT();
	const port = useRef<CssPanelPort | null>(null);
	port.current ??= {
		read: (classes) => bridge.call("code/css", { ref: null, classes }),
		save: (target, text, version) => bridge.call("code/saveCss", { target, text, version }),
		...classHistoryPort({
			create: (name) => bridge.call<ClassReceipt>("code/createClass", { name }),
			rename: (classId, name) =>
				bridge.call<ClassReceipt>("code/editorService", { method: "classes.update", input: { classId, name } }),
			location: () => ({ siteId: editorHistory().siteId, title: document.title, panel: "css" }),
			label: (action, name) => t(`builder.css.${action}`, { name }),
		}),
		preview: (change) => bridge.previewCss?.(change),
	};
	return port.current;
}

function DraftConnection({
	source,
	register,
	onRemote,
	onSettled,
	onStatus,
	onRefused,
}: {
	source: PanelSource;
	register(shared: SharedDraft): void;
	onRemote(tree: ElementTree, props?: Opened["props"]): void;
	onSettled(): void;
	onStatus(): void;
	onRefused(failure: unknown): void;
}) {
	const kind = source.opened.component ? "component" : "template";
	const shared = useSharedDraft({
		path: `/_webcraft/edit/drafts/${kind}/${source.opened.component?.id ?? source.opened.template?.id}`,
		token: document.querySelector('meta[name="webcraft-edit-token"]')?.getAttribute("content") ?? "",
		onRemote: (draft) =>
			onRemote(
				(kind === "component" ? (draft as { tree: Json }).tree : draft) as unknown as ElementTree,
				kind === "component" ? (draft as unknown as { props: Opened["props"] }).props : null,
			),
		onSettled,
		onRefused,
	});
	register(shared);
	const history = editorHistory();
	const key = `draft:${source.siteId}:${kind}:${source.opened.component?.id ?? source.opened.template?.id}`;
	useEffect(
		() =>
			history.register(key, {
				reverse: shared.reverse,
			}),
		[history, key, shared.reverse],
	);
	const statusChanged = useRef(onStatus);
	statusChanged.current = onStatus;
	// biome-ignore lint/correctness/useExhaustiveDependencies: notify the parent when the registered connection changes state.
	useEffect(() => {
		statusChanged.current();
	}, [shared.status, shared.writable]);
	return null;
}

function SourcePanels({
	menuOpener,
	bridge,
	source,
	reload,
	remoteRevision,
	selected,
	forest,
	hovered,
	shared,
	onTree,
	onSourceSelect,
	onHidden,
	requested,
	creating,
	onCreate,
	designVersion,
	oneOffDeparture,
	cssDeparture,
}: {
	menuOpener: { current: ((tab: CommandTab) => void) | null };
	oneOffDeparture: { current: (() => Promise<boolean>) | null };
	cssDeparture: { current: (() => Promise<boolean>) | null };
	bridge: LivePanelBridge;
	source: PanelSource;
	designVersion: number;
	reload(): Promise<void>;
	remoteRevision: number;
	forest: LayerSource[];
	hovered: string | null;
	shared?: SharedDraft;
	onTree(tree: ElementTree): void;
	onSourceSelect(ref: string, selection: Selection): void;
	onHidden(path: NodePath, hidden: boolean, ref?: string): boolean;
	requested: Selection | null;
	creating: boolean;
	onCreate(tree: ElementTree, message: string, selection: string | null): Promise<void>;
	selected: string | null;
}) {
	const t = useT();
	const tree = source.opened.tree;
	const [choice, setChoice] = useState<{ ref: string; requested: Selection | null; selection: Selection | null }>({
		ref: source.ref,
		requested,
		selection: requested,
	});
	// A source switch must expose its selection in this render, before Layers moves keyboard focus.
	const selection =
		choice.ref === source.ref && choice.requested === requested
			? choice.selection
			: (requested ??
				(selected?.split("#")[0] === source.ref ? selectionOf(tree, selected.split("#")[1] ?? "") : null));
	const setSelection = useCallback(
		(selection: Selection | null) => setChoice({ ref: source.ref, requested, selection }),
		[source.ref, requested],
	);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		if (!requested) return;
		setCollapsed(new Set());
		requestAnimationFrame(() =>
			bridge.root.querySelector('[role="treeitem"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
		);
	}, [requested, bridge]);
	const [, announce] = useEditorAnnouncement();
	useEffect(() => {
		const ref = bridge.initialFocus;
		if (!ref || selected !== ref || !selection || `${source.ref}#${selectionKey(tree, selection)}` !== ref) return;
		bridge.initialFocus = null;
		setFocusRows((count) => count + 1);
	}, [bridge, selected, selection, source.ref, tree]);
	const [where, setWhere] = useState<InsertWhere>("inside");
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [menuData, setMenuData] = useState<CommandMenuData | null>(null);
	const [focusRows, setFocusRows] = useState(0);
	const [renameRequest, setRenameRequest] = useState(0);
	const [siteCssRequest, setSiteCssRequest] = useState(0);
	const clipboard = useRef<LayerClipboard | null>(null);
	const [grabbed, setGrabbed] = useState<{
		tree: ElementTree;
		selection: Selection | null;
		source: string;
		remoteRevision: number;
		before?: Json;
		complete?(): void;
	} | null>(null);
	const finishGrab = useCallback(() => {
		const complete = grabbed?.complete;
		if (grabbed) grabbed.complete = undefined;
		complete?.();
		setGrabbed(null);
	}, [grabbed]);
	useEffect(() => editorHistory().listen({ finish: finishGrab }), [finishGrab]);
	const sourceId = source.opened.component?.id ?? source.opened.template?.id ?? source.ref;
	const currentSource = useRef(sourceId);
	currentSource.current = sourceId;
	const grabCurrent = grabbed?.source === sourceId && grabbed.remoteRevision === remoteRevision;
	const [catalogue, setCatalogue] = useState(source.opened.catalogue);
	const [fixed, setFixed] = useState<{ location: FixedTextLocation; source: string } | null>(null);
	const fixedTrigger = useRef<HTMLElement | null>(null);
	/** Make Component's or New Component's name prompt (#134), and where its Component goes. */
	const [componentPrompt, setComponentPrompt] = useState<
		(ComponentPrompt & { path?: NodePath; place?: { path: NodePath; list: readonly TreeNode[] } }) | null
	>(null);
	/** Bind to Prop (#134): the link or image setting being bound, and what it holds now. */
	const [bind, setBind] = useState<{ path: NodePath; kind: BindKind; current: string; source: string } | null>(null);
	const bindTrigger = useRef<HTMLElement | null>(null);
	const fixedAction =
		source.target.kind === "component" ? "prop" : source.target.kind === "entryTemplate" ? "field" : "global";
	const kind = source.opened.component ? "component" : "template";
	useEffect(() => {
		if (grabbed && !grabCurrent) {
			finishGrab();
			announce(t("builder.moves.cancelUnavailable"));
		}
	}, [grabbed, grabCurrent, announce, t, finishGrab]);
	useEffect(() => {
		setCatalogue(source.opened.catalogue);
	}, [source.opened.catalogue]);
	const selectedHistoryKey = selection ? selectionKey(tree, selection) : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new selection ends a typing group.
	useEffect(() => {
		editorHistory().boundary();
	}, [selectedHistoryKey]);
	const selectedId = useRef<string | null>(null);
	useEffect(() => {
		selectedId.current = selected?.split("#")[1] ?? null;
	}, [selected]);
	useEffect(() => {
		const id = selectedId.current;
		if (selected?.split("#")[0] !== source.ref) return;
		setSelection(id ? selectionOf(tree, id) : null);
	}, [selected, tree, source.ref, setSelection]);
	const apply = (
		next: ElementTree,
		nextSelection: Selection | null = selection,
		message = t("builder.inspector.changed"),
		finish = false,
		step?: number,
		panel: HistoryLocation["panel"] = "tree",
	) => {
		const problem = treeProblem(next, { elements: new Set(catalogue.elements), commands: new Set(catalogue.commands) });
		const refusal = problem?.message ?? (!source.editable || creating ? t("coEditing.status.readOnly") : null);
		if (refusal) {
			announce(refusal, "interrupt");
			return refusal;
		}
		const before = shared?.draft() ?? null;
		const changed = shared?.change((current) =>
			kind === "component"
				? { ...(current as Record<string, Json>), tree: next as unknown as Json }
				: (next as unknown as Json),
		);
		const created = !shared && !source.opened.template && !source.opened.component;
		if (!created && !changed) {
			const message = t("coEditing.status.connecting");
			announce(message, "interrupt");
			return message;
		}
		if (shared && changed) {
			const change = {
				step,
				resource: `draft:${source.siteId}:${kind}:${sourceId}`,
				before,
				after: shared.draft(),
				label: message.replace(/\.$/, ""),
				location: {
					siteId: source.siteId,
					draft: `draft:${source.siteId}:${kind}:${sourceId}`,
					inspectorTab: inspectorHistoryTab(),
					ref: source.ref,
					selection:
						selection && selectionKey(tree, selection) && !selectionOf(next, selectionKey(tree, selection) ?? "")
							? selectionKey(tree, selection)
							: nextSelection
								? selectionKey(next, nextSelection)
								: null,
					title: document.title,
					panel,
				},
			};
			if (grabbed && grabCurrent && !finish) {
				grabbed.before ??= before;
				const initial = grabbed.before;
				grabbed.complete = () => {
					editorHistory().record({ ...change, before: initial });
				};
			} else {
				editorHistory().record({ ...change, before: grabCurrent && finish ? (grabbed?.before ?? before) : before });
				if (grabbed) grabbed.complete = undefined;
			}
		}
		setSelection(nextSelection);
		const selectedNode = nextSelection?.kind === "node" ? nodeAt(next, nextSelection.path) : null;
		selectedId.current = nextSelection ? selectionKey(next, nextSelection) : null;
		announce(message);
		onTree(next);
		const id = selectedId.current;
		void (
			created ? onCreate(next, message, id).then(() => true) : shared ? shared.flush() : Promise.resolve(false)
		).then((saved) => {
			if (saved) bridge.refresh();
			if (saved && currentSource.current === sourceId && id === selectedId.current) {
				bridge.select(
					selectedNode?.type === "component" ? `${source.ref}/${id}` : id ? `${source.ref}#${id}` : source.ref,
					selectedNode?.type === "component" ? `${source.ref}#${id}` : undefined,
				);
			}
		});
		return undefined;
	};
	const select = (next: Selection) => {
		editorHistory().boundary();
		setSelection(next);
		const node = next.kind === "node" ? nodeAt(tree, next.path) : undefined;
		const key = selectionKey(tree, next);
		selectedId.current = key;
		if (node && "id" in node) shared?.place(node.id);
		if (key)
			bridge.select(
				node?.type === "component" ? `${source.ref}/${node.id}` : `${source.ref}#${key}`,
				node?.type === "component" ? `${source.ref}#${node.id}` : undefined,
			);
	};

	const insert = (nodes: TreeNode[], way: InsertWhere = where) => {
		const at = insertionPlace(tree, selection, way);
		const made = insertAt(tree, at, nodes);
		const node = nodeAt(made.tree, made.path);
		const refusal = apply(
			made.tree,
			{ kind: "node", path: made.path },
			t("builder.moves.inserted", {
				name: node ? layerName(t, node, catalogue).name : "",
				where: layerLocation(t, made.tree, made.path, catalogue),
			}),
		);
		if (!refusal) setFocusRows((count) => count + 1);
		return refusal;
	};
	const action = (action: LayerAction) => {
		const result = runLayerAction(
			action,
			{ doc: { tree, styles: {}, props: null }, selection, clipboard: clipboard.current, catalogue },
			t,
		);
		if (!result) return;
		if (result.clipboard) clipboard.current = result.clipboard;
		if (result.change) {
			if (!apply(result.change.doc.tree, result.change.selection, result.message)) setFocusRows((count) => count + 1);
		} else announce(result.message, result.refused ? "interrupt" : "polite");
	};

	const previewRun = useRef(0);
	const previewInsertion = async (show: boolean) => {
		const run = ++previewRun.current;
		if (!show) {
			bridge.insertPreview(null, where);
			return;
		}
		const at = insertionPlace(tree, selection, where);
		const marker = `wc-insertion-${crypto.randomUUID()}`;
		const marked = insertAt(tree, at, [{ type: "comment", text: marker }]);
		try {
			const printed = await bridge.call<{ markup: string }>("code/editorMarkup", {
				ref: source.ref,
				draft: { tree: marked.tree, ...(source.opened.props ? { props: source.opened.props } : {}) },
			});
			if (run !== previewRun.current) return;
			const comment = `<!--${marker}-->`;
			const offset = printed.markup.indexOf(comment);
			if (offset < 0) return;
			const lastAnchor = (nodes: readonly TreeNode[]): string | null => {
				for (const node of [...nodes].reverse()) {
					if ("id" in node) return node.id;
					for (const list of childLists(node)) {
						const found = lastAnchor(list);
						if (found) return found;
					}
				}
				return null;
			};
			const selected = selection?.kind === "node" ? nodeAt(tree, selection.path) : null;
			const owner = at.owner ? nodeAt(tree, at.owner) : null;
			const anchor =
				selected && "id" in selected
					? selected.id
					: ((selected ? lastAnchor(childLists(selected).flat()) : null) ??
						(owner && "id" in owner ? owner.id : lastAnchor(tree.nodes)));
			bridge.insertPreview(
				anchor ? `${source.ref}#${anchor}` : source.ref,
				selected && !canHoldChildren(selected) ? "after" : where,
				{
					ref: source.ref,
					markup: printed.markup.replace(comment, ""),
					offset,
					label: forest.find((each) => each.ref === source.ref)?.label ?? "",
				},
			);
		} catch (failure) {
			announce(t(errorMessage(failure)));
		}
	};
	const node = selection?.kind === "node" ? nodeAt(tree, selection.path) : null;
	const cssPort = useCssPort(bridge);

	// ---------------------------------------------------------------------------------------------
	// The Command menu (#131): the same commands as the Builder's, for Code mode's canvas

	const commands = bridge.commands;
	const [, historyChanged] = useState(0);
	useEffect(() => editorHistory().subscribe(() => historyChanged((version) => version + 1)), []);
	// The menu's data loads when Actions or Go to first opens (Insert needs only `structure.edit`, which
	// opening the editor already proved); Go to reads its lists again each time it opens.
	const menuTab = menu?.tab;
	const menuLoaded = useRef(false);
	useEffect(() => {
		if (!menuTab || menuTab === "insert" || (menuLoaded.current && menuTab !== "goTo")) return;
		menuLoaded.current = true;
		// The newest answer wins; switching tabs never drops a read in flight.
		bridge
			.call<CommandMenuData>("code/commandMenu", {})
			.then(setMenuData)
			.catch((failure) => announce(t(errorMessage(failure))));
	}, [bridge, menuTab, announce, t]);
	/** `can()`'s answer for the Site, from the server; Code mode already needed `structure.edit`. */
	const can = useCallback(
		(permission: Permission) =>
			menuData ? (menuData.permissions as readonly Permission[]).includes(permission) : permission === "structure.edit",
		[menuData],
	);
	const editComponent =
		node?.type === "component"
			? () => {
					const component = forest.find((each) => each.ref === `${source.ref}/${node.id}`);
					const first = component?.tree.nodes.find((each) => "id" in each);
					bridge.select(first && "id" in first ? `${source.ref}/${node.id}#${first.id}` : `${source.ref}/${node.id}`);
				}
			: undefined;
	const nameIn = (at: ElementTree, path: NodePath) => {
		const found = nodeAt(at, path);
		return found ? layerName(t, found, catalogue).name : "";
	};
	/** Selects a layer of the page, in this source or another, and opens every layer on the way to it. */
	const selectLayer = (ref: string, path: NodePath) => {
		const owner = forest.find((each) => each.ref === ref);
		if (!owner) return;
		const next: Selection = { kind: "node", path };
		if (ref === source.ref) select(next);
		else onSourceSelect(ref, next);
		setCollapsed((before) => {
			const opened = new Set(before);
			for (let length = 1; length < path.length; length += 2) {
				const ownerPath = path.slice(0, length);
				const ownerNode = nodeAt(owner.tree, ownerPath);
				if (ownerNode) opened.delete(`${ref}:${rowKey(ownerNode, ownerPath)}`);
			}
			return opened;
		});
		const found = nodeAt(owner.tree, path);
		if (found) announce(t("builder.selected", { name: layerName(t, found, owner.catalogue).name }));
	};
	const selectParent = () => {
		if (selection?.kind !== "node") return;
		if (selection.path.length > 1) {
			selectLayer(source.ref, selection.path.slice(0, -2));
			return;
		}
		// The top of a Component's tree: its parent is the Placement showing it.
		const cut = source.ref.lastIndexOf("/");
		if (cut > 0) {
			const parentRef = source.ref.slice(0, cut);
			const owner = forest.find((each) => each.ref === parentRef);
			const path = owner && pathOfId(owner.tree, source.ref.slice(cut + 1));
			if (path) {
				selectLayer(parentRef, path);
				return;
			}
		}
		announce(t("builder.commandMenu.noParent", { name: nameIn(tree, selection.path) }), "interrupt");
	};
	const wrapSelected = (wrapper: TreeNode): string | undefined => {
		if (selection?.kind !== "node") return t("builder.moves.refused.gone", { name: "" });
		const name = nameIn(tree, selection.path);
		const wrapped = wrapAt(tree, selection.path, wrapper);
		if ("refused" in wrapped) return t("builder.moves.refused.gone", { name });
		return apply(
			wrapped.tree,
			{ kind: "node", path: wrapped.path },
			t("builder.commandMenu.wrapped", { name, what: layerName(t, wrapper, catalogue).name }),
		);
	};
	const wrap = (kind: WrapKind) => {
		if (kind === "loop" || kind === "condition") {
			setMenu({ tab: "insert", step: { item: kind === "loop" ? "command-loop" : "command-if", mode: "wrap" } });
			return;
		}
		const made = elementBuilder(tree)(kind, [], kind === "a" ? { href: "/" } : {});
		if (!wrapSelected(made)) setFocusRows((count) => count + 1);
	};
	const unwrap = () => {
		if (selection?.kind !== "node") return;
		const name = nameIn(tree, selection.path);
		const result = unwrapAt(tree, selection.path);
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
		else apply(result.tree, { kind: "node", path: result.path }, t("builder.commandMenu.unwrapped", { name }));
	};
	const leaveTo = (url: string) => {
		if (commands) void commands.leaveTo(url);
		else window.location.assign(url);
	};
	/** Whether this source can change now: editable, not being created, and its shared Draft connected and writable. */
	const writable =
		source.editable && !creating && (!(source.opened.template || source.opened.component) || !!shared?.writable);
	/** Selects a Placement made on the server once it is in the shared Draft; its Component's markup then shows. */
	const selectMade = async (made: MadeComponent, openComponent: boolean) => {
		await serverChangeArrived(() => currentDraft(source, shared).tree, made.placement.id);
		if (currentSource.current !== sourceId) return;
		setSelection({ kind: "node", path: made.placement.path });
		selectedId.current = made.placement.id;
		bridge.refresh();
		bridge.select(
			openComponent ? `${source.ref}/${made.placement.id}` : `${source.ref}#${made.placement.id}`,
			`${source.ref}#${made.placement.id}`,
		);
	};
	/** Make Component (#134): the name prompt for the selected element or Placement. */
	const makeComponent =
		writable && (node?.type === "element" || node?.type === "component") && selection?.kind === "node"
			? () => {
					const path = selection.path;
					setComponentPrompt({
						mode: "make",
						node: node as TreeNode,
						name: componentNameFrom(layerName(t, node as TreeNode, catalogue).name),
						path,
					});
				}
			: undefined;
	/** New Component (#134): from the menu it opens in the Builder; from Insert it goes at the insert point. */
	const newComponent = (placed?: "inside" | "after") => {
		if (!placed) return setComponentPrompt({ mode: "new", placed: false });
		const at = insertionPlace(tree, selection, node && !canHoldChildren(node) ? "after" : placed);
		setComponentPrompt({
			mode: "new",
			placed: true,
			place: { path: pathIn(at, at.index), list: listAt(tree, at) },
		});
	};
	const componentChosen = async (choice: { name: string; texts: { index: number; key: string }[] }) => {
		const prompt = componentPrompt;
		if (!prompt) return undefined;
		const history = editorHistory();
		const location: HistoryLocation = {
			siteId: source.siteId,
			ref: source.ref,
			title: source.name ?? document.title,
			selection: selectedHistoryKey,
			panel: "tree",
		};
		try {
			if (shared && !(await shared.flush())) return t(`coEditing.status.${shared.status}`);
			if (prompt.mode === "make" && prompt.path) {
				// The node as the shared Draft has it now: the server refuses it if someone changed it meanwhile.
				const now = nodeAt(currentDraft(source, shared).tree, prompt.path);
				const label = t("editorHistory.makeComponent", { name: choice.name });
				const made = await history.compound(label, async (step) => {
					const made = await bridge.call<MadeComponent>("code/makeComponent", {
						name: choice.name,
						source: source.target,
						path: prompt.path,
						node: now,
						texts: choice.texts,
					});
					recordSourceHistory(history, made.sourceChange, label, location, step);
					return made;
				});
				announce(t("builder.components.made", { name: made.component.name }));
				void selectMade(made, false);
				return undefined;
			}
			if (prompt.mode === "new" && prompt.place) {
				const label = t("editorHistory.createComponent", { name: choice.name });
				const place = prompt.place;
				const made = await history.compound(label, async (step) => {
					const made = await bridge.call<MadeComponent>("code/createComponent", {
						name: choice.name,
						place: { source: source.target, path: place.path, list: place.list },
					});
					recordSourceHistory(history, made.sourceChange, label, location, step);
					return made;
				});
				announce(t("builder.components.created", { name: made.component.name }));
				void selectMade(made, true);
				return undefined;
			}
			const made = await bridge.call<{ component: { id: string; name: string } }>("code/createComponent", {
				name: choice.name,
			});
			announce(t("builder.components.created", { name: made.component.name }));
			// The empty Component has no page yet: its markup opens in the Builder's HTML panel.
			leaveTo(
				new URL(
					`/builder/${source.siteId}/${targetPath({ kind: "component", componentId: made.component.id })}`,
					source.adminOrigin,
				).href,
			);
			return undefined;
		} catch (failure) {
			return componentRefusal(failure, t);
		}
	};
	const go = {
		page: (path: string) => leaveTo(path),
		builder: (next: BuilderTarget) =>
			leaveTo(new URL(`/builder/${source.siteId}/${targetPath(next)}`, source.adminOrigin).href),
		layer: selectLayer,
	};
	/** The Component's Props as its shared Draft has them, for the Props section and Bind to Prop (#134). */
	const componentProps = (source.opened.component ? (currentDraft(source, shared).props ?? []) : null) as
		| FieldInput[]
		| null;
	/** Writes the Component's Props (the HTML panel's `{{@props}}` block follows); answers why not. */
	const changeProps = (input: FieldInput[], message: string, tree?: ElementTree): string | undefined => {
		if (!writable) return t("coEditing.status.readOnly");
		const props = identifyNewProps(input);
		const before = shared?.draft() ?? null;
		const changed = shared?.change((current) => ({
			...(current as Record<string, Json>),
			props: props as unknown as Json,
			...(tree ? { tree: tree as unknown as Json } : {}),
		}));
		if (!changed) {
			const problem = t(`coEditing.status.${shared?.status ?? "connecting"}`);
			announce(problem);
			return problem;
		}
		editorHistory().record({
			resource: `draft:${source.siteId}:${kind}:${sourceId}`,
			before,
			after: shared?.draft() ?? null,
			label: message,
			location: {
				siteId: source.siteId,
				draft: `draft:${source.siteId}:${kind}:${sourceId}`,
				ref: source.ref,
				selection: selectedHistoryKey,
				panel: "inspector",
				inspectorTab: inspectorHistoryTab(),
				title: source.name ?? document.title,
			},
		});
		onTree(currentDraft(source, shared).tree);
		announce(message);
		void shared?.flush().then((saved) => {
			if (saved) bridge.refresh();
		});
		return undefined;
	};
	/** Bind to Prop: the setting's attribute now reads the Prop, and a new Prop is declared in the same change. */
	const bound = (made: Bound): string | undefined => {
		if (!bind || bind.source !== sourceId) return t("builder.fixedText.changed");
		const current = currentDraft(source, shared).tree;
		const element = nodeAt(current, bind.path);
		if (element?.type !== "element") return t("builder.fixedText.changed");
		const name = bind.kind === "link" ? "href" : "src";
		const value = [{ type: "value" as const, path: made.path }];
		const attributes = element.attributes.some((each) => each.name === name)
			? element.attributes.map((each) => (each.name === name ? { name, value } : each))
			: [...element.attributes, { name, value }];
		const next = replaceAt(current, bind.path, { ...element, attributes });
		const message = t("builder.bind.done", { binding: `{{ ${made.path} }}` });
		if (made.props) return changeProps(made.props, message, next);
		return apply(next, { kind: "node", path: bind.path }, message, false, undefined, "inspector");
	};
	const commandTarget: EditorCommandTarget = {
		canvas: "code",
		selection: node
			? {
					kind: node.type === "element" ? "element" : node.type === "component" ? "placement" : "other",
					name: layerName(t, node, catalogue).name,
					hidden: node.type === "component" ? !!node.hidden : undefined,
					canUnwrap: canUnwrap(node),
				}
			: null,
		history: historyCommandTarget(editorHistory()),
		save: () => commands?.save(),
		publish: () => commands?.bar("publish"),
		...(commands
			? {
					switchCanvas: commands.openBuilder,
					openPageScript: commands.openPageScript,
					safeMode: { on: commands.safeMode, set: () => commands.bar("safeMode") },
					preview: () => commands.bar("preview"),
					leave: () => commands.bar("leave"),
				}
			: {}),
		openSiteCss: () => {
			commands?.showPanels();
			setSiteCssRequest((count) => count + 1);
		},
		layer: (change) =>
			change === "parent"
				? selectParent()
				: change === "rename"
					? setRenameRequest((count) => count + 1)
					: action(change),
		wrap,
		unwrap,
		...(makeComponent ? { makeComponent } : {}),
		...(writable ? { newComponent: () => newComponent() } : {}),
		...(node?.type === "component"
			? {
					editComponent,
					toggleHidden: () => {
						if (selection?.kind === "node" && onHidden(selection.path, !node.hidden))
							announce(t("builder.inspector.changed"));
					},
				}
			: {}),
	};
	// Code mode's own toolbar button opens the menu (it lives in Code mode's top line, not here).
	menuOpener.current = (tab) => setMenu({ tab });
	useEditorKeys({
		enabled: !fixed && !componentPrompt && !bind,
		// Below the smallest width a notice covers the editor: the menu can't be reached.
		blocked: () => document.documentElement.classList.contains("wc-code-covered"),
		menu,
		setMenu,
		openShortcuts: () => setShortcutsOpen(true),
		element: node
			? { duplicate: () => action("duplicate"), delete: () => action("delete"), parent: selectParent }
			: null,
	});

	return (
		<EditorEnvironment value={{ siteMedia: true, adminOrigin: source.adminOrigin }}>
			{bridge.cssHost
				? createPortal(
						<CssPanel
							historyLocation={{
								siteId: source.siteId,
								draft: `draft:${source.siteId}:${source.opened.component ? "component" : "template"}:${sourceId}`,
								title: document.title,
								ref: source.ref,
								selection: selected?.split("#")[1],
								panel: "css",
							}}
							departure={cssDeparture}
							onEdit={bridge.edited}
							port={cssPort}
							element={node?.type === "element" ? { id: node.id, classes: node.classes } : null}
							catalogue={catalogue}
							editable={writable}
							fromModule={!source.editable}
							designVersion={designVersion}
							showSiteCss={siteCssRequest}
							onClasses={(classes, message, step) => {
								// The class list changes in the element's current shared document, as the Inspector's does.
								if (selection?.kind !== "node" || node?.type !== "element") return t("coEditing.status.readOnly");
								return apply(
									replaceAt(tree, selection.path, { ...node, classes }),
									selection,
									message,
									false,
									step,
									"css",
								);
							}}
							refreshCatalogue={async () => {
								// The same refresh as the Inspector's: through the source's owner, in request order.
								await reload();
								bridge.refresh();
							}}
						/>,
						bridge.cssHost,
					)
				: null}
			<aside
				data-editor-region="tree"
				id="wc-code-layers"
				tabIndex={-1}
				className="editor-left"
				aria-label={t("builder.layers.heading")}
			>
				<fieldset disabled={!writable}>
					<InsertToolbar
						where={node && !canHoldChildren(node) ? "after" : where}
						canInside={!!node && canHoldChildren(node)}
						onWhere={setWhere}
						onPick={(item) => {
							if (item === null) return setMenu({ tab: "insert" });
							if (item === "components") return setMenu({ tab: "insert", only: "components" });
							const found = insertItems(t, tree, catalogue).find((each) => each.id === item);
							if (!found) return;
							const nodes = insertNow(found, tree, catalogue);
							if (!nodes) setMenu({ tab: "insert", step: { item, mode: "insert" } });
							else if (!insert(nodes)) setFocusRows((count) => count + 1);
						}}
						onPreview={(show) => void previewInsertion(show)}
					/>
					<LayersPanel
						onHidden={(path, hidden, ref) => {
							if (onHidden(path, hidden, ref)) announce(t("builder.inspector.changed"));
						}}
						forest={forest}
						activeSource={source.ref}
						hovered={hoveredRow(hovered)}
						onHover={(ref, selection) => {
							const target = forest.find((each) => each.ref === (ref ?? source.ref));
							const key = target && selection ? selectionKey(target.tree, selection) : null;
							bridge.hover(key ? `${ref ?? source.ref}#${key}` : null);
						}}
						onSourceSelect={onSourceSelect}
						tree={tree}
						catalogue={catalogue}
						selection={selection}
						collapsed={collapsed}
						grabbed={grabCurrent}
						canPaste={clipboard.current !== null}
						focusRequest={focusRows}
						renameRequest={renameRequest}
						onSelect={select}
						onToggle={(key, open) =>
							setCollapsed((before) => {
								const next = new Set(before);
								if (open) next.delete(key);
								else next.add(key);
								return next;
							})
						}
						onAction={action}
						onGrab={(change) => {
							if (selection?.kind !== "node" || !node) return;
							const name = layerName(t, node, catalogue).name;
							if (change === "pick") {
								setGrabbed({ tree, selection, source: sourceId, remoteRevision });
								announce(t("builder.moves.picked", { name }));
							} else if (change === "drop") {
								apply(
									tree,
									selection,
									t("builder.moves.dropped", { name, where: layerLocation(t, tree, selection.path, catalogue) }),
									true,
								);
								editorHistory().boundary();
								setGrabbed(null);
								announce(
									t("builder.moves.dropped", { name, where: layerLocation(t, tree, selection.path, catalogue) }),
								);
							} else {
								if (grabbed && grabCurrent)
									apply(grabbed.tree, grabbed.selection, t("builder.moves.putBack", { name }));
								if (grabbed) grabbed.complete = undefined;
								setGrabbed(null);
							}
						}}
						onRename={(path, label) => {
							const node = nodeAt(tree, path);
							if (node?.type === "element")
								apply(
									replaceAt(tree, path, { ...node, label }),
									selection,
									t("builder.layers.renamed", { name: label }),
								);
						}}
						onDrop={(from, to, position) => {
							const moved = moveTo(tree, from, placeBy(tree, to, position));
							const node = nodeAt(tree, from);
							const name = node ? layerName(t, node, catalogue).name : "";
							if ("refused" in moved)
								announce(t(`builder.moves.refused.${moved.refused as "first"}`, { name }), "interrupt");
							else
								apply(
									moved.tree,
									{ kind: "node", path: moved.path },
									t("builder.moves.moved", {
										name,
										where: layerLocation(t, moved.tree, moved.path, catalogue),
									}),
								);
						}}
						onInsert={() => setMenu({ tab: "insert" })}
						onMakeComponent={makeComponent}
						onPlacements={(componentId) => setMenu({ tab: "goTo", placements: componentId })}
					/>
				</fieldset>
			</aside>
			<aside
				data-editor-region="inspector"
				id="wc-code-inspector"
				tabIndex={-1}
				className="editor-right"
				aria-label={t("builder.inspector.heading")}
			>
				<fieldset disabled={!writable}>
					<Inspector
						departure={oneOffDeparture}
						cssInDock
						key={source.opened.component?.id ?? source.ref}
						onEditComponent={editComponent}
						siteId={source.siteId}
						tree={tree}
						selection={selection}
						catalogue={catalogue}
						oneOffOf={(_id, classes) =>
							classes
								.map((id) => catalogue.classes.find((each) => each.id === id && each.generated)?.styles ?? "")
								.filter(Boolean)
								.join(" ")
						}
						fixedTextAction={fixedAction}
						onReplace={(path, node, message) =>
							apply(replaceAt(tree, path, node), selection, message, false, undefined, "inspector")
						}
						onClasses={(path, classes, message) => {
							const node = nodeAt(tree, path);
							if (node?.type === "element")
								apply(replaceAt(tree, path, { ...node, classes }), selection, message, false, undefined, "inspector");
						}}
						onOneOff={async (_path, id, declarations) => {
							try {
								if (!(await shared?.flush())) {
									if (currentSource.current === sourceId)
										announce(t(`coEditing.status.${shared?.status ?? "connecting"}`));
									return false;
								}
								const saved = await saveOneOffStyles(bridge, source.ref, { [id]: declarations }, id);
								const label = declarations ? t("builder.style.oneOffApplied") : t("builder.style.oneOffRemoved");
								await editorHistory().compound(label.replace(/\.$/, ""), async (step) => {
									for (const change of saved.history)
										editorHistory().record({
											...change,
											step,
											label,
											location: {
												siteId: source.siteId,
												draft: saved.history.at(-1)?.resource,
												ref: source.ref,
												selection: id,
												panel: "inspector",
												inspectorTab: "builder-style",
												title: document.title,
											},
										});
								});
								await reload();
								onTree(currentDraft(source, shared).tree);
								if (currentSource.current === sourceId)
									announce(declarations ? t("builder.style.oneOffApplied") : t("builder.style.oneOffRemoved"));
								return true;
							} catch (failure) {
								if (currentSource.current === sourceId) announce(t(errorMessage(failure)));
								return false;
							}
						}}
						refreshCatalogue={async () => {
							await reload();
							bridge.refresh();
						}}
						onMakeEditable={(path, trigger) => {
							fixedTrigger.current = trigger;
							const location = rememberFixedText(currentDraft(source, shared).tree, path);
							if (location) setFixed({ location, source: sourceId });
						}}
						component={componentProps ? { name: source.name ?? "", props: componentProps } : null}
						onPropsChange={(props, message) => changeProps(props, message)}
						onMakeComponent={makeComponent}
						onBindProp={
							componentProps
								? (path, kind, trigger) => {
										bindTrigger.current = trigger;
										const element = nodeAt(currentDraft(source, shared).tree, path);
										const attribute =
											element?.type === "element"
												? element.attributes.find((each) => each.name === (kind === "link" ? "href" : "src"))
												: undefined;
										const current = (attribute?.value ?? [])
											.map((part) => (part.type === "text" ? part.text : ""))
											.join("");
										setBind({ path, kind, current, source: sourceId });
									}
								: undefined
						}
					/>
				</fieldset>
				<p>{t(`coEditing.status.${shared?.status ?? "connecting"}`)}</p>
			</aside>
			{fixed ? (
				<FixedTextDialog
					open
					onOpenChange={(open) => {
						if (!open) setFixed(null);
					}}
					finalFocus={fixedTrigger}
					target={fixedAction}
					text={fixed.location.text}
					siteId={source.siteId}
					postTypeId={"postTypeId" in source.target ? source.target.postTypeId : null}
					props={source.opened.props}
					onMade={(made) => {
						const current = currentDraft(source, shared).tree;
						const path = fixed.source === sourceId && resolveFixedText(current, fixed.location);
						if (!path) return t("builder.fixedText.changed");
						const next = replaceAt(current, path, { type: "value", path: made.path });
						const message = t("builder.fixedText.made", { binding: `{{ ${made.path} }}` });
						if (made.props) {
							const refused = changeProps(made.props, message, next);
							if (refused) return refused;
							setSelection({ kind: "node", path });
							selectedId.current = selectionKey(next, { kind: "node", path });
						} else {
							const refused = apply(next, { kind: "node", path }, message);
							if (refused) return refused;
						}
						setCatalogue((before) => ({
							...before,
							values: [
								...before.values,
								{
									path: made.path,
									label: made.label,
									type: "text",
									group: fixedAction === "prop" ? "props" : fixedAction === "field" ? "entry" : "globals",
								},
							],
						}));
						setFixed(null);
					}}
				/>
			) : null}

			<ComponentDialog prompt={componentPrompt} onClose={() => setComponentPrompt(null)} onSubmit={componentChosen} />
			{bind && componentProps ? (
				<BindPropDialog
					open
					onOpenChange={(open) => {
						if (!open) setBind(null);
					}}
					finalFocus={bindTrigger}
					kind={bind.kind}
					current={bind.current}
					props={componentProps}
					onBound={bound}
				/>
			) : null}
			<CommandMenu
				canvas="code"
				state={menu}
				onState={setMenu}
				can={can}
				actions={editorCommands(commandTarget, t)}
				goTo={
					menu?.tab === "goTo" && menuData
						? goToCommands(
								t,
								menuData,
								forest.filter((each) => each.ref !== "layout"),
								go,
								menu.placements,
							)
						: null
				}
				insert={
					writable
						? {
								siteId: source.siteId,
								tree,
								catalogue,
								where: node && !canHoldChildren(node) ? "after" : where === "inside" ? "inside" : "after",
								canInside: !!node && canHoldChildren(node),
								onWhere: setWhere,
								selected: node ? layerName(t, node, catalogue).name : null,
								onInsert: (nodes, way) => insert(nodes, way),
								onWrap: wrapSelected,
								onPreview: (show) => void previewInsertion(show),
								onNewComponent: (way) => newComponent(way),
							}
						: null
				}
				onRowFocus={() => setFocusRows((count) => count + 1)}
			/>
			<ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} can={can} />
		</EditorEnvironment>
	);
}
