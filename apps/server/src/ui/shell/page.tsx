import { useBlocker, useMatches } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@webcraft/ui/components/sheet.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n.tsx";

/**
 * The pieces every admin screen is made of, inside the shell's page card: the page header, the three
 * column widths, the secondary sidebar's slot, the foot bar of a settings form with its guard, and
 * the sheet that covers the page. `docs/development.md` › "Admin screens" says how a screen uses them.
 */

/** The three widths of a page's column: `form` 720 px, `default` 1040 px, `wide` all of the main column. */
export type PageWidth = "form" | "default" | "wide";

const COLUMN_WIDTHS: Record<PageWidth, string> = {
	form: "max-w-180",
	default: "max-w-260",
	wide: "max-w-none",
};

/** The width the routes on screen ask for (`staticData.width`): the deepest one that says so. */
export function useRouteWidth(): PageWidth {
	return useMatches({
		select: (matches) =>
			matches
				.map((match) => match.staticData.width)
				.filter((width): width is PageWidth => Boolean(width))
				.at(-1) ?? "default",
	});
}

/**
 * A column at one of the three widths, left aligned. The shell already gives every screen the width
 * its route asks for; use this for a part of a wider screen that should stop sooner, such as a form
 * on a `wide` page.
 */
export function PageColumn({ width = "default", className, ...props }: ComponentProps<"div"> & { width?: PageWidth }) {
	return <div data-page-width={width} className={cn("w-full", COLUMN_WIDTHS[width], className)} {...props} />;
}

/**
 * A page's header: its H1, one line about it, and its actions on the right (the main one last).
 * `badge` sits beside the H1, such as who a Dashboard is shown to.
 */
