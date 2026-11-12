import type { FieldDefinition, Json } from "@webcraft/core";
import { DialogContainer } from "@webcraft/ui/components/dialog.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BarKit } from "../../site/edit-bar/kit.ts";
import { editorAccessibility } from "../builder/editor-accessibility.ts";
import { type EditorApi, EditorEnvironment, MediaApiContext } from "../builder/editor-api.tsx";
import { type LayerAction, type LayerRow, LayersPanel } from "../builder/LayersPanel.tsx";
import type { Catalogue } from "../builder/model.ts";
import { FieldValueList } from "../content/FieldValues.tsx";
import { loadMedia } from "../content/loaders.ts";
import { AdminIntl, useT } from "../i18n.tsx";
import type { MediaItem } from "../media/preview.ts";
import { type LayoutState, type PageLayoutController, pageLayoutController } from "./controller.ts";

const catalogue: Catalogue = {
	elements: [],
	commands: [],
	classes: [],
	utilities: [],
	tokens: [],
	components: [],
	loops: [],
	forms: [],
	popups: [],
	filters: [],
	values: [],
};
const layerActions: LayerAction[] = ["moveUp", "moveDown", "duplicate", "delete"];

function LayoutEditor({
	controller,
	kit,
	launcher,
}: {
	controller: PageLayoutController;
	kit: BarKit;
	launcher: HTMLButtonElement;
}) {
	const t = useT();
	const [, render] = useState(0);
	useEffect(() => controller.subscribe(() => render((n) => n + 1)), [controller]);
	const { data, selected, panel, focusRequest, grabbed, busy, editing } = controller.state();
	const dialog = useRef<HTMLDialogElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const previous = useRef(panel);
	const handledFocus = useRef(0);
	const phone = kit.phone();
	useEffect(() => {
		if (!editing || phone) return;
		return editorAccessibility(kit.doc).registerRegionLayout({
			hiddenRegions: () => ["tree", "inspector"],
			reveal(name, focus) {
				if (name === "tree") controller.openLayout(false);
				if (name === "inspector") controller.openProps(false);
				requestAnimationFrame(focus);
			},
		});
	}, [controller, kit, editing, phone]);
	useEffect(() => {
		if (phone && panel && !dialog.current?.open) dialog.current?.showModal();
		if (!panel && previous.current) launcher.focus();
		previous.current = panel;
	}, [panel, phone, launcher]);
	useEffect(() => {
		if (!panel || !focusRequest || focusRequest === handledFocus.current) return;
		handledFocus.current = focusRequest;
		requestAnimationFrame(() => {
			if (phone) {
				const target = root.current?.querySelector<HTMLElement>(
					panel === "tree"
						? '[role="treeitem"][aria-selected="true"], [role="treeitem"][tabindex="0"]'
						: panel === "inspector"
							? '[data-editor-region="inspector"] input, [data-editor-region="inspector"] button, [data-editor-region="inspector"]'
							: "[data-picker] button",
				);
				target?.focus();
			} else if (panel !== "picker") editorAccessibility(kit.doc).focusRegion(panel);
			else root.current?.querySelector<HTMLElement>("[data-picker] button")?.focus();
		});
	}, [focusRequest, panel, phone, kit]);
	const p = data.layout.placements.find((p) => p.id === selected);
	const nodes = [
		{ type: "component" as const, id: "context:header", component: "context:header", props: [] },
		...data.layout.placements.map((p) => ({
			type: "component" as const,
			id: p.id,
			component: p.component,
			props: [],
			hidden: p.hidden,
		})),
		{ type: "component" as const, id: "context:footer", component: "context:footer", props: [] },
	];
	const idOf = (row: LayerRow) => (row.kind === "node" && "id" in row.node ? row.node.id : "");
	const contextual = (id: string) => id === "context:header" || id === "context:footer";
	const label = (row: LayerRow) =>
		idOf(row) === "context:header"
			? t("pageLayout.header")
			: idOf(row) === "context:footer"
				? t("pageLayout.footer")
				: controller.label(idOf(row));
	const toolbar = p ? (
		<fieldset className="flex flex-wrap gap-2 border-b p-3" aria-label={controller.label(p.id)}>
			<button type="button" className="min-h-11 rounded border px-3" onClick={() => controller.openProps()}>
				{t("pageLayout.props")}
			</button>
			{phone ? (
				<button type="button" className="min-h-11 rounded border px-3" onClick={() => controller.openLayout()}>
					{t("pageLayout.move")}
				</button>
			) : null}
			{(["moveUp", "moveDown", "duplicate", "hide", "delete", "lock"] as const)
				.filter((a) => a !== "lock" || data.canLock)
				.map((action) => (
					<button
						key={action}
						type="button"
						className="min-h-11 rounded border px-3 disabled:opacity-50"
						disabled={!controller.allowed(action)}
						aria-pressed={action === "lock" ? !!p.locked : action === "hide" ? !!p.hidden : undefined}
						onClick={() => void controller.action(action)}
					>
						{t(`pageLayout.${action}`)}
					</button>
				))}
		</fieldset>
	) : null;
	const content = (
		<div ref={root}>
			<div className="flex items-center justify-between border-b p-3">
				<h2 id="page-layout-title" className="font-semibold">
					{t(panel === "inspector" ? "pageLayout.props" : panel === "picker" ? "pageLayout.add" : "pageLayout.title")}
				</h2>
				<button type="button" className="min-h-11 rounded border px-3" onClick={() => controller.close()}>
					{t("pageLayout.close")}
				</button>
			</div>
			{toolbar}
			<div data-editor-region="tree" hidden={panel !== "tree"}>
				<LayersPanel
					tree={{ version: 1, nodes }}
					catalogue={catalogue}
					selection={selected ? { kind: "node", path: [nodes.findIndex((n) => n.id === selected)] } : null}
					collapsed={new Set()}
					grabbed={grabbed}
					canPaste={false}
					focusRequest={focusRequest}
					placementRows={{
						label,
						locked: (row) => contextual(idOf(row)) || !!data.layout.placements.find((p) => p.id === idOf(row))?.locked,
						movable: (row) =>
							!contextual(idOf(row)) &&
							(data.canLock || !data.layout.placements.find((p) => p.id === idOf(row))?.locked),
						actions: layerActions,
						canInsert: data.canArrange && !busy,
						canAction: (row, action) =>
							controller.allowed(action as "moveUp" | "moveDown" | "duplicate" | "delete", idOf(row)),
					}}
					onSelect={(s) => {
						if (s.kind === "node") controller.select(nodes[s.path[0] ?? 0]?.id ?? null);
					}}
					onToggle={() => {}}
					onAction={(a) => {
						if (layerActions.includes(a)) void controller.action(a as "moveUp" | "moveDown" | "duplicate" | "delete");
					}}
					onGrab={(change) => void controller.grab(change)}
					onRename={() => {}}
					onDrop={(from, to, position) => {
						const a = (from[0] ?? 0) - 1;
						const b = (to[0] ?? 0) - 1;
						void controller.drop(a, b + (position === "after" ? 1 : 0) - (a < b ? 1 : 0));
					}}
					onInsert={() => controller.openPicker()}
					onHidden={(path) => void controller.action("hide", nodes[path[0] ?? -1]?.id ?? null)}
				/>
			</div>
			<div data-picker hidden={panel !== "picker"} className="grid gap-2 p-4">
				{data.components.map((c) => (
					<button
						type="button"
						className="min-h-11 rounded border p-3 text-start"
						key={c.id}
						disabled={busy}
						onClick={() => void controller.insert(c.id)}
					>
						{c.name}
					</button>
				))}
				{!data.components.length ? <p>{t("pageLayout.noComponents")}</p> : null}
			</div>
			<div data-editor-region="inspector" tabIndex={-1} hidden={panel !== "inspector"} className="p-4">
				{p ? (
					<Props key={p.id} controller={controller} id={p.id} fields={p.props} kit={kit} />
				) : (
					<p>{t("pageLayout.select")}</p>
				)}
			</div>
		</div>
	);
	if (!editing) return null;
	const floating =
		!panel && selected ? (
			<aside
				className="bg-background text-foreground fixed inset-x-4 bottom-4 z-50 rounded-lg border shadow-lg"
				aria-label={t("pageLayout.title")}
			>
				{toolbar}
				<button type="button" className="min-h-11 p-3" onClick={() => controller.openLayout()}>
					{t("pageLayout.title")}
				</button>
			</aside>
		) : null;
	if (phone)
		return panel ? (
			<dialog
				ref={dialog}
				aria-labelledby="page-layout-title"
				className={`bg-background text-foreground fixed m-0 w-full max-w-none overflow-auto p-0 ${panel === "tree" ? "inset-0 h-dvh max-h-none" : "inset-x-0 top-auto bottom-0 max-h-[85dvh] rounded-t-xl"}`}
				onCancel={(event) => {
					event.preventDefault();
					controller.close();
				}}
			>
				{content}
			</dialog>
		) : (
			floating
		);
	return (
		<>
			{floating}
			<aside
				aria-labelledby="page-layout-title"
				hidden={!panel}
				className={`bg-background text-foreground fixed top-16 bottom-0 z-50 w-96 max-w-full overflow-auto border shadow-lg ${panel === "inspector" ? "end-0" : "start-0"}`}
			>
				{content}
			</aside>
		</>
	);
}

