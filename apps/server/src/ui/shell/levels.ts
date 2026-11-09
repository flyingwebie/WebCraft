import type { LinkProps } from "@tanstack/react-router";
import type { Permission } from "@webcraft/core";
import {
	Building2Icon,
	ClipboardListIcon,
	DatabaseIcon,
	FileCodeIcon,
	FileTextIcon,
	GlobeIcon,
	HardDriveIcon,
	ImagesIcon,
	InboxIcon,
	LanguagesIcon,
	LayoutDashboardIcon,
	type LucideIcon,
	MailIcon,
	NewspaperIcon,
	PackageIcon,
	PuzzleIcon,
	RepeatIcon,
	ScrollTextIcon,
	SettingsIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	UsersIcon,
} from "lucide-react";

import type { MessageKey } from "../i18n.tsx";

/**
 * The admin has three levels: the Install, a Workspace and a Site. The sidebar shows the items of
 * the level the person is at; the context switcher at its top moves between levels.
 */
export type AdminLevel = "install" | "workspace" | "site";

export type PlaceWorkspace = { id: string; name: string };

export type PlaceSite = { id: string; name: string; slug: string };

/** One of a Site's Post Types, as the sidebar lists it: Pages (`builtIn: "page"`), then the rest. */
export type PlacePostType = { id: string; name: string; builtIn: "page" | null };

/** One of a Site's Forms, as the sidebar lists it. */
export type PlaceForm = { id: string; name: string };

/** The languages a Site's Content is written in: the Default language first. */
export type PlaceLanguages = { default: string; all: readonly string[] };

/** One of a Module's admin pages the person may open at the place (`/…/m/<module id>/<path>`). */
export type PlaceModulePage = { moduleId: string; path: string; label: string };

/**
 * Where in the admin a page is, with the Permissions the person holds there (the sidebar and the
 * pages offer only what they allow). Workspace and Site places carry which Workspace and Site, the
 * Workspace's Sites the person reaches (for the context switcher), and the admin pages of the
 * Modules running there that the person may open.
 */
export type AdminPlace =
	| { level: "install"; permissions: readonly string[] }
	| {
			level: "workspace";
			workspace: PlaceWorkspace;
			sites: PlaceSite[];
			permissions: readonly string[];
			modulePages: readonly PlaceModulePage[];
	  }
	| {
			level: "site";
			workspace: PlaceWorkspace;
			site: PlaceSite;
			sites: PlaceSite[];
			permissions: readonly string[];
			modulePages: readonly PlaceModulePage[];
			/** The Site's Post Types: the Content group lists the Entries of each. */
			postTypes: readonly PlacePostType[];
			/** The Site's Forms, for people who may see them: each has its own item. */
			forms: readonly PlaceForm[];
			languages: PlaceLanguages;
	  };

export type NavItem = {
	id: string;
	/** A message, or a name people gave (a Post Type's), shown as it is. */
	label: MessageKey | { text: string };
	icon: LucideIcon;
	/** The page, with `$workspaceId` and `$siteId` filled in from the place. */
	to: LinkProps["to"];
	/** More route parameters the page needs, such as a Post Type's id. */
	params?: Readonly<Record<string, string>>;
	/** Shown only to people holding this Permission at the place; everyone sees it when absent. */
	requires?: Permission;
	/** Active only on this very page, not on the pages below it (a level's home). */
	exact?: boolean;
};

export type NavGroup = {
	id: string;
	label: MessageKey;
	items: NavItem[];
	/**
	 * Shown only to people holding this Permission at the place, such as a Site's Structure group
	 * (`structure.edit`): Members see Content only, never Structure.
	 */
	requires?: Permission;
	/** A short note beside the group's label, such as "Staff only". */
	note?: MessageKey;
};

/** One level's sidebar: groups of items, and items pinned to its bottom. */
export type LevelNavigation = { groups: NavGroup[]; footer: NavItem[] };

