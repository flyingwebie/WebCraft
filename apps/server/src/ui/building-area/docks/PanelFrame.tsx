import { ChevronDownIcon, EllipsisIcon, GripVerticalIcon } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useId,
	useRef,
	useState,
} from "react";

import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../controls.tsx";
import { ChromeMenu, type MenuEntry } from "./Menu.tsx";

/** A small icon button of a panel's header (24 × 24, its icon 14): its actions, its menu, Expand. */
export function PanelButton({
	icon: Glyph,
	label,
	onClick,
	menu,
	buttonRef,
	align = "center",
	data,
}: {
	icon: Icon;
	label: string;
	/** Its tooltip: centred under it, or ending with it (the last button of a header). */
	align?: "center" | "end";
	onClick(): void;
	/** It opens a menu: whether that menu is open, and the menu's id. */
	menu?: { open: boolean; id: string };
	buttonRef?: React.Ref<HTMLButtonElement>;
	data?: Record<`data-${string}`, string>;
}) {
	return (
		<button
			ref={buttonRef}
			type="button"
			aria-label={label}
			aria-haspopup={menu ? "menu" : undefined}
			aria-expanded={menu ? menu.open : undefined}
			aria-controls={menu?.open ? menu.id : undefined}
			onClick={onClick}
			className={`group text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong relative inline-grid size-6 shrink-0 place-items-center rounded-[5px] ${
				menu?.open ? "bg-chrome-hover text-chrome-strong" : ""
			} ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<Glyph aria-hidden="true" className="size-3.5" />
			<Tip label={label} side="bottom" align={align} />
		</button>
	);
}

/**
 * One panel of a dock (SPEC 5, `docking/02`, `docking/05`): a header (28 high in a side dock, 36 in
 * the bottom one) with the grip that moves it, its title, its actions and its menu ("Move to left /
 * right / bottom dock", "Collapse" or "Expand", "Hide panel", "Reset panel layout"), then its body.
 * Collapsed, it is its header only, with an Expand button. The grip is for the pointer; the menu is
 * the same for the keyboard and touch.
 */
export function PanelFrame({
	id,
	kind,
	title,
	sub,
	collapsed,
	labels,
	menuEntries,
	actions,
	style,
	lifted,
	onGrip,
	onExpand,
	children,
}: {
	id: string;
	/** `side`: in the left or right dock; `bottom`: a pane of the bottom dock. */
	kind: "side" | "bottom";
	title: string;
	/** Beside the title, muted: what the panel shows now (`h1 · Heading`). */
	sub?: string;
	collapsed: boolean;
	labels: { menu: string; expand: string; grip: string };
	menuEntries: readonly MenuEntry[];
	actions?: ReactNode;
	style?: CSSProperties;
	/** In the air: the panel is being moved, so it shows faded where it was. */
	lifted?: boolean;
	/** The pointer went down on the grip. */
	onGrip(event: ReactPointerEvent<HTMLElement>): void;
	onExpand(): void;
	children?: ReactNode;
}) {
	const titleId = useId();
	const menuId = useId();
	const [open, setOpen] = useState(false);
	const menuButton = useRef<HTMLButtonElement>(null);
	const close = useCallback((focusButton: boolean) => {
		setOpen(false);
		if (focusButton) menuButton.current?.focus();
	}, []);
	const side = kind === "side";

	return (
		<section
			aria-labelledby={titleId}
			style={style}
			className={`flex min-h-0 min-w-0 flex-col gap-1.5 ${lifted ? "opacity-40" : ""}`}
			data-wc-panel={id}
			data-collapsed={collapsed ? "" : undefined}
		>
			<div className={`flex shrink-0 items-center ${side ? "h-7 gap-1.5" : "h-9 gap-1"}`} data-wc-panel-header="">
				<span
					aria-hidden="true"
					onPointerDown={onGrip}
					className={`group text-chrome-faint hover:bg-chrome-hover hover:text-chrome-strong relative grid h-5 w-4 shrink-0 cursor-grab touch-none place-items-center rounded-[4px] active:cursor-grabbing ${CHROME_EASE}`}
					data-wc-grip={id}
				>
					<GripVerticalIcon className="size-3.5" />
					<Tip label={labels.grip} side="bottom" />
				</span>
				<h2 id={titleId} className="text-chrome-strong shrink-0 text-[12px] font-semibold">
					{title}
				</h2>
				<span className="text-chrome-muted min-w-0 grow truncate text-[12px]">{sub}</span>
				{collapsed ? null : actions}
				{collapsed ? (
					<PanelButton
						icon={ChevronDownIcon}
						label={labels.expand}
						onClick={onExpand}
						data={{ "data-wc-panel-expand": id }}
					/>
				) : null}
				<PanelButton
					icon={EllipsisIcon}
					label={labels.menu}
					onClick={() => setOpen((was) => !was)}
					menu={{ open, id: menuId }}
					buttonRef={menuButton}
					align="end"
					data={{ "data-wc-panel-menu": id }}
				/>
				<ChromeMenu
					open={open}
					onClose={close}
					anchor={menuButton}
					placement="below"
					label={labels.menu}
					entries={menuEntries}
					id={menuId}
				/>
			</div>
			{collapsed ? null : (
				<div
					className={`flex min-h-0 grow flex-col ${side ? "" : "bg-chrome-well rounded-lg"}`}
					data-wc-panel-body={id}
				>
					{children}
				</div>
			)}
		</section>
	);
}
