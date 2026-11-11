import { type Json, sameValue } from "@webcraft/core/draft-document";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import { DialogContainer } from "@webcraft/ui/components/dialog.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { type SharedDraft, useSharedDraft } from "../co-editing/shared-draft.ts";
import { useAnnouncement } from "../content/reorder.tsx";
import { errorMessage } from "../errors.ts";
import { AdminIntl, useT } from "../i18n.tsx";
import { CssPanel, type CssPanelPort, type CssTarget } from "./CssPanel.tsx";
import { loopCounts } from "./canvas-metadata.ts";
import { type EditorApi, EditorApiContext, EditorEnvironment } from "./editor-api.tsx";
import { FixedTextDialog } from "./FixedTextDialog.tsx";
import { type FixedTextLocation, rememberFixedText, resolveFixedText } from "./fixed-text.ts";
import { InsertDialog, type InsertWhere } from "./InsertDialog.tsx";
import { InsertToolbar } from "./InsertToolbar.tsx";
import { Inspector } from "./Inspector.tsx";
import { type LayerAction, type LayerSource, LayersPanel } from "./LayersPanel.tsx";
import { type LayerClipboard, runLayerAction } from "./layer-actions.ts";
import type { BuilderTarget, Opened, Selection } from "./model.ts";
import {
	canHoldChildren,
	childLists,
	insertAt,
	insertionPlace,
	moveTo,
	type NodePath,
	nodeAt,
	pathOfId,
	placeBy,
	replaceAt,
	treeProblem,
} from "./tree.ts";

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
	/** Where the CSS panel draws: Code mode's CSS panel, below the page. */
	cssHost?: HTMLElement;
	/** Shows unsaved CSS on the page, or (null) the Draft again. */
	previewCss?(change: { target: CssTarget; text: string } | null): void;
	language: "en" | "it";
	call<T>(action: string, body: object): Promise<T>;
	select(ref: string, inspectorRef?: string): void;
	changed(ref: string, markup: string): void;
	hover(ref: string | null): void;
	ready(ref: string, editable: boolean): void;
	refresh(): void;
	insertPreview(
		ref: string | null,
		where: InsertWhere,
		context?: { ref: string; markup: string; offset: number; label: string },
	): void;
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
	await bridge.call("code/save", { ref, markup, version: opened.version });
}