export function PageHeader({
	heading,
	children,
	action,
	badge,
}: {
	heading: string;
	/** The one line under the heading. */
	children?: ReactNode;
	/** The page's actions: buttons, the main one last. */
	action?: ReactNode;
	badge?: ReactNode;
}) {
	return (
		// The actions stay on the H1's line, and the line about the page wraps under the H1 only. When the
		// column is too narrow for both (a phone), the actions move under the text.
		<div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
			<div className="min-w-0 flex-1 basis-64 space-y-1">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
					{badge}
				</div>
				{children ? <p className="text-muted-foreground text-base">{children}</p> : null}
			</div>
			{action ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
		</div>
	);
}

/** The parts of the page card a screen can put something into, from wherever it renders. */
type PageRegions = {
	/** The page card under the top bar: a `PageSheet` and its dark layer cover it. */
	cover: HTMLElement | null;
	/** The foot of the page's column, under what scrolls: a `SaveBar` sits here. */
	foot: HTMLElement | null;
	/** Beside the page, where the secondary sidebar is: a `PageAside` takes its place. */
	aside: HTMLElement | null;
	/** Says a screen shows its own secondary sidebar; call what it answers when the screen stops. */
	claimAside(): () => void;
};

const PageRegionsContext = createContext<PageRegions | null>(null);

/** The shell gives the page card's parts to the screens inside it. */
export const PageRegionsProvider = PageRegionsContext.Provider;

function usePageRegions(): PageRegions {
	const regions = useContext(PageRegionsContext);
	if (!regions) throw new Error("This piece of a page must be used inside the admin shell.");
	return regions;
}

/**
 * Shows a screen's own secondary sidebar where the navigation's is, for as long as it is rendered: a
 * list that belongs to one screen, or a panel that takes the secondary sidebar's place for a while (so
 * nothing on the page moves). Put a `SecondarySidebar` inside.
 */
export function PageAside({ children }: { children: ReactNode }) {
	const { aside, claimAside } = usePageRegions();
	useEffect(() => claimAside(), [claimAside]);
	return aside ? createPortal(children, aside) : null;
}

/** Puts something at the foot of the page's column, under what scrolls. `SaveBar` uses it. */
export function PageFoot({ children }: { children: ReactNode }) {
	const { foot } = usePageRegions();
	return foot ? createPortal(children, foot) : null;
}

/** Where a settings form stands: nothing changed, changed, being saved, saved, or its save failed. */
export type SaveState = "clean" | "dirty" | "saving" | "saved" | "failed";

/**
 * The one bar at the foot of a settings form: what state the form is in ("No changes", "Unsaved
 * changes", "Saving…", "Saved", "Could not save"), Discard while there is something to discard, and
 * Save, disabled until something changed. While changes are not saved it also asks before the person
 * leaves the screen (`LeaveGuard`). Save submits the form named by `form` (its `id`), or calls `onSave`.
 */
export function SaveBar({
	state,
	onDiscard,
	onSave,
	form,
}: {
	state: SaveState;
	/** Puts the form back as it was last saved. */
	onDiscard: () => void;
	onSave?: () => void;
	/** The `id` of the form Save submits. */
	form?: string;
}) {
	const t = useT();
	const unsaved = state === "dirty" || state === "failed";
	return (
		<>
			<LeaveGuard when={unsaved || state === "saving"} />
			<PageFoot>
				<section
					aria-label={t("shell.saveBar.label")}
					data-slot="save-bar"
					data-state={state}
					className="bg-background flex h-16 items-center gap-3 border-t px-4 md:px-8"
				>
					<p
						role="status"
						className={cn(
							"min-w-0 flex-1 truncate text-sm",
							state === "failed" ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{t(`shell.saveBar.${state}`)}
					</p>
					{unsaved ? (
						<Button type="button" variant="outline" onClick={onDiscard}>
							{t("shell.saveBar.discard")}
						</Button>
					) : null}
					<Button
						type={form ? "submit" : "button"}
						form={form}
						variant={state === "failed" ? "destructive" : "default"}
						disabled={!unsaved}
						onClick={form ? undefined : onSave}
					>
						{t(state === "failed" ? "shell.saveBar.retry" : "shell.saveBar.save")}
					</Button>
				</section>
			</PageFoot>
		</>
	);
}

/**
 * Asks before the person leaves a screen with changes that are not saved: on a link or the browser's
 * back button it shows a dialog (focus on "Keep editing"), and the browser asks in its own words
 * before the tab closes or reloads. Moving within the same screen (a tab in the address) never asks.
 */
export function LeaveGuard({ when }: { when: boolean }) {
	const t = useT();
	const blocker = useBlocker({
		shouldBlockFn: ({ current, next }) => when && current.pathname !== next.pathname,
		enableBeforeUnload: when,
		withResolver: true,
	});
	const stay = useRef<HTMLButtonElement>(null);
	if (blocker.status !== "blocked") return null;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) blocker.reset();
			}}
		>
			<DialogContent closeLabel={t("shell.leaveGuard.close")} initialFocus={stay} showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>{t("shell.leaveGuard.title")}</DialogTitle>
					<DialogDescription>{t("shell.leaveGuard.body")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button ref={stay} type="button" variant="outline" onClick={blocker.reset}>
						{t("shell.leaveGuard.stay")}
					</Button>
					<Button type="button" variant="destructive" onClick={blocker.proceed}>
						{t("shell.leaveGuard.leave")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * A sheet for one record or a short task (Publish all, a Review, Add Goal, Share links). It opens at
 * once from the right edge of the page card and covers the page under a dark layer; the page behind
 * never reflows, and the sidebar and the top bar stay as they are. The sheet is a dialog: focus stays
 * in it, Escape and a click on the dark layer close it, and focus goes back to what opened it.
 * `footer` holds its buttons, the main one last.
 */
export function PageSheet({
	open,
	onOpenChange,
	title,
	description,
	footer,
	children,
	finalFocus,
	className,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
	/** What takes focus when the sheet closes, when it is not what opened it. */
	finalFocus?: RefObject<HTMLElement | null>;
	className?: string;
}) {
	const t = useT();
	const { cover } = usePageRegions();
	return (
		// The page card is there once the shell has rendered in the browser: a sheet that is open from
		// the start (the screen's address names it) opens as soon as the card it covers is there.
		<Sheet open={open && cover !== null} onOpenChange={onOpenChange}>
			<SheetContent
				container={cover}
				finalFocus={finalFocus}
				closeLabel={t("shell.sheet.close")}
				// Inside the page card, not the window: the layer and the sheet cover the card under the top bar.
				overlayClassName="absolute z-30 bg-black/40 duration-0"
				className={cn(
					"absolute z-30 w-full gap-0 duration-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md",
					className,
				)}
			>
				<div className="shrink-0 space-y-1 border-b p-5 pe-14">
					<SheetTitle className="text-base font-semibold">{title}</SheetTitle>
					{description ? <SheetDescription>{description}</SheetDescription> : null}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
				{footer ? (
					<div className="flex h-16 shrink-0 items-center justify-end gap-2 border-t px-5">{footer}</div>
				) : null}
			</SheetContent>
		</Sheet>
	);
}

/**
 * The state behind the page card's parts, for the shell: the elements screens put things into, and
 * whether a screen shows its own secondary sidebar.
 */
export function usePageRegionsState(): {
	regions: PageRegions;
	setCover: (element: HTMLElement | null) => void;
	setFoot: (element: HTMLElement | null) => void;
	setAside: (element: HTMLElement | null) => void;
	/** Whether a screen shows its own secondary sidebar now. */
	asideClaimed: boolean;
} {
	const [cover, setCover] = useState<HTMLElement | null>(null);
	const [foot, setFoot] = useState<HTMLElement | null>(null);
	const [aside, setAside] = useState<HTMLElement | null>(null);
	const [claims, setClaims] = useState(0);
	const claimAside = useRef(() => {
		setClaims((count) => count + 1);
		return () => setClaims((count) => count - 1);
	}).current;
	return { regions: { cover, foot, aside, claimAside }, setCover, setFoot, setAside, asideClaimed: claims > 0 };
}
