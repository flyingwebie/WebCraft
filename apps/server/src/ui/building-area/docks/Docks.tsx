import {
	EyeOffIcon,
	FoldVerticalIcon,
	PanelBottomIcon,
	PanelLeftIcon,
	PanelRightIcon,
	RotateCcwIcon,
	UnfoldVerticalIcon,
} from "lucide-react";
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import type { EditorLayout } from "../../editor/editor-fit.ts";
import { fill, type ShellConfig, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import {
	DOCK_LIMITS,
	DOCK_SIDES,
	type DockSide,
	dockLength,
	fitDocks,
	type Layout,
	movePanel,
	PANEL_MIN,
	type PanelPlacement,
	panelWeights,
	resizeDock,
	resizePanels,
	setCollapsed,
	setHidden,
	type WindowSize,
	withPanels,
} from "./layout.ts";
import type { MenuEntry } from "./Menu.tsx";
import { PanelFrame } from "./PanelFrame.tsx";
import { PANELS, type PanelContext, type PanelDefinition, type PanelKey, panelOf } from "./panels.ts";
import { layoutSaver } from "./preferences.ts";
import { framesIgnorePointer, Separator } from "./Separator.tsx";

/** How far the pointer moves on a grip before the panel lifts: less is a click. */
const LIFT_AFTER = 4;

/** An empty bottom dock's drop box while a panel is in the air: enough to aim at, without squeezing the page. */
const EMPTY_BOTTOM_DROP = 120;

/** A panel the docks draw now: where it is, and what it is. */
export type ShownPanel = { placement: PanelPlacement; definition: PanelDefinition };

/** Where a panel in the air would land: a dock, before a panel there (or at its end), and the line that shows it. */
type Landing = {
	side: DockSide;
	before: string | null;
	line: { left: number; top: number; width: number; height: number };
};

type InAir = { id: PanelKey; x: number; y: number; landing: Landing | null };

/** The docks' state for the shell: the layout, what each dock shows, and the changes the Panels menu makes. */
export type Docks = {
	layout: Layout;
	/** Each dock's panels drawn now: switched on, and their rule holding. */
	shown: Record<DockSide, ShownPanel[]>;
	words: Words;
	context: PanelContext;
	/** Panels whose header shows a control of their own in place of the title (Layers' document switcher). */
	headings: Partial<Record<PanelKey, ReactNode>>;
	/** What each panel shows under its header (BA-08 onwards: Layers, the Inspector); empty when none. */
	bodies: Partial<Record<PanelKey, ReactNode>>;
	/** A panel's title when it isn't its name (BA-09: the Inspector says "Loop" over an element a Loop repeats). */
	titles: Partial<Record<PanelKey, string>>;
	/** Beside a panel's title, muted: what it shows now (`h1 · Heading`); the Inspector's is the selection's name. */
	subs: Partial<Record<PanelKey, string>>;
	/** A panel's own entries at the top of its header's menu (BA-11: a code pane's Expand, Copy all, its switches). */
	menus: Partial<Record<PanelKey, readonly MenuEntry[]>>;
	change(next: Layout | null, said?: string): void;
	/** A panel switched off or on in the Panels menu. */
	toggle(id: PanelKey): void;
	reset(): void;
	/** The panel being moved by the pointer, and where it would land. */
	inAir: InAir | null;
	lift(id: PanelKey, event: ReactPointerEvent<HTMLElement>): void;
	window: WindowSize;
	/** Between 1024 and 1279 px the side docks open one at a time, over the canvas. */
	drawer: DockSide | null;
	setDrawer(side: DockSide | null): void;
	/** A panel whose menu button takes focus once the docks have drawn (after a move from its menu). */
	focusLater(id: string | null): void;
	/** The actions each panel's header shows beside its title (BA-13: the Entry panel's Find and Collapse; BA-11: the code panes' Classes, Format and Expand; BA-09: the Props panel's Edit Component, the Component panel's "+"). */
	panelActions: Partial<Record<PanelKey, ReactNode>>;
};

/** The window's size, following it. */
function useWindowSize(): WindowSize {
	const [size, setSize] = useState<WindowSize>(() => ({ width: window.innerWidth, height: window.innerHeight }));
	useEffect(() => {
		const measure = () => setSize({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);
	return size;
}

/** A panel's name in the menus and messages. */
export function panelName(words: Words, id: string): string {
	return words.dockPanels[id as PanelKey] ?? id;
}

/**
 * The docks (SPEC 2, 4 and 5; BA-05): the layout as the person left it (from the shell's config),
 * changed by the docks and the Panels menu, and written to their editor preferences 500 ms after
 * each change.
 */
export function useDocks({
	config,
	context,
	headings = {},
	bodies = {},
	titles = {},
	subs = {},
	menus = {},
	wide = null,
	announce,
	panelActions = {},
}: {
	config: ShellConfig;
	context: PanelContext;
	headings?: Partial<Record<PanelKey, ReactNode>>;
	bodies?: Partial<Record<PanelKey, ReactNode>>;
	titles?: Partial<Record<PanelKey, string>>;
	subs?: Partial<Record<PanelKey, string>>;
	menus?: Partial<Record<PanelKey, readonly MenuEntry[]>>;
	/** A panel opened wide (a code pane's Expand, BA-11): the only one its dock draws while it shows. Not stored. */
	wide?: PanelKey | null;
	announce(text: string, urgent?: boolean): void;
	panelActions?: Partial<Record<PanelKey, ReactNode>>;
}): Docks {
	const { words } = config;
	const [stored, setStored] = useState<Layout | null>(config.layout);
	const layout = useMemo(() => withPanels(stored, PANELS), [stored]);
	const size = useWindowSize();
	const [inAir, setInAir] = useState<InAir | null>(null);
	const [drawer, setDrawer] = useState<DockSide | null>(null);
	const [focusTarget, setFocusTarget] = useState<string | null>(null);
	const latest = useRef({ layout, announce, words });
	latest.current = { layout, announce, words };

	const saver = useMemo(
		() =>
			layoutSaver({
				siteId: config.site.id,
				token: config.token,
				failed: () => latest.current.announce(latest.current.words.docks.saveFailed, true),
			}),
		[config.site.id, config.token],
	);
	useEffect(() => {
		const leave = () => void saver.flush();
		window.addEventListener("pagehide", leave);
		return () => window.removeEventListener("pagehide", leave);
	}, [saver]);

	const change = useCallback(
		(next: Layout | null, said?: string) => {
			setStored(next);
			saver.save(next);
			if (said) latest.current.announce(said);
		},
		[saver],
	);

	const shown = useMemo(() => {
		const of = (side: DockSide) =>
			layout.docks[side].panels.flatMap((placement) => {
				const definition = panelOf(placement.id);
				return definition && !placement.hidden && definition.shows(context) ? [{ placement, definition }] : [];
			});
		// A panel opened wide is the only one its dock draws, while it shows there.
		const widened = (panels: ShownPanel[]) => {
			const only = panels.find((each) => each.placement.id === wide && !each.placement.collapsed);
			return only ? [only] : panels;
		};
		return { left: widened(of("left")), right: widened(of("right")), bottom: widened(of("bottom")) };
	}, [layout, context, wide]);

	const toggle = useCallback(
		(id: PanelKey) => {
			const { layout: now, words: said } = latest.current;
			const panel = now.docks.left.panels
				.concat(now.docks.right.panels, now.docks.bottom.panels)
				.find((each) => each.id === id);
			const hide = !panel?.hidden;
			change(
				setHidden(now, id, hide),
				fill(hide ? said.docks.switchedOff : said.docks.switchedOn, { panel: panelName(said, id) }),
			);
		},
		[change],
	);

	const reset = useCallback(() => change(null, latest.current.words.docks.resetDone), [change]);

	/** The dock and the place in it under the pointer, with the line that shows it. */
	const landingAt = useCallback((x: number, y: number): Landing | null => {
		for (const side of DOCK_SIDES) {
			const dock = document.querySelector<HTMLElement>(`[data-wc-dock="${side}"]`);
			const box = dock?.getBoundingClientRect();
			if (!dock || !box || x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
			const across = side !== "bottom";
			const panels = [...dock.querySelectorAll<HTMLElement>("[data-wc-panel]")];
			if (panels.length === 0) {
				const inset = 16;
				return {
					side,
					before: null,
					line: across
						? { left: box.left + inset, top: box.top + inset, width: box.width - 2 * inset, height: 2 }
						: { left: box.left + inset, top: box.top + inset, width: 2, height: box.height - 2 * inset },
				};
			}
			const rtl = getComputedStyle(dock).direction === "rtl";
			const rects = panels.map((panel) => ({ id: panel.dataset.wcPanel ?? "", box: panel.getBoundingClientRect() }));
			const at = rects.findIndex(({ box: each }) =>
				across ? y < each.top + each.height / 2 : rtl ? x > each.left + each.width / 2 : x < each.left + each.width / 2,
			);
			const before = at === -1 ? null : (rects[at]?.id ?? null);
			const edge = (() => {
				if (at !== -1) {
					const each = rects[at]?.box;
					if (!each) return 0;
					return across ? each.top - 5 : rtl ? each.right + 3 : each.left - 5;
				}
				const last = rects.at(-1)?.box;
				if (!last) return 0;
				return across ? last.bottom + 3 : rtl ? last.left - 5 : last.right + 3;
			})();
			const first = rects[0]?.box;
			if (!first) return null;
			return {
				side,
				before,
				line: across
					? { left: first.left, top: edge, width: first.width, height: 2 }
					: { left: edge, top: first.top, width: 2, height: first.height },
			};
		}
		return null;
	}, []);

	const lift = useCallback(
		(id: PanelKey, event: ReactPointerEvent<HTMLElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const start = { x: event.clientX, y: event.clientY };
			const pointer = event.pointerId;
			let lifted = false;
			// From the press on, the page's frame lets the pointer through: a quick first move over it still reaches here.
			framesIgnorePointer(true);
			const move = (moved: PointerEvent) => {
				if (moved.pointerId !== pointer) return;
				if (!lifted) {
					if (Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < LIFT_AFTER) return;
					lifted = true;
				}
				setInAir({ id, x: moved.clientX, y: moved.clientY, landing: landingAt(moved.clientX, moved.clientY) });
			};
			const stop = () => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", cancel, true);
				window.removeEventListener("keydown", key, true);
				framesIgnorePointer(false);
				setInAir(null);
			};
			const up = (ended: PointerEvent) => {
				if (ended.pointerId !== pointer) return;
				const landing = lifted ? landingAt(ended.clientX, ended.clientY) : null;
				stop();
				if (!landing) return;
				const { layout: now, words: said } = latest.current;
				const next = movePanel(now, id, landing.side, landing.before);
				if (next === now) return;
				change(next, fill(said.docks.moved, { panel: panelName(said, id), dock: said.docks.dockNames[landing.side] }));
			};
			const cancel = () => stop();
			const key = (pressed: KeyboardEvent) => {
				if (pressed.key !== "Escape") return;
				pressed.preventDefault();
				pressed.stopPropagation();
				stop();
				latest.current.announce(latest.current.words.docks.moveCancelled);
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", cancel, true);
			window.addEventListener("keydown", key, true);
		},
		[change, landingAt],
	);

	// After a move from a panel's menu, its menu button takes focus where the panel now is.
	useLayoutEffect(() => {
		if (!focusTarget) return;
		document.querySelector<HTMLElement>(`[data-wc-panel-menu="${focusTarget}"]`)?.focus();
		setFocusTarget(null);
	}, [focusTarget]);

	return {
		layout,
		shown,
		words,
		context,
		headings,
		bodies,
		titles,
		subs,
		menus,
		change,
		toggle,
		reset,
		inAir,
		lift,
		window: size,
		drawer,
		setDrawer,
		focusLater: setFocusTarget,
		panelActions,
	};
}

/** The icon of a dock in the menus. */
const DOCK_ICONS = { left: PanelLeftIcon, right: PanelRightIcon, bottom: PanelBottomIcon } as const;

/**
 * The three docks around the canvas (SPEC 2 and 4; `docking/01` to `05`), each in its grid area of the
 * working area: left and right full height, the bottom one under the canvas between them. A dock with
 * no panel to show takes no space, and shows as a dashed drop box while a panel is in the air.
 * Between 1024 and 1279 px the side docks open one at a time over the canvas (`fit`). A window
 * narrowed while someone works in a side dock keeps that dock open, as its drawer, focus where it was
 * (BA-34); selecting on the page never opens a drawer that was closed, nor closes one that is open.
 * The bottom dock stays in the canvas's column, never under a side dock: beside an open drawer it
 * ends at the drawer's edge (FX-02).
 */
export function DockArea({
	docks,
	fit,
	hidden,
	onHideFocus,
}: {
	docks: Docks;
	fit: EditorLayout;
	/** Hide interface: every dock goes. */
	hidden: boolean;
	/** Where focus goes when a panel is switched off from its own menu (the Panels menu's button). */
	onHideFocus(): void;
}) {
	const { layout, shown, inAir } = docks;
	const drawers = fit === "drawers";
	// Narrowed into the drawer layout while working in a side dock: that dock stays open, as its drawer.
	const before = useRef(fit);
	const kept = drawers && before.current !== "drawers" && !docks.drawer ? focusedSide() : null;
	const { setDrawer } = docks;
	useLayoutEffect(() => {
		before.current = fit;
		if (kept) setDrawer(kept);
	});
	const drawer = docks.drawer ?? kept;
	if (hidden) return null;
	const open = (side: DockSide) => shown[side].length > 0;
	const lengths = fitDocks(
		{
			left: open("left") && !drawers ? dockLength(layout, "left", docks.window) : null,
			right: open("right") && !drawers ? dockLength(layout, "right", docks.window) : null,
			bottom: open("bottom") ? dockLength(layout, "bottom", docks.window) : null,
		},
		docks.window,
	);

	const drawn = (side: DockSide) => {
		const isOpen = open(side);
		if (!isOpen && !inAir) return null;
		if (drawers && side !== "bottom" && drawer !== side && !inAir) return null;
		return isOpen
			? (lengths[side] ?? dockLength(layout, side, docks.window))
			: side === "bottom"
				? EMPTY_BOTTOM_DROP
				: DOCK_LIMITS.side.initial;
	};
	// Over the canvas, a drawer drawn takes its width from the bottom dock's row: the dock ends at its edge.
	const besideDrawers = drawers ? { start: drawn("left") ?? 0, end: drawn("right") ?? 0 } : { start: 0, end: 0 };

	const dock = (side: DockSide) => {
		const length = drawn(side);
		if (length === null) return null;
		const inDrawer = drawers && side !== "bottom";
		return (
			<Dock
				key={side}
				side={side}
				length={length}
				docks={docks}
				drawer={inDrawer}
				inset={side === "bottom" ? besideDrawers : undefined}
				onHideFocus={onHideFocus}
			/>
		);
	};

	return (
		<>
			{dock("left")}
			{dock("right")}
			{dock("bottom")}
			{drawers && !inAir ? <DrawerToggles docks={docks} /> : null}
			{inAir ? <InAirLayer docks={docks} /> : null}
		</>
	);
}

/** The side dock that has focus now, if one has. */
function focusedSide(): "left" | "right" | null {
	const side = document.activeElement?.closest("[data-wc-dock]")?.getAttribute("data-wc-dock");
	return side === "left" || side === "right" ? side : null;
}

/** Between 1024 and 1279 px: a button at each top corner of the canvas that opens its side dock over it. */
function DrawerToggles({ docks }: { docks: Docks }) {
	const { words } = docks;
	return (
		<>
			{(["left", "right"] as const).map((side) =>
				docks.shown[side].length > 0 ? (
					<button
						key={side}
						type="button"
						aria-expanded={docks.drawer === side}
						aria-label={fill(docks.drawer === side ? words.docks.closeDrawer : words.docks.openDrawer, {
							dock: words.docks.dockNames[side],
						})}
						onClick={() => docks.setDrawer(docks.drawer === side ? null : side)}
						className={`group bg-chrome-raised text-chrome-text hover:bg-chrome-hover absolute top-2 z-30 grid size-7 place-items-center rounded-md shadow-[0_6px_16px_rgba(0,0,0,0.5)] ${
							side === "left" ? "start-2" : "end-2"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						// Beside its drawer while it is open, so it never covers the drawer's own header.
						style={{
							gridArea: "canvas",
							...(docks.drawer === side
								? {
										[side === "left" ? "insetInlineStart" : "insetInlineEnd"]:
											dockLength(docks.layout, side, docks.window) + 8,
									}
								: {}),
						}}
						data-wc-drawer-toggle={side}
					>
						{side === "left" ? (
							<PanelLeftIcon aria-hidden="true" className="size-4" />
						) : (
							<PanelRightIcon aria-hidden="true" className="size-4" />
						)}
						<Tip
							label={fill(docks.drawer === side ? words.docks.closeDrawer : words.docks.openDrawer, {
								dock: words.docks.dockNames[side],
							})}
							side="bottom"
							align={side === "left" ? "start" : "end"}
						/>
					</button>
				) : null,
			)}
		</>
	);
}

/** While a panel is in the air: a layer that keeps the pointer from the page, the panel's ghost and the landing line. */
function InAirLayer({ docks }: { docks: Docks }) {
	const { inAir, words } = docks;
	if (!inAir) return null;
	return (
		<div aria-hidden="true" className="fixed inset-0 z-[60] cursor-grabbing" data-wc-in-air={inAir.id}>
			{inAir.landing ? (
				<div
					className="bg-chrome-focus pointer-events-none fixed rounded-full"
					style={inAir.landing.line}
					data-wc-landing-line={inAir.landing.side}
				/>
			) : null}
			<div
				className="border-chrome-hover bg-chrome-raised pointer-events-none fixed flex h-[140px] w-[250px] flex-col overflow-hidden rounded-lg border opacity-55"
				style={{ left: inAir.x + 12, top: inAir.y + 12 }}
			>
				<div className="border-chrome-line flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
					<span className="text-chrome-strong text-[12px] font-semibold">{panelName(words, inAir.id)}</span>
				</div>
				<div className="bg-chrome-well grow" />
			</div>
		</div>
	);
}

/** One dock: its panels with the separators between them, and the separator at its edge that sizes it. */
function Dock({
	side,
	length,
	docks,
	drawer,
	inset,
	onHideFocus,
}: {
	side: DockSide;
	length: number;
	docks: Docks;
	/** Drawn over the canvas (between 1024 and 1279 px). */
	drawer: boolean;
	/** The bottom dock beside the drawers drawn over the canvas: their widths at its start and its end. */
	inset?: { start: number; end: number };
	onHideFocus(): void;
}) {
	const { layout, words, inAir, change } = docks;
	const panels = docks.shown[side];
	const element = useRef<HTMLElement>(null);
	const base = useRef<{ layout: Layout; length: number; lengths: { id: string; length: number }[] } | null>(null);
	const across = side !== "bottom";
	const empty = panels.length === 0;
	const target = inAir?.landing?.side === side;
	const dockName = words.docks.dockNames[side];

	// A drawer opened takes focus (on its first control), unless it has it already (a window narrowed
	// while working in it). In a drawer, Escape closes it and focus goes back to the button that opened it.
	useEffect(() => {
		if (!drawer) return;
		const box = element.current;
		if (box?.contains(document.activeElement)) return;
		const first = box?.querySelector<HTMLElement>("button, [tabindex='0']");
		first?.focus();
	}, [drawer]);

	const rtl = () => (element.current ? getComputedStyle(element.current).direction === "rtl" : false);

	/** The open panels' lengths along the dock, as drawn now. */
	const measure = () =>
		[...(element.current?.querySelectorAll<HTMLElement>("[data-wc-panel]:not([data-collapsed])") ?? [])].map(
			(panel) => {
				const box = panel.getBoundingClientRect();
				return { id: panel.dataset.wcPanel ?? "", length: across ? box.height : box.width };
			},
		);

	/** The edge separator moved `delta` pixels as drawn: how much the dock grows. */
	const growth = (delta: number) => {
		if (side === "bottom") return -delta;
		const end = side === "right" ? !rtl() : rtl();
		return end ? -delta : delta;
	};

	const edge = (
		<Separator
			orientation={across ? "vertical" : "horizontal"}
			label={fill(words.docks.resizeDock, { dock: dockName })}
			value={{
				now: length,
				min: across ? DOCK_LIMITS.side.min : DOCK_LIMITS.bottom.min,
				max: across ? DOCK_LIMITS.side.max : DOCK_LIMITS.bottom.max,
			}}
			line={false}
			className={`absolute! ${
				side === "bottom" ? "inset-x-0 top-0" : side === "right" ? "inset-y-0 start-0" : "inset-y-0 end-0"
			}`}
			onMove={(delta, from) => {
				if (from === "key" || !base.current) base.current = { layout, length, lengths: [] };
				const next = resizeDock(base.current.layout, side, base.current.length + growth(delta), docks.window);
				change(next);
				if (from === "key") base.current = null;
			}}
			onStart={() => {
				base.current = { layout, length, lengths: [] };
			}}
			onEnd={() => {
				base.current = null;
			}}
			data={{ "data-wc-dock-edge": side }}
		/>
	);

	const menuFor = (shownPanel: ShownPanel): MenuEntry[] => {
		const { placement } = shownPanel;
		const id = placement.id;
		const name = panelName(words, id);
		const moves: MenuEntry[] = DOCK_SIDES.filter((to) => to !== side).map((to) => ({
			kind: "item",
			key: `move-${to}`,
			icon: DOCK_ICONS[to],
			label: words.docks.moveTo[to],
			onSelect: () => {
				change(movePanel(layout, id, to), fill(words.docks.moved, { panel: name, dock: words.docks.dockNames[to] }));
				docks.focusLater(id);
			},
		}));
		const own = docks.menus[id as PanelKey] ?? [];
		return [
			...own,
			...(own.length > 0 ? [{ kind: "separator", key: "own" } as const] : []),
			...moves,
			{
				kind: "item",
				key: placement.collapsed ? "expand" : "collapse",
				icon: placement.collapsed ? UnfoldVerticalIcon : FoldVerticalIcon,
				label: placement.collapsed ? words.docks.expand : words.docks.collapse,
				onSelect: () => {
					change(
						setCollapsed(layout, id, !placement.collapsed),
						fill(placement.collapsed ? words.docks.expanded : words.docks.collapsed, { panel: name }),
					);
					docks.focusLater(id);
				},
			},
			{
				kind: "item",
				key: "hide",
				icon: EyeOffIcon,
				label: words.docks.hide,
				onSelect: () => {
					change(setHidden(layout, id, true), fill(words.docks.switchedOff, { panel: name }));
					onHideFocus();
				},
			},
			{ kind: "separator", key: "line" },
			{
				kind: "item",
				key: "reset",
				icon: RotateCcwIcon,
				label: words.docks.reset,
				onSelect: () => {
					docks.reset();
					docks.focusLater(id);
				},
			},
		];
	};

	const expandedPlacements = panels.filter((each) => !each.placement.collapsed).map((each) => each.placement);
	const weights = panelWeights(expandedPlacements);
	const weightOf = (id: string) => weights[expandedPlacements.findIndex((each) => each.id === id)] ?? 1;

	const sizeStyle: CSSProperties = across ? { width: length } : { height: length };
	const placeStyle: CSSProperties = drawer
		? sizeStyle
		: {
				...sizeStyle,
				gridArea: side,
				...(inset ? { marginInlineStart: inset.start, marginInlineEnd: inset.end } : {}),
			};

	return (
		<section
			ref={element}
			aria-label={dockName}
			onKeyDown={(event) => {
				if (drawer && event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault();
					docks.setDrawer(null);
					document.querySelector<HTMLElement>(`[data-wc-drawer-toggle="${side}"]`)?.focus();
				}
			}}
			style={placeStyle}
			className={`bg-chrome flex min-h-0 min-w-0 ${across ? "flex-col p-2" : `flex-row overflow-hidden ${empty ? "p-2" : ""}`} ${
				drawer
					? `absolute inset-y-0 z-30 shadow-[0_12px_32px_rgba(0,0,0,0.55)] ${side === "left" ? "start-0" : "end-0"}`
					: "relative"
			} ${inAir && !empty ? (target ? "outline-chrome-focus outline-2 -outline-offset-2 outline-dashed" : "outline-1 -outline-offset-1 outline-[#52525b] outline-dashed") : ""}`}
			data-wc-dock={side}
			data-building-region={side}
			data-target={target ? "" : undefined}
		>
			{empty ? (
				<div
					className={`flex grow items-center justify-center rounded-lg border-dashed text-[12px] font-medium ${
						target
							? "border-chrome-focus text-chrome-warn border-2 bg-[#fb923c14]"
							: "text-chrome-faint border border-[#2a2a30]"
					}`}
					data-wc-drop-box={side}
				>
					{words.docks.dockTitles[side]}
				</div>
			) : (
				<PanelRow across={across} panels={panels.length}>
					{panels.map((shownPanel, index) => {
						const { placement } = shownPanel;
						const next = panels[index + 1];
						const name = panelName(words, placement.id);
						const style: CSSProperties = placement.collapsed
							? { flex: "none" }
							: across
								? { flex: `${weightOf(placement.id)} 1 0px`, minHeight: PANEL_MIN.side }
								: {
										flex: `${weightOf(placement.id)} 1 0px`,
										// Never narrower than its header's controls (`PanelRow` measures them).
										minWidth: `max(${PANEL_MIN.bottom}px, var(--wc-header-least, 0px))`,
									};
						return (
							<Fragment key={placement.id}>
								<PanelFrame
									id={placement.id}
									kind={across ? "side" : "bottom"}
									title={titleOf(shownPanel, docks)}
									sub={
										docks.subs[placement.id as PanelKey] ??
										(placement.id === "inspector" ? docks.context.selection?.name : undefined)
									}
									actions={docks.panelActions[placement.id as PanelKey]}
									heading={docks.headings[placement.id as PanelKey]}
									collapsed={Boolean(placement.collapsed)}
									labels={{
										menu: fill(words.docks.panelMenu, { panel: name }),
										expand: fill(words.docks.expandPanel, { panel: name }),
										grip: words.docks.grip,
									}}
									menuEntries={menuFor(shownPanel)}
									style={style}
									lifted={inAir?.id === placement.id}
									onGrip={(event) => docks.lift(placement.id as PanelKey, event)}
									onExpand={() => {
										change(setCollapsed(layout, placement.id, false), fill(words.docks.expanded, { panel: name }));
										docks.focusLater(placement.id);
									}}
								>
									{docks.bodies[placement.id as PanelKey]}
								</PanelFrame>
								{next ? (
									<Separator
										orientation={across ? "horizontal" : "vertical"}
										label={fill(words.docks.between, { first: name, second: panelName(words, next.placement.id) })}
										value={{
											// The panel before it: its share of the dock's open length, in per cent (none when collapsed).
											now: placement.collapsed ? 0 : weightOf(placement.id) * 100,
											min: 0,
											max: 100,
										}}
										onMove={(delta, from) => {
											if (from === "key" || !base.current) base.current = { layout, length, lengths: measure() };
											const grow = !across && rtl() ? -delta : delta;
											change(resizePanels(base.current.layout, side, base.current.lengths, placement.id, grow));
											if (from === "key") base.current = null;
										}}
										onStart={() => {
											base.current = { layout, length, lengths: measure() };
										}}
										onEnd={() => {
											base.current = null;
										}}
										onDoubleClick={() =>
											change(
												setCollapsed(layout, placement.id, !placement.collapsed),
												fill(placement.collapsed ? words.docks.expanded : words.docks.collapsed, { panel: name }),
											)
										}
										data={{ "data-wc-between": `${placement.id}:${next.placement.id}` }}
									/>
								) : null}
							</Fragment>
						);
					})}
				</PanelRow>
			)}
			{empty ? null : edge}
		</section>
	);
}

/**
 * How wide a panel's header must be for its controls: what doesn't grow (the grip, the title, the
 * buttons, the JS pane's tabs) at its width, with the gaps between; what grows (the selection's name,
 * the CSS pane's Classes) can shrink to nothing.
 */
function headerLeast(panel: HTMLElement): number {
	const header = panel.querySelector<HTMLElement>(":scope > [data-wc-panel-header]");
	if (!header) return 0;
	// A menu open from it (drawn fixed) or a tip takes no room in it.
	const shown = [...header.children].filter(
		(child) =>
			child.getBoundingClientRect().width > 0 && !["fixed", "absolute"].includes(getComputedStyle(child).position),
	);
	const gap = Number.parseFloat(getComputedStyle(header).columnGap) || 0;
	return shown.reduce(
		(sum, child) =>
			sum + (Number.parseFloat(getComputedStyle(child).flexGrow) > 0 ? 0 : child.getBoundingClientRect().width),
		gap * Math.max(0, shown.length - 1),
	);
}

/**
 * A dock's panels. A side dock's stack them in the dock itself; the bottom dock's sit in a row that
 * shares the dock's width and, when they no longer fit at their least width, scrolls sideways, a
 * fade at each edge with more beyond it (FX-02).
 */
function PanelRow({ across, panels, children }: { across: boolean; panels: number; children: ReactNode }) {
	const row = useRef<HTMLDivElement>(null);
	const [more, setMore] = useState({ scrolls: false, before: false, after: false });
	// biome-ignore lint/correctness/useExhaustiveDependencies: a panel more or less is watched again.
	useLayoutEffect(() => {
		const element = row.current;
		if (across || !element) return;
		const measure = () => {
			// Each open panel is at least as wide as its header's controls, and the row scrolls only when
			// they don't fit at that width: a control drawn past its pane is never what makes it scroll.
			const style = getComputedStyle(element);
			const needed = [...element.children].reduce((sum, child) => {
				const box = child as HTMLElement;
				if (!box.hasAttribute("data-wc-panel") || box.hasAttribute("data-collapsed"))
					return sum + box.getBoundingClientRect().width;
				const least = Math.max(PANEL_MIN.bottom, headerLeast(box));
				box.style.setProperty("--wc-header-least", `${Math.ceil(least)}px`);
				return sum + least;
			}, Number.parseFloat(style.paddingInlineStart) + Number.parseFloat(style.paddingInlineEnd));
			const scrolls = needed > element.clientWidth + 1;
			if (!scrolls && element.scrollLeft !== 0) element.scrollLeft = 0;
			const scrolled = Math.abs(element.scrollLeft);
			const hidden = element.scrollWidth - element.clientWidth;
			const next = { scrolls, before: scrolls && scrolled > 1, after: scrolls && hidden - scrolled > 1 };
			setMore((was) =>
				was.scrolls === next.scrolls && was.before === next.before && was.after === next.after ? was : next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		for (const child of element.children) observer.observe(child);
		element.addEventListener("scroll", measure, { passive: true });
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", measure);
		};
	}, [across, panels]);
	if (across) return <>{children}</>;
	const fade = "from-chrome pointer-events-none absolute inset-y-0 z-10 w-6 to-transparent";
	return (
		<div className="relative flex min-w-0 grow">
			<div
				ref={row}
				className={`flex min-w-0 grow flex-row overflow-y-hidden p-2 ${
					more.scrolls
						? "[scrollbar-width:thin] [scrollbar-color:#52525b_transparent] overflow-x-auto"
						: "overflow-x-hidden"
				}`}
				data-wc-dock-row={more.scrolls ? "scrolls" : ""}
				data-more-before={more.before ? "" : undefined}
				data-more-after={more.after ? "" : undefined}
			>
				{children}
			</div>
			{more.before ? (
				<span
					aria-hidden="true"
					className={`${fade} start-0 bg-linear-to-r rtl:bg-linear-to-l`}
					data-wc-dock-more="before"
				/>
			) : null}
			{more.after ? (
				<span
					aria-hidden="true"
					className={`${fade} end-0 bg-linear-to-l rtl:bg-linear-to-r`}
					data-wc-dock-more="after"
				/>
			) : null}
		</div>
	);
}

/** What a panel's header says: the Inspector names what is selected ("Element"); the others their own name. */
function titleOf(shownPanel: ShownPanel, docks: Docks): string {
	const { words, context } = docks;
	const own = docks.titles[shownPanel.placement.id as PanelKey];
	if (own) return own;
	if (shownPanel.placement.id === "inspector" && context.selection) {
		return words.inspectorTitles[context.selection.kind];
	}
	return panelName(words, shownPanel.placement.id);
}
