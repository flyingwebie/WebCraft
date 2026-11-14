import { Link, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	DownloadIcon,
	EllipsisIcon,
	FileTextIcon,
	LayoutGridIcon,
	MoveIcon,
	PencilIcon,
	PlusIcon,
	SaveIcon,
	Share2Icon,
	TrashIcon,
} from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { ShareLinksDialog } from "../reports/ShareLinksDialog.tsx";
import { PageAside } from "../shell/page.tsx";
import { ArrangeBar, ArrangePanel, type ArrangeSaveState, KindCard, WidgetLibrary } from "./Arranging.tsx";
import {
	type CatalogKind,
	type DashboardPlace,
	type DashboardRange,
	type DashboardView,
	dashboardsApi,
	downloadCsv,
	freePlace,
	GRID_COLUMNS,
	GRID_GAP,
	placed,
	RANGE_PRESETS,
	type Rect,
	ROW_HEIGHT,
	sameRange,
	type WidgetView,
} from "./model.ts";
import { NewDashboardDialog } from "./NewDashboardDialog.tsx";
import { type Edge, titleOf, WidgetCard } from "./WidgetCard.tsx";
import { fieldsOf, needsChoice, type WidgetFields, WidgetSettingsPanel } from "./WidgetDialogs.tsx";

/** One step of arranging, which Undo takes back and Redo does again. `merge`: later changes of the same kind join it. */
type Step = { undo: () => Promise<void>; redo: () => Promise<void>; merge?: string };

/** Where Widgets are, by the key each keeps for the session (a Widget put back by Undo gets a new id). */
type Snapshot = Map<string, Rect>;

/** A drag in progress: a Widget moved by its header, resized by a handle, or a kind from the library. */
type Drag =
	| {
			type: "move";
			id: string;
			from: Rect;
			target: Rect;
			startX: number;
			startY: number;
			/** Where the card was on screen when the drag began. */
			left: number;
			top: number;
			dx: number;
			dy: number;
			lifted: boolean;
	  }
	| { type: "resize"; id: string; from: Rect; target: Rect; edge: Edge; startX: number; startY: number }
	| {
			type: "add";
			kind: CatalogKind;
			target: Rect | null;
			startX: number;
			startY: number;
			x: number;
			y: number;
			lifted: boolean;
	  };

const NEW = "__new__";
const rectOf = (widget: Rect): Rect => ({ x: widget.x, y: widget.y, w: widget.w, h: widget.h });
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * A Dashboard (SPEC 14.2), Site › Analytics or Workspace › Analytics: its header (name, who sees it,
 * the range, Compare, Reports, Share, Arrange for Staff, and a menu), then its Widgets on a grid of
 * twelve columns, rows 80 high and 16 apart (one column in reading order on a phone), each counting
 * when shown for its own days or the Dashboard's, which anyone may explore without changing it
 * (`explored`, kept in the address), and the period before when comparing.
 *
 * Arranging (SPEC 14.3, Staff) swaps the header for the arranging bar and the secondary sidebar for
 * the Widget library: kinds dragged in or clicked, Widgets dragged by the header or resized by their
 * handles, removed with an Undo toast, set up in the library's place; Undo and Redo for the session;
 * every step saved as it happens. Moving from the keyboard stays as it was, said in a live region.
 */