function Props({
	controller,
	id,
	fields,
	kit,
}: {
	controller: PageLayoutController;
	id: string;
	fields: FieldDefinition[];
	kit: BarKit;
}) {
	const { data } = controller.state();
	const [values, setValues] = useState(() => controller.values(id));
	const [media, setMedia] = useState<Record<string, MediaItem>>({});
	const pending = useRef(new Map<string, { field: FieldDefinition; value: Json }>());
	const flush = useCallback(() => {
		const changes = [...pending.current.values()];
		pending.current.clear();
		for (const change of changes) void controller.prop(id, change.field, change.value);
	}, [controller, id]);
	useEffect(() => controller.flushWith(flush), [controller, flush]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: accepted and peer versions invalidate the controller's value view.
	useEffect(() => {
		setValues((before) => ({
			...controller.values(id),
			...Object.fromEntries([...pending.current].map(([key]) => [key, before[key] ?? null])),
		}));
	}, [controller, id, data.version]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: media references can change with the accepted layout version.
	useEffect(() => {
		let active = true;
		void loadMedia(
			{
				media: {
					get: async (input) => {
						const result = await kit.call("layout/mediaGet", input);
						if (!result.ok) throw new Error(result.code);
						return result.data as { media: MediaItem };
					},
				},
			},
			data.siteId,
			fields,
			controller.values(id),
		)
			.then((items) => {
				if (active) setMedia(items);
			})
			.catch(() => {
				if (active) editorAccessibility(kit.doc).announce(kit.errorText("generic"), "interrupt");
			});
		return () => {
			active = false;
		};
	}, [kit, data.siteId, fields, id, controller, data.version]);
	return (
		<FieldValueList
			fields={fields}
			values={values}
			at="props."
			wrap={(_field, control) => <div onBlurCapture={flush}>{control}</div>}
			onChange={(key, value) => {
				setValues((before) => ({ ...before, [key]: value }));
				const field = fields.find((f) => f.key === key);
				if (!field) return;
				pending.current.set(key, { field, value });
				let active: Element | null = kit.doc.activeElement;
				while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
				if (!active?.matches("textarea,[contenteditable],input:not([type=checkbox]):not([type=radio])")) flush();
			}}
			context={{
				siteId: data.siteId,
				idPrefix: `placement-${id}`,
				language: data.language,
				defaultLanguage: data.defaultLanguage,
				problems: [],
				relationships: data.relationships,
				media,
				onMediaChosen: (item) => setMedia((before) => ({ ...before, [item.id]: item })),
				markShared: true,
			}}
		/>
	);
}

async function mount(kit: BarKit, language: "en" | "it", styles: string) {
	const item = kit.state().page.item;
	if (!item?.startsWith("entry:")) return;
	const entryId = item.slice(6);
	const response = await kit.call("layout/get", { entryId, language: kit.state().language.code });
	if (!response.ok) return;
	const initial = response.data as LayoutState;
	if (!initial.canArrange) return;
	const view = kit.doc.defaultView;
	if (!view) return;
	const host = kit.doc.createElement("div");
	host.id = "webcraft-page-layout";
	kit.doc.body.append(host);
	const shadow = host.attachShadow({ mode: "open" });
	const link = kit.doc.createElement("link");
	link.rel = "stylesheet";
	link.href = styles;
	shadow.append(link);
	const container = kit.doc.createElement("div");
	shadow.append(container);
	const scheme = view.matchMedia("(prefers-color-scheme: dark)");
	const theme = () => {
		container.classList.toggle("dark", scheme.matches);
		container.classList.toggle("light", !scheme.matches);
	};
	theme();
	scheme.addEventListener("change", theme);
	const controller = pageLayoutController(kit, initial, entryId);
	const button = kit.button({ type: "button", class: "control" }, kit.word("pageLayout.title"));
	kit.root.querySelector(".bar")?.append(button);
	button.addEventListener("click", () => controller.openLayout());
	controller.subscribe(() => {
		button.disabled = !controller.state().editing;
	});
	const root = createRoot(container);
	root.render(
		<AdminIntl language={language}>
			<DialogContainer value={container}>
				<MediaApiContext
					value={{
						list: async (input) => {
							const result = await kit.call("layout/media", input);
							if (!result.ok) throw new Error(kit.errorText(result.code));
							return result.data as Awaited<ReturnType<EditorApi["media"]["list"]>>;
						},
					}}
				>
					<EditorEnvironment value={{ siteMedia: true, adminOrigin: "" }}>
						<LayoutEditor controller={controller} kit={kit} launcher={button} />
					</EditorEnvironment>
				</MediaApiContext>
			</DialogContainer>
		</AdminIntl>,
	);
	kit.doc.dispatchEvent(new CustomEvent("webcraft:page-layout", { detail: controller }));
}
document.dispatchEvent(new CustomEvent("webcraft:layout-tools", { detail: { mount } }));
