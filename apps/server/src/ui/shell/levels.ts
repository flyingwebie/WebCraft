import type { LinkProps } from "@tanstack/react-router";
import { LayoutDashboardIcon, type LucideIcon, SettingsIcon } from "lucide-react";

import type { MessageKey } from "../i18n.tsx";

/**
 * The admin has three levels: the Install, a Workspace and a Site. The sidebar shows the items of
 * the level the person is at; the context switcher at its top moves between levels. Only the
 * Install level exists until Workspaces and Sites do; each adds its own entry below.
 */
export type AdminLevel = "install" | "workspace" | "site";

/** Where in the admin a page is. Workspace and Site places carry which Workspace and Site. */
export type AdminPlace = { level: "install" };

/** Who is looking: decides which items they see. */
export type Viewer = { installRole: string | null };

export type NavItem = {
	id: string;
	label: MessageKey;
	icon: LucideIcon;
	to: LinkProps["to"];
	/** Who sees the item; everyone signed in when absent. */
	visibleTo?: (viewer: Viewer) => boolean;
};

export type NavGroup = { id: string; label: MessageKey; items: NavItem[] };

/** One level's sidebar: groups of items, and items pinned to its bottom. */
export type LevelNavigation = { groups: NavGroup[]; footer: NavItem[] };

const superadminOnly = (viewer: Viewer) => viewer.installRole === "superadmin";

/** Each level's sidebar. Add a level's items here when its screens exist. */
const NAVIGATION: Record<AdminPlace["level"], LevelNavigation> = {
	install: {
		groups: [
			{
				id: "install",
				label: "shell.nav.installGroup",
				items: [{ id: "overview", label: "shell.nav.overview", icon: LayoutDashboardIcon, to: "/" }],
			},
			{
				id: "install-settings",
				label: "shell.nav.installSettingsGroup",
				items: [
					{
						id: "general",
						label: "shell.nav.general",
						icon: SettingsIcon,
						to: "/settings/general",
						visibleTo: superadminOnly,
					},
				],
			},
		],
		footer: [],
	},
};

/** The sidebar of a place, with only the items the viewer may see and no empty groups. */
export function navigationFor(place: AdminPlace, viewer: Viewer): LevelNavigation {
	const visible = (item: NavItem) => item.visibleTo?.(viewer) ?? true;
	const level = NAVIGATION[place.level];
	return {
		groups: level.groups
			.map((group) => ({ ...group, items: group.items.filter(visible) }))
			.filter((group) => group.items.length > 0),
		footer: level.footer.filter(visible),
	};
}

/** The label of a level's root, the first breadcrumb on every page of that level. */
export const LEVEL_LABELS: Record<AdminPlace["level"], MessageKey> = {
	install: "shell.levels.install",
};

/** Where a level's root page is. */
export const LEVEL_HOMES: Record<AdminPlace["level"], LinkProps["to"]> = {
	install: "/",
};
