import { createLink, useRouter, useRouterState } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { type ComponentProps, createContext, forwardRef, type ReactNode, useContext, useMemo } from "react";

import { type MessageKey, useT } from "../i18n.tsx";
import type { ShellContext } from "./context.ts";
import {
	type AdminPlace,
	type LevelNavigation,
	type NavBadge,
	type NavPosition,
	type NavTarget,
	navigationFor,
	positionIn,
} from "./levels.ts";

/** The navigation of the place the person is at, and where the page on screen is in it. */
export type Navigation = LevelNavigation & { position: NavPosition };

const NavigationContext = createContext<Navigation | null>(null);

/**
 * Works out the place's navigation and the page's position in it, once, for the sidebar, the
 * secondary sidebar, the breadcrumbs and Search. The position follows the page that is on screen:
 * while the next page loads, the rows still say where the person is.
 */
export function NavigationProvider({
	place,
	shell,
	children,
}: {
	place: AdminPlace;
	shell: ShellContext;
	children: ReactNode;
}) {
	const router = useRouter();
	const pathname = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).pathname });
	const workspaces = shell.workspaces.length;
	const navigation = useMemo(() => {
		const level = navigationFor(place, workspaces);
		const pathOf = (target: NavTarget) =>
			router.buildLocation({ to: target.to, params: target.params } as never).pathname;
		return { ...level, position: positionIn(level, pathname, pathOf) };
	}, [place, workspaces, pathname, router]);
	return <NavigationContext.Provider value={navigation}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
	const navigation = useContext(NavigationContext);
	if (!navigation) throw new Error("useNavigation must be used inside the admin shell.");
	return navigation;
}

/** A row's name: its message in the person's Admin language, or the name people gave. */
export function useRowLabel(): (label: MessageKey | { text: string }) => string {
	const t = useT();
	return (label) => (typeof label === "string" ? t(label) : label.text);
}

/**
 * How a row tells assistive technology it is the current one: `page` for the row of the page itself,
 * `true` for the row whose secondary sidebar holds the page.
 */
export type Current = "page" | "true" | undefined;

/** An anchor that says it is current only when the shell says so (`current`), never by itself. */
const RowAnchor = forwardRef<HTMLAnchorElement, ComponentProps<"a"> & { current?: Current; "data-status"?: string }>(
	function RowAnchor({ current, "aria-current": _router, "data-status": _status, ...props }, ref) {
		return <a ref={ref} {...props} aria-current={current} />;
	},
);

const CurrentLink = createLink(RowAnchor);

/**
 * A row's link. The router marks every link to the page on screen current, which made two rows
 * current at once (a row and the row of its secondary sidebar leading to the same page); here the
 * shell says which one row is current at each level, and only that row says so.
 */
export function RowLink({
	row,
	current,
	...props
}: { row: NavTarget; current: Current } & Omit<ComponentProps<"a">, "href" | "aria-current">) {
	return <CurrentLink to={row.to} params={row.params as never} current={current} {...props} />;
}

/** The words at a row's end: "5 new", "2 to review", "Staff only". */
export function RowBadge({ badge, className }: { badge: NavBadge; className?: string }) {
	const t = useT();
	const label = badge.count === undefined ? t(badge.label) : t(badge.label, { count: badge.count });
	if (badge.tone === "outline") {
		return (
			<Badge variant="outline" className={cn("font-medium", className)}>
				{label}
			</Badge>
		);
	}
	return <Badge className={cn(BADGE_TONES[badge.tone], className)}>{label}</Badge>;
}

/** A count in a badge of its own, such as a Form's new Submissions in the secondary sidebar. */
export function CountBadge({ count, className }: { count: number; className?: string }) {
	return <Badge className={cn(BADGE_TONES.info, "tabular-nums", className)}>{count}</Badge>;
}

const BADGE_TONES = {
	// Blue on a blue tint: something arrived. 7:1 and more in both themes.
	info: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
	// The warning pair of the theme: something waits for the person.
	warn: "bg-warning text-warning-foreground",
} as const;