export function DashboardScreen({
	place,
	dashboard,
	catalog,
	explored,
	onExplore,
	compare,
	onCompare,
	creating,
	onCreating,
	workspaceName,
	sitesCount,
	listPath,
	sharing,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	catalog: readonly CatalogKind[] | null;
	explored: DashboardRange | null;
	onExplore: (range: DashboardRange | null) => void;
	/** Whether the Widgets show the period before too (kept in the address). */
	compare: boolean;
	onCompare: (compare: boolean) => void;
	/** Whether New Dashboard is open over this one (kept in the address). */
	creating: boolean;
	onCreating: (creating: boolean) => void;
	workspaceName: string;
	/** A Workspace Dashboard's: how many Sites it adds up. */
	sitesCount?: number;
	listPath: () => Promise<void>;
	/**
	 * Its Reports and Share links (#104), where the person may see them: the Reports page, whether they
	 * see and make Share links, and the language a new link's page starts in.
	 */
	sharing?: {
		reports: { to: string; params: Record<string, string> } | null;
		shareLinks: boolean;
		manageShareLinks: boolean;
		language: string;
	};
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const range = explored ?? dashboard.range;
	const [layout, setLayout] = useState(dashboard.widgets);
	const [announcement, setAnnouncement] = useState("");
	const [arranging, setArranging] = useState(false);
	const [settingsFor, setSettingsFor] = useState<string | null>(null);
	const [dialog, setDialog] = useState<"rename" | "template" | "delete" | null>(null);
	const [sharingOpen, setSharingOpen] = useState(false);
	const [preview, setPreview] = useState<{ id: string; rect: Rect } | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [settle, setSettle] = useState<{ id: string; left: number; top: number } | null>(null);
	const [flash, setFlash] = useState<string | null>(null);
	const [readout, setReadout] = useState<{ id: string; text: string } | null>(null);
	const [pending, setPending] = useState(0);
	const [failed, setFailed] = useState(false);
	const [, setHistoryVersion] = useState(0);
	const shareButton = useRef<HTMLButtonElement>(null);
	const menuButton = useRef<HTMLButtonElement>(null);
	const arrangeButton = useRef<HTMLButtonElement>(null);
	const grid = useRef<HTMLUListElement>(null);
	const isWorkspace = "workspaceId" in place;
	const kindOf = (widget: WidgetView) => catalog?.find((kind) => kind.kind === widget.kind);

	// The layout as last saved: what a failed step goes back to, and what Undo starts from.
	const saved = useRef(dashboard.widgets);
	useEffect(() => {
		saved.current = dashboard.widgets;
		setLayout(dashboard.widgets);
	}, [dashboard.widgets]);

	// Each Widget keeps a key for the session, so a Widget Undo puts back (with a new id) is still the same one.
	const keys = useRef(new Map<string, string>());
	const ids = useRef(new Map<string, string>());
	const keyOf = (widgetId: string) => keys.current.get(widgetId) ?? widgetId;
	const idOf = (key: string) => ids.current.get(key) ?? key;
	const rebind = (key: string, widgetId: string) => {
		ids.current.set(key, widgetId);
		keys.current.set(widgetId, key);
	};
	const snapshot = (widgets: readonly WidgetView[]): Snapshot =>
		new Map(widgets.map((widget) => [keyOf(widget.id), rectOf(widget)]));

	// Every change is saved one after another, so quick steps never undo each other.
	const queue = useRef<Promise<void>>(Promise.resolve());
	const run = (work: () => Promise<void>): Promise<void> => {
		setPending((count) => count + 1);
		queue.current = queue.current.then(async () => {
			try {
				await work();
				setFailed(false);
			} catch (failure) {
				setLayout(saved.current);
				setFailed(true);
				toast.error(t(errorMessage(failure)));
			} finally {
				setPending((count) => count - 1);
			}
		});
		return queue.current;
	};
	const took = (widgets: WidgetView[]) => {
		saved.current = widgets;
		setLayout(widgets);
	};

	const undoStack = useRef<Step[]>([]);
	const redoStack = useRef<Step[]>([]);
	const bump = () => setHistoryVersion((version) => version + 1);
	const record = (step: Step) => {
		const top = undoStack.current.at(-1);
		if (step.merge && top?.merge === step.merge) {
			undoStack.current = [...undoStack.current.slice(0, -1), { ...top, redo: step.redo }];
		} else {
			undoStack.current = [...undoStack.current, step];
		}
		redoStack.current = [];
		bump();
	};
	const undo = (step = undoStack.current.at(-1)) => {
		if (!step || !undoStack.current.includes(step)) return;
		undoStack.current = undoStack.current.filter((each) => each !== step);
		redoStack.current = [...redoStack.current, { ...step, merge: undefined }];
		bump();
		void run(step.undo);
	};
	const redo = () => {
		const step = redoStack.current.at(-1);
		if (!step) return;
		redoStack.current = redoStack.current.slice(0, -1);
		undoStack.current = [...undoStack.current, step];
		bump();
		void run(step.redo);
	};

	/** Puts every Widget back where a snapshot has it, one move at a time (each move only pushes others down). */
	const restore = async (target: Snapshot) => {
		const api = await dashboardsApi();
		let current = saved.current;
		const order = [...target.entries()].sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
		for (const [key, rect] of order) {
			const widget = current.find((each) => each.id === idOf(key));
			if (!widget || sameRect(widget, rect)) continue;
			current = (await api.widgets.move({ ...place, dashboardId: dashboard.id, widgetId: widget.id, ...rect }))
				.dashboard.widgets;
		}
		took(current);
	};
	/** A Widget's words and settings, to put it back as it was. */
	const contentOf = (widget: WidgetView) => ({
		kind: widget.kind,
		title: widget.title,
		range: widget.range,
		filters: widget.filters,
		settings: widget.settings,
		rows: widget.rows,
	});
	const putBack = async (key: string, content: ReturnType<typeof contentOf>, rect: Rect) => {
		const api = await dashboardsApi();
		const answer = await api.widgets.add({ ...place, dashboardId: dashboard.id, ...content, ...rect });
		rebind(key, answer.widgetId);
		took(answer.dashboard.widgets);
	};
	const takeAway = async (key: string) => {
		const api = await dashboardsApi();
		took((await api.widgets.remove({ ...place, dashboardId: dashboard.id, widgetId: idOf(key) })).dashboard.widgets);
	};

	const announcePlace = (title: string, rect: Rect) =>
		setAnnouncement(t("dashboards.moved", { title, x: rect.x + 1, y: rect.y + 1, w: rect.w, h: rect.h }));

	const move = (widget: WidgetView, rect: Rect) => {
		setLayout((before) => placed(before, widget.id, rect));
		const key = keyOf(widget.id);
		void run(async () => {
			const before = snapshot(saved.current);
			const api = await dashboardsApi();
			const answer = await api.widgets.move({ ...place, dashboardId: dashboard.id, widgetId: idOf(key), ...rect });
			took(answer.dashboard.widgets);
			const after = snapshot(answer.dashboard.widgets);
			record({ undo: () => restore(before), redo: () => restore(after) });
			const at = answer.dashboard.widgets.find((each) => each.id === idOf(key));
			if (at) announcePlace(titleOf(widget), at);
		});
	};

	const landed = (widgetId: string, kind: CatalogKind | undefined) => {
		setFlash(widgetId);
		window.setTimeout(() => setFlash((now) => (now === widgetId ? null : now)), 400);
		if (kind && needsChoice(kind)) setSettingsFor(keyOf(widgetId));
	};
	const add = (kind: CatalogKind, at?: Rect) =>
		run(async () => {
			const before = snapshot(saved.current);
			const api = await dashboardsApi();
			const answer = await api.widgets.add({ ...place, dashboardId: dashboard.id, kind: kind.kind, ...(at ?? {}) });
			took(answer.dashboard.widgets);
			const key = answer.widgetId;
			const made = answer.dashboard.widgets.find((each) => each.id === key);
			if (!made) return;
			const content = contentOf(made);
			const after = snapshot(answer.dashboard.widgets);
			record({
				undo: async () => {
					await takeAway(key);
					await restore(before);
				},
				redo: async () => {
					await putBack(key, content, after.get(key) ?? rectOf(made));
					await restore(after);
				},
			});
			setAnnouncement(t("dashboards.addedToast", { title: kind.label }));
			landed(key, kind);
		});
	const duplicate = (widget: WidgetView) =>
		run(async () => {
			const before = snapshot(saved.current);
			const api = await dashboardsApi();
			const answer = await api.widgets.duplicate({ ...place, dashboardId: dashboard.id, widgetId: widget.id });
			took(answer.dashboard.widgets);
			const key = answer.widgetId;
			const made = answer.dashboard.widgets.find((each) => each.id === key);
			if (!made) return;
			const content = contentOf(made);
			const after = snapshot(answer.dashboard.widgets);
			record({
				undo: async () => {
					await takeAway(key);
					await restore(before);
				},
				redo: async () => {
					await putBack(key, content, after.get(key) ?? rectOf(made));
					await restore(after);
				},
			});
			setAnnouncement(t("dashboards.duplicatedToast", { title: titleOf(widget) }));
			setSettingsFor(key);
			landed(key, undefined);
		});
	const remove = (widget: WidgetView) => {
		const key = keyOf(widget.id);
		const title = titleOf(widget);
		if (settingsFor === key) setSettingsFor(null);
		setLayout((before) => before.filter((each) => each.id !== widget.id));
		void run(async () => {
			const before = snapshot(saved.current);
			const content = contentOf(widget);
			const rect = before.get(key) ?? rectOf(widget);
			await takeAway(key);
			const step: Step = {
				undo: async () => {
					await putBack(key, content, rect);
					await restore(before);
				},
				redo: () => takeAway(key),
			};
			record(step);
			toast.success(t("dashboards.removedToast", { title }), {
				duration: 8000,
				action: { label: t("dashboards.undo"), onClick: () => undo(step) },
			});
		});
	};
	const change = (key: string, fields: WidgetFields) =>
		run(async () => {
			const widget = saved.current.find((each) => each.id === idOf(key));
			if (!widget) return;
			const before = fieldsOf(widget);
			const api = await dashboardsApi();
			const save = async (next: WidgetFields) => {
				const answer = await api.widgets.update({
					...place,
					dashboardId: dashboard.id,
					widgetId: idOf(key),
					...next,
					title: next.title?.trim() || null,
					...(widget.shape === "table" ? {} : { rows: undefined }),
				});
				took(answer.dashboard.widgets);
			};
			await save(fields);
			record({ undo: () => save(before), redo: () => save(fields), merge: `settings:${key}` });
		});

	const startArranging = () => {
		setArranging(true);
		setSettingsFor(null);
		undoStack.current = [];
		redoStack.current = [];
		bump();
	};
	const done = async () => {
		await queue.current;
		setArranging(false);
		setSettingsFor(null);
		await router.invalidate();
		window.setTimeout(() => arrangeButton.current?.focus(), 0);
	};
	useEffect(() => {
		if (!arranging) return;
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable]")) return;
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const key = event.key.toLowerCase();
			if (key === "z" && !event.shiftKey) {
				event.preventDefault();
				undo();
			} else if ((key === "z" && event.shiftKey) || key === "y") {
				event.preventDefault();
				redo();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// The grid's cells on screen, from its columns and the rows as drawn (a row may grow with what it holds).
	const geometry = () => {
		const element = grid.current;
		if (!element) return null;
		const box = element.getBoundingClientRect();
		const column = (box.width + GRID_GAP) / GRID_COLUMNS;
		const tracks = getComputedStyle(element)
			.gridTemplateRows.split(" ")
			.map((size) => Number.parseFloat(size))
			.filter((size) => Number.isFinite(size));
		const starts: number[] = [];
		let at = 0;
		for (const size of tracks) {
			starts.push(at);
			at += size + GRID_GAP;
		}
		const rowAt = (offset: number) => {
			let best = 0;
			for (let index = 0; index < starts.length; index++) {
				if (Math.abs((starts[index] ?? 0) - offset) < Math.abs((starts[best] ?? 0) - offset)) best = index;
			}
			const beyond = offset - at;
			return beyond > 0 ? starts.length + Math.round(beyond / (ROW_HEIGHT + GRID_GAP)) : best;
		};
		const rtl = document.documentElement.dir === "rtl";
		const columnAt = (clientX: number) => Math.round((rtl ? box.right - clientX : clientX - box.left) / column);
		return { box, column, rowAt, columnAt, rtl };
	};

	const dragRef = useRef<Drag | null>(null);
	dragRef.current = drag;
	const follow = (handlers: { move: (event: PointerEvent) => void; up: (event: PointerEvent) => void }) => {
		const onMove = (event: PointerEvent) => handlers.move(event);
		const onUp = (event: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			handlers.up(event);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	};

	const lift = (widget: WidgetView, event: ReactPointerEvent<HTMLElement>) => {
		if (event.button !== 0) return;
		const card = (event.currentTarget as HTMLElement).closest("li");
		if (!card) return;
		const box = card.getBoundingClientRect();
		const from = rectOf(widget);
		setDrag({
			type: "move",
			id: widget.id,
			from,
			target: from,
			startX: event.clientX,
			startY: event.clientY,
			left: box.left,
			top: box.top,
			dx: 0,
			dy: 0,
			lifted: false,
		});
		follow({
			move: (moving) => {
				const current = dragRef.current;
				const cells = geometry();
				if (current?.type !== "move" || !cells) return;
				const dx = moving.clientX - current.startX;
				const dy = moving.clientY - current.startY;
				if (!current.lifted && Math.hypot(dx, dy) < 4) return;
				const left = current.left + dx;
				const x = cells.rtl
					? Math.round((cells.box.right - (left + box.width)) / cells.column)
					: Math.round((left - cells.box.left) / cells.column);
				const y = cells.rowAt(current.top + dy - cells.box.top);
				const target = {
					...current.from,
					x: Math.min(Math.max(x, 0), GRID_COLUMNS - current.from.w),
					y: Math.max(0, y),
				};
				setDrag({ ...current, dx, dy, target, lifted: true });
			},
			up: () => {
				const current = dragRef.current;
				setDrag(null);
				if (current?.type !== "move" || !current.lifted) return;
				setSettle({ id: current.id, left: current.left + current.dx, top: current.top + current.dy });
				if (!sameRect(current.target, current.from)) move(widget, current.target);
			},
		});
	};

	const resize = (widget: WidgetView, event: ReactPointerEvent<HTMLElement>, edge: Edge) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const from = rectOf(widget);
		const show = (rect: Rect) =>
			setReadout({ id: widget.id, text: t("dashboards.sizeReadout", { w: rect.w, of: GRID_COLUMNS, h: rect.h }) });
		setDrag({ type: "resize", id: widget.id, from, target: from, edge, startX: event.clientX, startY: event.clientY });
		show(from);
		follow({
			move: (moving) => {
				const current = dragRef.current;
				const cells = geometry();
				if (current?.type !== "resize" || !cells) return;
				const dx = Math.round(((moving.clientX - current.startX) * (cells.rtl ? -1 : 1)) / cells.column);
				const dy = Math.round((moving.clientY - current.startY) / (ROW_HEIGHT + GRID_GAP));
				const w = current.edge === "height" ? current.from.w : current.from.w + dx;
				const h = current.edge === "width" ? current.from.h : current.from.h + dy;
				const target = {
					...current.from,
					w: Math.min(Math.max(w, 2), GRID_COLUMNS - current.from.x),
					h: Math.min(Math.max(h, 2), 12),
				};
				if (sameRect(target, current.target)) return;
				setDrag({ ...current, target });
				show(target);
			},
			up: () => {
				const current = dragRef.current;
				setDrag(null);
				window.setTimeout(() => setReadout((now) => (now?.id === widget.id ? null : now)), 1500);
				if (current?.type === "resize" && !sameRect(current.target, current.from)) move(widget, current.target);
			},
		});
	};

	const dragged = useRef(false);
	const fromLibrary = (kind: CatalogKind, event: ReactPointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0 || !kind.available) return;
		dragged.current = false;
		setDrag({
			type: "add",
			kind,
			target: null,
			startX: event.clientX,
			startY: event.clientY,
			x: event.clientX,
			y: event.clientY,
			lifted: false,
		});
		follow({
			move: (moving) => {
				const current = dragRef.current;
				const cells = geometry();
				if (current?.type !== "add" || !cells) return;
				if (!current.lifted && Math.hypot(moving.clientX - current.startX, moving.clientY - current.startY) < 4) return;
				dragged.current = true;
				const inside =
					moving.clientX >= cells.box.left &&
					moving.clientX <= cells.box.right &&
					moving.clientY >= cells.box.top - 40 &&
					moving.clientY <= cells.box.bottom + 4 * (ROW_HEIGHT + GRID_GAP);
				const size = current.kind.size;
				const x = Math.min(Math.max(Math.floor(cells.columnAt(moving.clientX) - 0.5), 0), GRID_COLUMNS - size.w);
				const y = Math.max(0, cells.rowAt(moving.clientY - cells.box.top - 24));
				setDrag({
					...current,
					lifted: true,
					x: moving.clientX,
					y: moving.clientY,
					target: inside ? { x, y, w: size.w, h: size.h } : null,
				});
			},
			up: () => {
				const current = dragRef.current;
				setDrag(null);
				if (current?.type === "add" && current.lifted && current.target) void add(current.kind, current.target);
			},
		});
	};
	const clickLibrary = (kind: CatalogKind) => {
		if (dragged.current) {
			dragged.current = false;
			return;
		}
		void add(kind, freePlace(saved.current, kind.size));
	};

	// What the grid shows: the layout, with a drag, a resize or a step from the keyboard shown before it is saved.
	let shown: WidgetView[] = layout;
	let slot: { rect: Rect; label: string } | null = null;
	if (drag?.type === "move" && drag.lifted) {
		shown = placed(layout, drag.id, drag.target).map((widget) =>
			widget.id === drag.id ? { ...widget, ...drag.from } : widget,
		);
		slot = { rect: drag.target, label: t("dashboards.dropHere") };
	} else if (drag?.type === "resize") {
		shown = placed(layout, drag.id, drag.target);
	} else if (drag?.type === "add" && drag.target) {
		const phantom = { ...drag.target, id: NEW } as WidgetView;
		shown = placed([...layout, phantom], NEW, drag.target).filter((widget) => widget.id !== NEW);
		slot = { rect: drag.target, label: t("dashboards.landsHere", { title: drag.kind.label }) };
	} else if (preview) {
		shown = placed(layout, preview.id, preview.rect);
	}
	const ordered = [...shown].sort((a, b) => a.y - b.y || a.x - b.x);
	const bottom = shown.reduce((most, widget) => Math.max(most, widget.y + widget.h), 0);
	const settingsWidget = settingsFor ? layout.find((widget) => widget.id === idOf(settingsFor)) : undefined;
	const presetLabel = (value: DashboardRange) =>
		value.preset === "custom" ? `${value.from} – ${value.to}` : t(`dashboards.presets.${value.preset}`);
	const saveState: ArrangeSaveState = pending > 0 ? "saving" : failed ? "failed" : "saved";

	const exportAll = async () => {
		try {
			const api = await dashboardsApi();
			const file = await api.export({ ...place, dashboardId: dashboard.id, range: explored ?? undefined });
			downloadCsv(file);
			toast.success(t("dashboards.exportedToast", { filename: file.filename }));
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const share = async (sharedWithEveryone: boolean) => {
		try {
			const api = await dashboardsApi();
			await api.update({ ...place, dashboardId: dashboard.id, sharedWithEveryone });
			toast.success(t(sharedWithEveryone ? "dashboards.sharedToast" : "dashboards.unsharedToast"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const keepRange = async () => {
		try {
			const api = await dashboardsApi();
			await api.update({ ...place, dashboardId: dashboard.id, range });
			toast.success(t("dashboards.rangeSavedToast"));
			onExplore(null);
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	return (
		<>
			{arranging && catalog ? (
				<PageAside>
					<ArrangePanel label={settingsWidget ? t("dashboards.settingsLabel") : t("dashboards.library.label")}>
						{settingsWidget && settingsFor ? (
							<WidgetSettingsPanel
								key={settingsFor}
								place={place}
								widget={settingsWidget}
								kind={kindOf(settingsWidget)}
								onChange={(fields) => void change(settingsFor, fields)}
								onBack={() => setSettingsFor(null)}
								onDuplicate={() => void duplicate(settingsWidget)}
								onRemove={() => remove(settingsWidget)}
							/>
						) : (
							<WidgetLibrary catalog={catalog} onAdd={clickLibrary} onDragStart={fromLibrary} />
						)}
					</ArrangePanel>
				</PageAside>
			) : null}
			{arranging ? (
				<ArrangeBar
					name={dashboard.name}
					state={saveState}
					canUndo={undoStack.current.length > 0}
					canRedo={redoStack.current.length > 0}
					onUndo={() => undo()}
					onRedo={redo}
					onDone={() => void done()}
				/>
			) : (
				<DashboardHeader
					heading={dashboard.name}
					badge={
						<Badge variant="outline" className="font-normal">
							{t(dashboard.sharedWithEveryone ? "dashboards.badgeEveryone" : "dashboards.shownViewers")}
						</Badge>
					}
					action={
						<>
							<RangePicker
								id={`${id}-range`}
								range={range}
								onChange={(next) => onExplore(sameRange(next, dashboard.range) ? null : next)}
							/>
							{explored && dashboard.canManage ? (
								<Button variant="outline" onClick={keepRange}>
									{t("dashboards.saveRange")}
								</Button>
							) : null}
							<CompareSwitch id={`${id}-compare`} checked={compare} onChange={onCompare} />
							{sharing?.reports ? (
								<Button
									variant="outline"
									className="gap-1"
									render={<Link to={sharing.reports.to} params={sharing.reports.params} />}
								>
									<FileTextIcon aria-hidden="true" />
									{t("dashboards.reports")}
								</Button>
							) : null}
							{sharing?.shareLinks ? (
								<Button ref={shareButton} variant="outline" className="gap-1" onClick={() => setSharingOpen(true)}>
									<Share2Icon aria-hidden="true" />
									{t("dashboards.share")}
								</Button>
							) : null}
							{dashboard.canManage && catalog ? (
								<Button
									ref={arrangeButton}
									variant="outline"
									className="hidden gap-1 md:inline-flex"
									onClick={startArranging}
								>
									<MoveIcon aria-hidden="true" />
									{t("dashboards.arrange")}
								</Button>
							) : null}
							<DropdownMenu>
								<DropdownMenuTrigger
									ref={menuButton}
									render={<Button variant="ghost" size="icon-sm" aria-label={t("dashboards.menu")} />}
								>
									<EllipsisIcon aria-hidden="true" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-auto min-w-56">
									<DropdownMenuItem onClick={exportAll}>
										<DownloadIcon aria-hidden="true" />
										{t("dashboards.exportCsv")}
									</DropdownMenuItem>
									{dashboard.canManage ? (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem onClick={() => setDialog("rename")}>
												<PencilIcon aria-hidden="true" />
												{t("dashboards.rename")}
											</DropdownMenuItem>
											<DropdownMenuCheckboxItem
												checked={dashboard.sharedWithEveryone}
												onCheckedChange={(checked) => share(checked)}
											>
												{t("dashboards.badgeEveryone")}
											</DropdownMenuCheckboxItem>
											<DropdownMenuItem onClick={() => setDialog("template")}>
												<SaveIcon aria-hidden="true" />
												{t("dashboards.saveTemplate")}
											</DropdownMenuItem>
											{dashboard.builtIn ? null : (
												<>
													<DropdownMenuSeparator />
													<DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
														<TrashIcon aria-hidden="true" />
														{t("dashboards.delete")}
													</DropdownMenuItem>
												</>
											)}
										</>
									) : null}
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					}
				>
					{isWorkspace ? t("dashboards.addsUp", { count: sitesCount ?? 0, workspace: workspaceName }) : undefined}
				</DashboardHeader>
			)}
			<p role="status" aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{ordered.length === 0 && !arranging ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
					<span className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg border">
						<LayoutGridIcon aria-hidden="true" className="size-5" />
					</span>
					<p className="font-medium">{t(dashboard.canManage ? "dashboards.emptyManageTitle" : "dashboards.empty")}</p>
					{dashboard.canManage && catalog ? (
						<Button className="hidden md:inline-flex" onClick={startArranging}>
							<PlusIcon aria-hidden="true" />
							{t("dashboards.addWidget")}
						</Button>
					) : null}
				</div>
			) : (
				<div className="relative">
					{arranging ? (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 hidden grid-cols-12 gap-4 @3xl/page:grid"
						>
							{Array.from({ length: GRID_COLUMNS }, (_, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: the grid's columns, in a fixed order.
								<span key={index} className="bg-muted/60 rounded-md" />
							))}
						</div>
					) : null}
					<ul
						ref={grid}
						aria-label={t("dashboards.gridLabel", { name: dashboard.name })}
						className="relative grid grid-cols-1 content-start gap-4 @3xl/page:auto-rows-[minmax(5rem,auto)] @3xl/page:grid-cols-12"
						style={arranging ? { minHeight: (bottom + 4) * (ROW_HEIGHT + GRID_GAP) - GRID_GAP } : undefined}
					>
						{ordered.map((widget) => (
							<WidgetCard
								key={widget.id}
								place={place}
								dashboardId={dashboard.id}
								widget={widget}
								rect={rectOf(widget)}
								explored={explored}
								compare={compare}
								nowLabel={presetLabel(range)}
								arranging={arranging}
								lifted={
									drag?.type === "move" && drag.lifted && drag.id === widget.id ? { dx: drag.dx, dy: drag.dy } : null
								}
								settleFrom={settle?.id === widget.id ? settle : null}
								selected={settingsFor !== null && idOf(settingsFor) === widget.id}
								flash={flash === widget.id}
								readout={readout?.id === widget.id ? readout.text : null}
								onPreview={(rect) => setPreview(rect ? { id: widget.id, rect } : null)}
								onMove={(rect) => move(widget, rect)}
								onAnnounce={setAnnouncement}
								onLift={(event) => lift(widget, event)}
								onResize={(event, edge) => resize(widget, event, edge)}
								onSettings={() => setSettingsFor((now) => (now === keyOf(widget.id) ? null : keyOf(widget.id)))}
								onRemove={() => remove(widget)}
							/>
						))}
						{slot ? (
							<li
								aria-hidden="true"
								className="border-primary text-muted-foreground [grid-column:var(--wc-x)_/_span_var(--wc-w)] [grid-row:var(--wc-y)_/_span_var(--wc-h)] flex items-center justify-center rounded-[14px] border-2 border-dashed bg-[color-mix(in_oklab,var(--primary)_7%,var(--background))] text-sm font-medium"
								style={
									{
										"--wc-x": slot.rect.x + 1,
										"--wc-w": slot.rect.w,
										"--wc-y": slot.rect.y + 1,
										"--wc-h": slot.rect.h,
									} as Record<string, number>
								}
							>
								{slot.label}
							</li>
						) : null}
					</ul>
				</div>
			)}
			{drag?.type === "add" && drag.lifted
				? createPortal(
						<div
							aria-hidden="true"
							className="bg-popover text-popover-foreground border-primary pointer-events-none fixed z-50 rounded-md border px-2 py-1.5 shadow-lg"
							style={{ left: drag.x - 16, top: drag.y - 18 }}
						>
							<KindCard kind={drag.kind} />
						</div>,
						document.body,
					)
				: null}
			{creating ? <NewDashboardDialog place={place} onClose={() => onCreating(false)} /> : null}
			{sharingOpen && sharing ? (
				<ShareLinksDialog
					place={place}
					dashboardId={dashboard.id}
					canManage={sharing.manageShareLinks}
					language={sharing.language}
					onClose={() => setSharingOpen(false)}
					finalFocus={shareButton}
				/>
			) : null}
			{dialog === "rename" ? (
				<RenameDialog place={place} dashboard={dashboard} onClose={() => setDialog(null)} finalFocus={menuButton} />
			) : null}
			{dialog === "template" ? (
				<TemplateDialog
					place={place}
					dashboard={dashboard}
					workspaceName={workspaceName}
					onClose={() => setDialog(null)}
					finalFocus={menuButton}
				/>
			) : null}
			{dialog === "delete" ? (
				<DeleteDialog
					place={place}
					dashboard={dashboard}
					onClose={() => setDialog(null)}
					finalFocus={menuButton}
					onDeleted={listPath}
				/>
			) : null}
		</>
	);
}

/**
 * The Dashboard's header: the page header's parts (the H1 with who sees it beside it, one line under
 * it, the actions on the right), on one line wherever they fit, as the frame draws it: the name gives
 * way before the actions wrap.
 */
function DashboardHeader({
	heading,
	badge,
	action,
	children,
}: {
	heading: string;
	badge: ReactNode;
	action: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="mb-6 flex flex-wrap items-start justify-between gap-x-3 gap-y-3 @4xl/page:flex-nowrap">
			<div className="min-w-0 space-y-1">
				<div className="flex min-h-9 min-w-0 items-center gap-x-3">
					<h1 className="truncate text-2xl font-semibold tracking-tight">{heading}</h1>
					<span className="shrink-0">{badge}</span>
				</div>
				{children ? <p className="text-muted-foreground text-base">{children}</p> : null}
			</div>
			<div className="flex flex-wrap items-center gap-2 @4xl/page:shrink-0 @4xl/page:flex-nowrap">{action}</div>
		</div>
	);
}

/** The range: one of the eight presets, or two days (custom). */
function RangePicker({
	id,
	range,
	onChange,
}: {
	id: string;
	range: DashboardRange;
	onChange: (range: DashboardRange) => void;
}) {
	const t = useT();
	const today = new Date().toISOString().slice(0, 10);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<NativeSelect
				id={id}
				aria-label={t("dashboards.rangeLabel")}
				className="w-37"
				value={range.preset}
				onChange={(event) => {
					const preset = event.target.value;
					onChange(
						preset === "custom"
							? {
									preset: "custom",
									from: range.preset === "custom" ? range.from : today,
									to: range.preset === "custom" ? range.to : today,
								}
							: { preset: preset as (typeof RANGE_PRESETS)[number] },
					);
				}}
			>
				{RANGE_PRESETS.map((preset) => (
					<NativeSelectOption key={preset} value={preset}>
						{t(`dashboards.presets.${preset}`)}
					</NativeSelectOption>
				))}
				<NativeSelectOption value="custom">{t("dashboards.presets.custom")}</NativeSelectOption>
			</NativeSelect>
			{range.preset === "custom" ? (
				<>
					<Input
						type="date"
						aria-label={t("dashboards.customFrom")}
						className="w-auto"
						value={range.from}
						max={range.to}
						onChange={(event) => event.target.value && onChange({ ...range, from: event.target.value })}
					/>
					<Input
						type="date"
						aria-label={t("dashboards.customTo")}
						className="w-auto"
						value={range.to}
						min={range.from}
						onChange={(event) => event.target.value && onChange({ ...range, to: event.target.value })}
					/>
				</>
			) : null}
		</div>
	);
}

/** Compare: a switch with its word, which asks every Widget that compares for the period before too. */
function CompareSwitch({
	id,
	checked,
	onChange,
}: {
	id: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	const t = useT();
	return (
		<div className="flex items-center gap-1.5">
			<label htmlFor={id} className="text-muted-foreground cursor-pointer text-sm">
				{t("dashboards.compare")}
			</label>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				onClick={() => onChange(!checked)}
				className={cn(
					"focus-visible:ring-ring/50 relative inline-flex h-[1.125rem] w-8 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-3",
					checked ? "bg-primary" : "bg-input dark:bg-input/80",
				)}
			>
				<span
					aria-hidden="true"
					className={cn(
						"bg-background block size-3.5 rounded-full shadow-sm transition-transform",
						checked ? "translate-x-[0.9375rem] rtl:-translate-x-[0.9375rem]" : "translate-x-px rtl:-translate-x-px",
					)}
				/>
			</button>
		</div>
	);
}

function RenameDialog({
	place,
	dashboard,
	onClose,
	finalFocus,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(dashboard.name);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		try {
			const api = await dashboardsApi();
			await api.update({ ...place, dashboardId: dashboard.id, name: name.trim() });
			toast.success(t("dashboards.renamedToast"));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus}>
				<form onSubmit={save}>
					<DialogHeader>
						<DialogTitle>{t("dashboards.renameTitle")}</DialogTitle>
						<DialogDescription>{t("dashboards.renameIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6">
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("dashboards.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								required
								maxLength={100}
								onChange={(change) => setName(change.target.value)}
							/>
						</Field>
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("dashboards.cancel")}</DialogClose>
						<Button type="submit">{t("dashboards.save")}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function TemplateDialog({
	place,
	dashboard,
	workspaceName,
	onClose,
	finalFocus,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	workspaceName: string;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const [name, setName] = useState(dashboard.name);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		try {
			const api = await dashboardsApi();
			await api.saveAsTemplate({ ...place, dashboardId: dashboard.id, name: name.trim() });
			toast.success(t("dashboards.templateSavedToast"));
			onClose();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus}>
				<form onSubmit={save}>
					<DialogHeader>
						<DialogTitle>{t("dashboards.saveTemplateTitle")}</DialogTitle>
						<DialogDescription>{t("dashboards.saveTemplateIntro", { workspace: workspaceName })}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6">
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("dashboards.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								required
								maxLength={100}
								onChange={(change) => setName(change.target.value)}
							/>
						</Field>
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("dashboards.cancel")}</DialogClose>
						<Button type="submit">{t("dashboards.saveTemplate")}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DeleteDialog({
	place,
	dashboard,
	onClose,
	finalFocus,
	onDeleted,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
	onDeleted: () => Promise<void>;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const cancel = useRef<HTMLButtonElement>(null);
	const remove = async () => {
		setBusy(true);
		try {
			const api = await dashboardsApi();
			await api.delete({ ...place, dashboardId: dashboard.id });
			toast.success(t("dashboards.deletedToast"));
			onClose();
			await onDeleted();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus} initialFocus={cancel}>
				<DialogHeader>
					<DialogTitle>{t("dashboards.deleteTitle", { name: dashboard.name })}</DialogTitle>
					<DialogDescription>{t("dashboards.deleteIntro")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose ref={cancel} render={<Button variant="outline" />}>
						{t("dashboards.cancel")}
					</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy}>
						{t("dashboards.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