export function mount(bridge: LivePanelBridge) {
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
	const show = (ref: string | null) => {
		selection = ref;
		react.render(
			<AdminIntl language={bridge.language}>
				<EditorApiContext value={getApi}>
					<DialogContainer value={container}>
						<LivePanels bridge={bridge} selected={selection} hovered={hovered} commands={commands} />
					</DialogContainer>
				</EditorApiContext>
			</AdminIntl>,
		);
	};
	show(null);
	return {
		select: show,
		refresh: () => show(selection),
		save: () => commands.save(),
		markup: (ref: string) => commands.markup(ref),
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
}: {
	bridge: LivePanelBridge;
	selected: string | null;
	hovered: string | null;
	commands: PanelCommands;
}) {
	const t = useT();
	const [sources, setSources] = useState<Record<string, PanelSource>>({});
	const [active, setActive] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [creating, setCreating] = useState(false);
	const [connectionVersion, connectionChanged] = useState(0);
	const [requested, requestSelection] = useState<{ ref: string; selection: Selection } | null>(null);
	const [designVersion, designChanged] = useState(0);
	const connections = useRef(new Map<string, SharedDraft>());
	const loading = useRef(new Set<string>());
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;
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
					if (typing.current || paintRuns.current.get(key) !== run) return;
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
					for (const each of refs) bridge.changed(each, markup);
				})
				.catch((failure) => setError(t(errorMessage(failure))));
		},
		[bridge, t],
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
	}, [selected, load, t]);
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
			const markup = area.value;
			try {
				const read = await bridge.call<{ tree: ElementTree; styles: Record<string, string>; props?: Json | null }>(
					"code/editorRead",
					{ ref, markup },
				);
				if (run !== generation) return false;
				if (!shared) {
					await bridge.call("code/save", { ref, markup, version: source.opened.version });
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
					if (!pending.apply(next, { keep: true })) {
						pending = null;
						setError(t("coEditing.status.readOnly"));
						return false;
					}
					const draft = shared.draft();
					const tree = (source.opened.component ? (draft as { tree: Json }).tree : draft) as unknown as ElementTree;
					update(ref, tree, source.opened.component ? (draft as unknown as { props: Opened["props"] }).props : null);
					if (!(await shared.flush())) return false;
					if (Object.keys(read.styles).length) {
						// Inline styles become generated Classes through the existing validated markup saver.
						await saveOneOffStyles(bridge, ref, read.styles);
						await load(ref);
					}
				}
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
			generation++;
			clearTimeout(timer);
			pending?.cancel();
			pending = null;
			pendingRef = undefined;
			typing.current = false;
		};
		const input = () => {
			begin();
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
	}, [bridge, update, load, t, commands]);
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
			{error ? <p role="alert">{error}</p> : null}
			{unique.map((each) => (
				<DraftConnection
					key={each.opened.component?.id ?? each.opened.template?.id}
					source={each}
					register={(shared) =>
						connections.current.set((each.opened.component?.id ?? each.opened.template?.id) as string, shared)
					}
					onStatus={() => connectionChanged((n) => n + 1)}
					onRefused={(failure) => setError(t(errorMessage(failure)))}
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
					onCreate={async (tree) => {
						setCreating(true);
						try {
							const printed = await bridge.call<{ markup: string }>("code/editorMarkup", {
								ref: source.ref,
								draft: { tree },
							});
							await bridge.call("code/save", {
								ref: source.ref,
								markup: printed.markup,
								version: source.opened.version,
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
							node?.type === "component" ? `${ref}/${node.id}` : node && "id" in node ? `${ref}#${node.id}` : ref,
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
	const port = useRef<CssPanelPort | null>(null);
	port.current ??= {
		read: (classes) => bridge.call("code/css", { ref: null, classes }),
		save: (target, text, version) => bridge.call("code/saveCss", { target, text, version }),
		createClass: async (name) =>
			(await bridge.call<{ class: { id: string; name: string } }>("code/createClass", { name })).class,
		renameClass: async (classId, name) => {
			await bridge.call("code/editorService", { method: "classes.update", input: { classId, name } });
		},
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
	const statusChanged = useRef(onStatus);
	statusChanged.current = onStatus;
	// biome-ignore lint/correctness/useExhaustiveDependencies: notify the parent when the registered connection changes state.
	useEffect(() => {
		statusChanged.current();
	}, [shared.status, shared.writable]);
	return null;
}

function SourcePanels({
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
}: {
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
	onCreate(tree: ElementTree): Promise<void>;
	selected: string | null;
}) {
	const t = useT();
	const [tree, setTree] = useState(source.opened.tree);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [announcement, announce] = useAnnouncement();
	const [inserting, setInserting] = useState(false);
	const [quick, setQuick] = useState<string | null>(null);
	const [where, setWhere] = useState<InsertWhere>("inside");
	const trigger = useRef<HTMLButtonElement>(null);
	const clipboard = useRef<LayerClipboard | null>(null);
	const [grabbed, setGrabbed] = useState<{
		tree: ElementTree;
		selection: Selection | null;
		source: string;
		remoteRevision: number;
	} | null>(null);
	const sourceId = source.opened.component?.id ?? source.opened.template?.id ?? source.ref;
	const currentSource = useRef(sourceId);
	currentSource.current = sourceId;
	const grabCurrent = grabbed?.source === sourceId && grabbed.remoteRevision === remoteRevision;
	const [catalogue, setCatalogue] = useState(source.opened.catalogue);
	const [fixed, setFixed] = useState<{ location: FixedTextLocation; source: string } | null>(null);
	const fixedTrigger = useRef<HTMLElement | null>(null);
	const fixedAction =
		source.target.kind === "component" ? "prop" : source.target.kind === "entryTemplate" ? "field" : "global";
	const kind = source.opened.component ? "component" : "template";
	useEffect(() => {
		if (grabbed && !grabCurrent) {
			setGrabbed(null);
			announce(t("builder.moves.cancelUnavailable"));
		}
	}, [grabbed, grabCurrent, announce, t]);
	useEffect(() => {
		setTree(source.opened.tree);
	}, [source.opened.tree]);
	useEffect(() => {
		setCatalogue(source.opened.catalogue);
	}, [source.opened.catalogue]);
	useEffect(() => {
		if (requested) setSelection(requested);
	}, [requested]);

	const selectedId = useRef<string | null>(null);
	useEffect(() => {
		selectedId.current = selected?.split("#")[1] ?? null;
	}, [selected]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: an external selection and a remote move both reconcile the selected id.
	useEffect(() => {
		const id = selectedId.current;
		const path = id ? pathOfId(tree, id) : undefined;
		if (path) setSelection({ kind: "node", path });
		else if (id) setSelection(null);
	}, [selected, tree]);
	const apply = (
		next: ElementTree,
		nextSelection: Selection | null = selection,
		message = t("builder.inspector.changed"),
	) => {
		const problem = treeProblem(next, { elements: new Set(catalogue.elements), commands: new Set(catalogue.commands) });
		if (problem) return problem.message;
		if (!source.editable || creating) return t("coEditing.status.readOnly");
		const changed = shared?.change((current) =>
			kind === "component"
				? { ...(current as Record<string, Json>), tree: next as unknown as Json }
				: (next as unknown as Json),
		);
		const created = !shared && !source.opened.template && !source.opened.component;
		if (!created && !changed) return t("coEditing.status.connecting");
		setTree(next);
		setSelection(nextSelection);
		const selectedNode = nextSelection?.kind === "node" ? nodeAt(next, nextSelection.path) : null;
		selectedId.current = selectedNode && "id" in selectedNode ? selectedNode.id : null;
		announce(message);
		onTree(next);
		const id = selectedId.current;
		void (created ? onCreate(next).then(() => true) : shared ? shared.flush() : Promise.resolve(false)).then(
			(saved) => {
				if (saved) bridge.refresh();
				if (saved && id === selectedId.current) {
					bridge.select(
						selectedNode?.type === "component" ? `${source.ref}/${id}` : id ? `${source.ref}#${id}` : source.ref,
						selectedNode?.type === "component" ? `${source.ref}#${id}` : undefined,
					);
				}
			},
		);
		return undefined;
	};
	const select = (next: Selection) => {
		setSelection(next);
		const node = next.kind === "node" ? nodeAt(tree, next.path) : undefined;
		if (node && "id" in node) {
			shared?.place(node.id);
			bridge.select(
				node.type === "component" ? `${source.ref}/${node.id}` : `${source.ref}#${node.id}`,
				node.type === "component" ? `${source.ref}#${node.id}` : undefined,
			);
		}
	};

	const insert = (nodes: TreeNode[]) => {
		const at = insertionPlace(tree, selection, where);
		const made = insertAt(tree, at, nodes);
		return apply(made.tree, { kind: "node", path: made.path });
	};
	const action = (action: LayerAction) => {
		const result = runLayerAction(
			action,
			{ doc: { tree, styles: {}, props: null }, selection, clipboard: clipboard.current, catalogue },
			t,
		);
		if (!result) return;
		if (result.clipboard) clipboard.current = result.clipboard;
		if (result.change) apply(result.change.doc.tree, result.change.selection, result.message);
		else announce(result.message);
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
	const writable =
		source.editable && !creating && (!(source.opened.template || source.opened.component) || !!shared?.writable);
	return (
		<EditorEnvironment value={{ siteMedia: true, adminOrigin: source.adminOrigin }}>
			{bridge.cssHost
				? createPortal(
						<CssPanel
							port={cssPort}
							element={node?.type === "element" ? { id: node.id, classes: node.classes } : null}
							catalogue={catalogue}
							editable={writable}
							designVersion={designVersion}
							onClasses={(classes, message) => {
								// The class list changes in the element's current shared document, as the Inspector's does.
								if (selection?.kind !== "node" || node?.type !== "element") return t("coEditing.status.readOnly");
								return apply(replaceAt(tree, selection.path, { ...node, classes }), selection, message);
							}}
							onDesignChanged={({ made, renamed }) => {
								if (made || renamed)
									setCatalogue((before) => ({
										...before,
										classes: made
											? [...before.classes, { id: made.id, name: made.name, generated: false, styles: "" }]
											: before.classes.map((each) =>
													each.id === renamed?.id ? { ...each, name: renamed.name, generated: false } : each,
												),
									}));
								bridge.refresh();
							}}
						/>,
						bridge.cssHost,
					)
				: null}
			<aside className="editor-left" aria-label={t("builder.layers.heading")}>
				<fieldset
					disabled={
						!source.editable || creating || (!!(source.opened.template || source.opened.component) && !shared?.writable)
					}
				>
					<InsertToolbar
						where={node && !canHoldChildren(node) ? "after" : where}
						canInside={!!node && canHoldChildren(node)}
						onWhere={setWhere}
						onPick={(item, button) => {
							setQuick(item);
							trigger.current = button;
							setInserting(true);
						}}
						onPreview={(show) => void previewInsertion(show)}
					/>
					<LayersPanel
						onHidden={(path, hidden, ref) => {
							if (onHidden(path, hidden, ref)) announce(t("builder.inspector.changed"));
						}}
						forest={forest}
						activeSource={source.ref}
						hovered={hovered ? hovered.replace("#", ":#") : null}
						onHover={(ref, selection) => {
							const target = forest.find((each) => each.ref === (ref ?? source.ref));
							const node = target && selection?.kind === "node" ? nodeAt(target.tree, selection.path) : null;
							bridge.hover(node && "id" in node ? `${ref ?? source.ref}#${node.id}` : null);
						}}
						onSourceSelect={onSourceSelect}
						tree={tree}
						catalogue={catalogue}
						selection={selection}
						collapsed={collapsed}
						grabbed={grabCurrent}
						canPaste={clipboard.current !== null}
						focusRequest={0}
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
							if (change === "pick") setGrabbed({ tree, selection, source: sourceId, remoteRevision });
							else {
								if (change === "cancel" && grabbed && grabCurrent) apply(grabbed.tree, grabbed.selection);
								setGrabbed(null);
							}
						}}
						onRename={(path, label) => {
							const node = nodeAt(tree, path);
							if (node?.type === "element") apply(replaceAt(tree, path, { ...node, label }));
						}}
						onDrop={(from, to, position) => {
							const moved = moveTo(tree, from, placeBy(tree, to, position));
							if ("tree" in moved) apply(moved.tree, { kind: "node", path: moved.path });
						}}
						onInsert={() => {
							setQuick(null);
							setInserting(true);
						}}
					/>
				</fieldset>
			</aside>
			<aside className="editor-right" aria-label={t("builder.inspector.heading")}>
				<fieldset
					disabled={
						!source.editable || creating || (!!(source.opened.template || source.opened.component) && !shared?.writable)
					}
				>
					<Inspector
						key={source.opened.component?.id ?? source.ref}
						onEditComponent={
							node?.type === "component"
								? () => {
										const component = forest.find((each) => each.ref === `${source.ref}/${node.id}`);
										const first = component?.tree.nodes.find((each) => "id" in each);
										bridge.select(
											first && "id" in first ? `${source.ref}/${node.id}#${first.id}` : `${source.ref}/${node.id}`,
										);
									}
								: undefined
						}
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
						onReplace={(path, node, message) => apply(replaceAt(tree, path, node), selection, message)}
						onClasses={(path, classes, message) => {
							const node = nodeAt(tree, path);
							if (node?.type === "element") apply(replaceAt(tree, path, { ...node, classes }), selection, message);
						}}
						onOneOff={async (_path, id, declarations) => {
							try {
								if (!(await shared?.flush())) {
									if (currentSource.current === sourceId)
										announce(t(`coEditing.status.${shared?.status ?? "connecting"}`));
									return false;
								}
								await saveOneOffStyles(bridge, source.ref, { [id]: declarations }, id);
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
					/>
				</fieldset>
				<p role="status">{announcement || t(`coEditing.status.${shared?.status ?? "connecting"}`)}</p>
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
							const changed = shared?.change((current) => ({
								...(current as Record<string, Json>),
								props: made.props as unknown as Json,
								tree: next as unknown as Json,
							}));
							if (!changed) {
								const problem = t(`coEditing.status.${shared?.status ?? "connecting"}`);
								announce(problem);
								return problem;
							}
							setTree(next);
							setSelection({ kind: "node", path });
							selectedId.current = null;
							onTree(next);
							announce(message);
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

			<InsertDialog
				quick={quick}
				open={inserting}
				onOpenChange={setInserting}
				finalFocus={trigger}
				siteId={source.siteId}
				tree={tree}
				catalogue={catalogue}
				where={node && !canHoldChildren(node) ? "after" : where}
				onWhere={setWhere}
				canInside={!!node && canHoldChildren(node)}
				hasSelection={!!selection}
				onInsert={insert}
			/>
		</EditorEnvironment>
	);
}
