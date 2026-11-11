import { type Json, sameValue } from "@webcraft/core/draft-document";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import { DialogContainer } from "@webcraft/ui/components/dialog.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type SharedDraft, useSharedDraft } from "../co-editing/shared-draft.ts";
import { errorMessage } from "../errors.ts";
import { AdminIntl, useT } from "../i18n.tsx";
import { loopCounts } from "./canvas-metadata.ts";
import { type EditorApi, EditorApiContext, EditorEnvironment } from "./editor-api.tsx";
import { FixedTextDialog } from "./FixedTextDialog.tsx";
import { InsertDialog, type InsertWhere } from "./InsertDialog.tsx";
import { InsertToolbar } from "./InsertToolbar.tsx";
import { Inspector } from "./Inspector.tsx";
import { type LayerAction, type LayerSource, LayersPanel } from "./LayersPanel.tsx";
import type { BuilderTarget, Opened, Selection } from "./model.ts";
import {
	canHoldChildren,
	childLists,
	insertAt,
	insertionPlace,
	moveDown,
	moveIntoPrevious,
	moveOut,
	moveTo,
	moveUp,
	type NodePath,
	nodeAt,
	pathOfId,
	placeBy,
	removeAt,
	replaceAt,
	treeProblem,
	withNewIds,
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
	const commands = { save: async () => false };
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
	commands: { save(): Promise<boolean> };
}) {
	const t = useT();
	const [sources, setSources] = useState<Record<string, PanelSource>>({});
	const [active, setActive] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [creating, setCreating] = useState(false);
	const [connectionVersion, connectionChanged] = useState(0);
	const [requested, requestSelection] = useState<{ ref: string; selection: Selection } | null>(null);
	const connections = useRef(new Map<string, SharedDraft>());
	const loading = useRef(new Set<string>());
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;
	const typing = useRef(false);
	const paintRuns = useRef(new Map<string, number>());
	const paint = useCallback(
		(ref: string, tree: ElementTree) => {
			const source = sourcesRef.current[ref];
			const id = source?.opened.component?.id ?? source?.opened.template?.id;
			const key = id ?? ref;
			const run = (paintRuns.current.get(key) ?? 0) + 1;
			paintRuns.current.set(key, run);
			const draft = source?.opened.component ? connections.current.get(source.opened.component.id)?.draft() : null;
			const props = (draft as { props?: Opened["props"] } | null)?.props ?? source?.opened.props;
			bridge
				.call<{ markup: string }>("code/editorMarkup", { ref, draft: { tree, ...(props ? { props } : {}) } })
				.then(({ markup }) => {
					if (typing.current || paintRuns.current.get(key) !== run) return;
					const refs = id
						? Object.values(sourcesRef.current)
								.filter((each) => (each.opened.component?.id ?? each.opened.template?.id) === id)
								.map((each) => each.ref)
						: [ref];
					for (const each of refs) bridge.changed(each, markup);
				})
				.catch((failure) => setError(String(failure)));
		},
		[bridge],
	);
	const update = useCallback((ref: string, tree: ElementTree, props?: Opened["props"]) => {
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
			update(ref, tree, props);
			paint(ref, tree);
		},
		[update, paint],
	);
	const load = useCallback(
		async (ref: string | null): Promise<PanelSource> => {
			const source = await bridge.call<PanelSource>("code/editor", { ref });
			setSources((before) => {
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
	useSharedDraft({
		path: "/_webcraft/edit/drafts/designSystem",
		token: document.querySelector('meta[name="webcraft-edit-token"]')?.getAttribute("content") ?? "",
		onRemote() {
			// The initial snapshot is already rendered on the page. Replacing it would steal focus.
			if (designLoaded.current) bridge.refresh();
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
			.catch((failure) => setError(String(failure)));
		return () => {
			current = false;
		};
	}, [selected, load]);
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
					if (!pending.apply(next)) {
						pending = null;
						setError(t("coEditing.status.readOnly"));
						return false;
					}
					pending = null;
					const draft = shared.draft();
					const tree = (source.opened.component ? (draft as { tree: Json }).tree : draft) as unknown as ElementTree;
					update(ref, tree, source.opened.component ? (draft as unknown as { props: Opened["props"] }).props : null);
					if (!(await shared.flush())) return false;
					if (Object.keys(read.styles).length) {
						// Inline styles become generated Classes through the existing validated markup saver.
						// Print the merged document, preserving edits that arrived while the HTML was incomplete.
						const freshDraft = shared.draft();
						const printed = await bridge.call<{ markup: string }>("code/editorMarkup", {
							ref,
							draft: {
								...(source.opened.component ? (freshDraft as object) : { tree: freshDraft }),
								styles: read.styles,
							},
						});
						const current = await bridge.call<{ version: string | null }>("code/open", { ref });
						await bridge.call("code/save", { ref, markup: printed.markup, version: current.version });
						await load(ref);
					}
				}
				if (run !== generation) return false;
				typing.current = false;
				setError("");
				const saved = await bridge.call<{ markup: string }>("code/open", { ref });
				if (run === generation) bridge.changed(ref, saved.markup);
				return true;
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
						if (!owner || !shared) return;
						const changed = shared.change((current) => {
							const tree = (owner.opened.component
								? (current as { tree: Json }).tree
								: current) as unknown as ElementTree;
							const node = nodeAt(tree, path);
							if (node?.type !== "component") return current;
							const next = replaceAt(tree, path, { ...node, hidden });
							update(ref, next);
							paint(ref, next);
							return owner.opened.component
								? { ...(current as Record<string, Json>), tree: next as unknown as Json }
								: (next as unknown as Json);
						});
						if (changed)
							void shared.flush().then((saved) => {
								if (saved) bridge.refresh();
							});
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
}: {
	bridge: LivePanelBridge;
	source: PanelSource;
	forest: LayerSource[];
	hovered: string | null;
	shared?: SharedDraft;
	onTree(tree: ElementTree): void;
	onSourceSelect(ref: string, selection: Selection): void;
	onHidden(path: NodePath, hidden: boolean, ref?: string): void;
	requested: Selection | null;
	creating: boolean;
	onCreate(tree: ElementTree): Promise<void>;
	selected: string | null;
}) {
	const t = useT();
	const [tree, setTree] = useState(source.opened.tree);
	const treeRef = useRef(tree);
	treeRef.current = tree;
	const [selection, setSelection] = useState<Selection | null>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [announcement, announce] = useState("");
	const [inserting, setInserting] = useState(false);
	const [quick, setQuick] = useState<string | null>(null);
	const [where, setWhere] = useState<InsertWhere>("inside");
	const trigger = useRef<HTMLButtonElement>(null);
	const clipboard = useRef<TreeNode[]>([]);
	const [grabbed, setGrabbed] = useState<ElementTree | null>(null);
	const [catalogue, setCatalogue] = useState(source.opened.catalogue);
	const [fixed, setFixed] = useState<NodePath | null>(null);
	const fixedTrigger = useRef<HTMLElement | null>(null);
	const fixedAction =
		source.target.kind === "component" ? "prop" : source.target.kind === "entryTemplate" ? "field" : "global";
	const kind = source.opened.component ? "component" : "template";
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
		treeRef.current = next;
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
		if (selection?.kind !== "node") return;
		const path = selection.path;
		const node = nodeAt(tree, path);
		if (!node) return;
		if (action === "copy" || action === "cut") clipboard.current = [node];
		if (action === "delete" || action === "cut") {
			apply(removeAt(tree, path), null);
			return;
		}
		if (action === "duplicate" || action === "paste") {
			const made = insertAt(
				tree,
				placeBy(tree, path, "after"),
				withNewIds(tree, action === "duplicate" ? [node] : clipboard.current),
			);
			apply(made.tree, { kind: "node", path: made.path });
			return;
		}
		const move = { moveUp, moveDown, moveIn: moveIntoPrevious, moveOut }[action as "moveUp"];
		if (move) {
			const result = move(tree, path);
			if ("tree" in result) apply(result.tree, { kind: "node", path: result.path });
			else announce(t(`builder.moves.refused.${result.refused as "first"}`, { name: "" }));
		}
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
	return (
		<EditorEnvironment value={{ siteMedia: true, adminOrigin: source.adminOrigin }}>
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
						onHidden={onHidden}
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
						grabbed={grabbed !== null}
						canPaste={clipboard.current.length > 0}
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
							if (change === "pick") setGrabbed(tree);
							else {
								if (change === "cancel" && grabbed) apply(grabbed);
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
						onOneOff={(_path, id, declarations) => {
							void (async () => {
								try {
									if (!(await shared?.flush())) return;
									const markup = await bridge.call<{ markup: string }>("code/editorMarkup", {
										ref: source.ref,
										draft: { tree: treeRef.current, styles: { [id]: declarations } },
									});
									const current = await bridge.call<{ version: string | null }>("code/open", { ref: source.ref });
									await bridge.call("code/save", { ref: source.ref, markup: markup.markup, version: current.version });
									const fresh = await bridge.call<PanelSource>("code/editor", { ref: source.ref });
									setCatalogue(fresh.opened.catalogue);
									onTree(fresh.opened.tree);
								} catch (failure) {
									announce(String(failure));
								}
							})();
						}}
						onCatalogue={(classes) => {
							setCatalogue((before) => ({ ...before, classes }));
							bridge.refresh();
						}}
						onMakeEditable={(path, trigger) => {
							fixedTrigger.current = trigger;
							setFixed(path);
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
					text={(() => {
						const node = nodeAt(tree, fixed);
						return node?.type === "text" ? node.text : "";
					})()}
					siteId={source.siteId}
					postTypeId={"postTypeId" in source.target ? source.target.postTypeId : null}
					props={source.opened.props}
					onMade={(made) => {
						const next = replaceAt(tree, fixed, { type: "value", path: made.path });
						if (made.props) {
							shared?.change((current) => ({
								...(current as Record<string, Json>),
								props: made.props as unknown as Json,
								tree: next as unknown as Json,
							}));
							setTree(next);
							onTree(next);
						} else apply(next);
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