/** Each level's sidebar. Add a screen's item to its level here. */
const NAVIGATION: Record<AdminLevel, LevelNavigation> = {
	install: {
		groups: [
			{
				id: "install",
				label: "shell.nav.installGroup",
				items: [
					{ id: "overview", label: "shell.nav.overview", icon: LayoutDashboardIcon, to: "/", exact: true },
					{ id: "workspaces", label: "shell.nav.workspaces", icon: Building2Icon, to: "/workspaces" },
					{ id: "staff", label: "shell.nav.staff", icon: UsersIcon, to: "/staff", requires: "staff.manage" },
					{
						id: "email-log",
						label: "shell.nav.emailLog",
						icon: ScrollTextIcon,
						to: "/email-log",
						requires: "install.manage",
					},
				],
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
						requires: "install.manage",
					},
					{
						id: "security",
						label: "shell.nav.security",
						icon: ShieldCheckIcon,
						to: "/settings/security",
						requires: "install.manage",
					},
					{
						id: "email",
						label: "shell.nav.email",
						icon: MailIcon,
						to: "/settings/email",
						requires: "install.manage",
					},
					{
						id: "storage",
						label: "shell.nav.storage",
						icon: HardDriveIcon,
						to: "/settings/storage",
						requires: "install.manage",
					},
					{
						id: "modules",
						label: "shell.nav.modules",
						icon: PuzzleIcon,
						to: "/settings/modules",
						requires: "module.approve",
					},
				],
			},
		],
		footer: [],
	},
	workspace: {
		groups: [
			{
				id: "workspace",
				label: "shell.nav.workspaceGroup",
				items: [
					{ id: "sites", label: "shell.nav.sites", icon: GlobeIcon, to: "/workspaces/$workspaceId", exact: true },
					{
						id: "members",
						label: "shell.nav.members",
						icon: UsersIcon,
						to: "/workspaces/$workspaceId/members",
						requires: "member.manage",
					},
					{
						id: "workspace-modules",
						label: "shell.nav.modules",
						icon: PuzzleIcon,
						to: "/workspaces/$workspaceId/modules",
						requires: "module.manage",
					},
				],
			},
		],
		footer: [],
	},
	site: {
		groups: [
			{
				id: "content",
				label: "shell.nav.contentGroup",
				items: [
					{
						id: "site-overview",
						label: "shell.nav.overview",
						icon: LayoutDashboardIcon,
						to: "/sites/$siteId",
						exact: true,
					},
					// The Site's Post Types come here (`postTypeItems`).
					{ id: "site-media", label: "shell.nav.media", icon: ImagesIcon, to: "/sites/$siteId/media" },
					{ id: "site-globals", label: "shell.nav.globals", icon: SlidersHorizontalIcon, to: "/sites/$siteId/globals" },
				],
			},
			{
				id: "structure",
				label: "shell.nav.structureGroup",
				note: "shell.nav.staffOnly",
				requires: "structure.edit",
				items: [
					{
						id: "site-post-types",
						label: "shell.nav.postTypes",
						icon: DatabaseIcon,
						to: "/sites/$siteId/post-types",
					},
					{ id: "site-loops", label: "shell.nav.loops", icon: RepeatIcon, to: "/sites/$siteId/loops" },
					{
						id: "site-forms",
						label: "shell.nav.forms",
						icon: ClipboardListIcon,
						to: "/sites/$siteId/forms",
						exact: true,
					},
					{
						id: "site-libraries",
						label: "shell.nav.libraries",
						icon: PackageIcon,
						to: "/sites/$siteId/libraries",
					},
				],
			},
			{
				id: "site-settings",
				label: "shell.nav.siteSettingsGroup",
				items: [
					{
						id: "site-domains",
						label: "shell.nav.domains",
						icon: GlobeIcon,
						to: "/sites/$siteId/domains",
						requires: "structure.edit",
					},
					{
						id: "site-languages",
						label: "shell.nav.languages",
						icon: LanguagesIcon,
						to: "/sites/$siteId/languages",
						requires: "structure.edit",
					},
					{
						id: "site-outside-scripts",
						label: "shell.nav.outsideScripts",
						icon: FileCodeIcon,
						to: "/sites/$siteId/outside-scripts",
						requires: "structure.edit",
					},
					{
						id: "site-modules",
						label: "shell.nav.modules",
						icon: PuzzleIcon,
						to: "/sites/$siteId/modules",
						requires: "module.manage",
					},
				],
			},
		],
		footer: [],
	},
};

/** A Site's Post Types as Content items, after its Overview: Pages first, then the rest by name. */
function postTypeItems(postTypes: readonly PlacePostType[]): NavItem[] {
	const ordered = [...postTypes].sort((a, b) => Number(b.builtIn === "page") - Number(a.builtIn === "page"));
	return ordered.map((postType) => ({
		id: `post-type-${postType.id}`,
		label: { text: postType.name },
		icon: postType.builtIn === "page" ? FileTextIcon : NewspaperIcon,
		to: "/sites/$siteId/entries/$postTypeId",
		params: { postTypeId: postType.id },
	}));
}

/**
 * A Site's Forms as Content items, after Media: one each (its Build and Settings tabs for Staff;
 * Submissions and Emails for clients join them).
 */
function formItems(forms: readonly PlaceForm[]): NavItem[] {
	return forms.map((form) => ({
		id: `form-${form.id}`,
		label: { text: form.name },
		icon: InboxIcon,
		to: "/sites/$siteId/forms/$formId",
		params: { formId: form.id },
		requires: "structure.edit",
	}));
}

/** The sidebar of a place, with only the groups and items the person may see, and no empty groups. */
export function navigationFor(place: AdminPlace): LevelNavigation {
	const visible = (entry: { requires?: Permission }) => !entry.requires || place.permissions.includes(entry.requires);
	const level = NAVIGATION[place.level];
	const groups =
		place.level === "site"
			? level.groups.map((group) =>
					group.id === "content"
						? {
								...group,
								items: [
									...group.items.slice(0, 1),
									...postTypeItems(place.postTypes),
									...group.items.slice(1, 2),
									...formItems(place.forms),
									...group.items.slice(2),
								],
							}
						: group,
				)
			: level.groups;
	return {
		groups: groups
			.filter(visible)
			.map((group) => ({ ...group, items: group.items.filter(visible) }))
			.filter((group) => group.items.length > 0),
		footer: level.footer.filter(visible),
	};
}

/** The route parameters of a place, for links to its pages. */
export function placeParams(place: AdminPlace): { workspaceId?: string; siteId?: string } {
	switch (place.level) {
		case "install":
			return {};
		case "workspace":
			return { workspaceId: place.workspace.id };
		case "site":
			return { workspaceId: place.workspace.id, siteId: place.site.id };
	}
}

/** The breadcrumbs of a level: the Install, a Workspace, or a Workspace then its Site. */
export function levelCrumbs(
	place: AdminPlace,
	installLabel: string,
): { label: string; to: LinkProps["to"]; params: Record<string, string> }[] {
	switch (place.level) {
		case "install":
			return [{ label: installLabel, to: "/", params: {} }];
		case "workspace":
			return [
				{ label: place.workspace.name, to: "/workspaces/$workspaceId", params: { workspaceId: place.workspace.id } },
			];
		case "site":
			return [
				{ label: place.workspace.name, to: "/workspaces/$workspaceId", params: { workspaceId: place.workspace.id } },
				{ label: place.site.name, to: "/sites/$siteId", params: { siteId: place.site.id } },
			];
	}
}
