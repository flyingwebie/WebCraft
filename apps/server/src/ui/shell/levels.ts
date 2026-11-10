import type { LinkProps } from "@tanstack/react-router";
import type { Permission } from "@webcraft/core";
import {
	ActivityIcon,
	ArchiveIcon,
	ArchiveRestoreIcon,
	BotIcon,
	BracesIcon,
	BriefcaseIcon,
	BugIcon,
	Building2Icon,
	ChartColumnIcon,
	ClipboardListIcon,
	ComponentIcon,
	CookieIcon,
	DatabaseIcon,
	FileClockIcon,
	FileCodeIcon,
	FileTextIcon,
	GlobeIcon,
	HardDriveIcon,
	HistoryIcon,
	ImagesIcon,
	ImportIcon,
	InboxIcon,
	KeyRoundIcon,
	LanguagesIcon,
	LayoutDashboardIcon,
	LayoutTemplateIcon,
	ListFilterIcon,
	type LucideIcon,
	MailIcon,
	NewspaperIcon,
	PackageIcon,
	PaletteIcon,
	PuzzleIcon,
	RepeatIcon,
	ScrollTextIcon,
	SearchCheckIcon,
	SettingsIcon,
	ShieldCheckIcon,
	ShieldIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	UsersIcon,
	WebhookIcon,
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
			/** Whether the person sees any Dashboard here, or builds them: the sidebar offers Dashboards then. */
			dashboards: boolean;
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
			/** The Permissions Modules running on the Site add that the person holds (`forms.submissions.view`). */
			modulePermissions: readonly string[];
			/** How many of the Site's Drafts the person may publish: Publish all in the top bar says it. */
			drafts: number;
			/** How many Reviews wait on the Site for the person to act on: the Overview item says it. */
			reviews: number;
			/** Whether the person sees any Dashboard here, or builds them: the sidebar offers Dashboards then. */
			dashboards: boolean;
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
	/** Shown only where the person sees a Dashboard, or builds them (`place.dashboards`). */
	dashboards?: boolean;
	/** Says how many Reviews wait for the person to act on (`place.reviews`), when any do. */
	reviews?: boolean;
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
					{
						id: "audit-log",
						label: "shell.nav.auditLog",
						icon: FileClockIcon,
						to: "/audit-log",
						requires: "audit.view",
					},
					{
						id: "install-health",
						label: "shell.nav.installHealth",
						icon: ActivityIcon,
						to: "/install/health",
						requires: "installHealth.manage",
					},
					{
						id: "error-log",
						label: "shell.nav.errorLog",
						icon: BugIcon,
						to: "/install/errors",
						requires: "installHealth.manage",
					},
					{
						id: "services-list",
						label: "shell.nav.servicesList",
						icon: BriefcaseIcon,
						to: "/services",
						requires: "servicesList.edit",
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
						id: "backups",
						label: "shell.nav.backups",
						icon: ArchiveIcon,
						to: "/settings/backups",
						requires: "install.manage",
					},
					{
						id: "history",
						label: "shell.nav.history",
						icon: HistoryIcon,
						to: "/settings/history",
						requires: "install.manage",
					},
					{
						id: "ai",
						label: "shell.nav.ai",
						icon: SparklesIcon,
						to: "/settings/ai",
						requires: "install.manage",
					},
					{
						id: "reports",
						label: "shell.nav.reportBranding",
						icon: PaletteIcon,
						to: "/settings/reports",
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
						id: "workspace-dashboards",
						label: "shell.nav.dashboards",
						icon: ChartColumnIcon,
						to: "/workspaces/$workspaceId/dashboards",
						dashboards: true,
					},
					{
						id: "members",
						label: "shell.nav.members",
						icon: UsersIcon,
						to: "/workspaces/$workspaceId/members",
						requires: "member.manage",
					},
					{
						id: "protected-terms",
						label: "shell.nav.protectedTerms",
						icon: ShieldIcon,
						to: "/workspaces/$workspaceId/protected-terms",
					},
					{
						id: "ai-keys",
						label: "shell.nav.aiKeys",
						icon: KeyRoundIcon,
						to: "/workspaces/$workspaceId/ai-keys",
						requires: "aiKey.manage",
					},
					{
						id: "workspace-site-imports",
						label: "shell.nav.siteImports",
						icon: ArchiveRestoreIcon,
						to: "/workspaces/$workspaceId/site-imports",
						requires: "site.import",
					},
					{
						id: "workspace-audit-log",
						label: "shell.nav.auditLog",
						icon: FileClockIcon,
						to: "/workspaces/$workspaceId/audit-log",
						requires: "audit.view",
					},
					{
						id: "workspace-report-branding",
						label: "shell.nav.reportBranding",
						icon: PaletteIcon,
						to: "/workspaces/$workspaceId/report-branding",
						requires: "reportBranding.manage",
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
						reviews: true,
					},
					{
						id: "site-dashboards",
						label: "shell.nav.dashboards",
						icon: ChartColumnIcon,
						to: "/sites/$siteId/dashboards",
						dashboards: true,
					},
					{ id: "site-checks", label: "shell.nav.checks", icon: SearchCheckIcon, to: "/sites/$siteId/checks" },
					// The Site's Post Types come here (`postTypeItems`).
					{ id: "site-media", label: "shell.nav.media", icon: ImagesIcon, to: "/sites/$siteId/media" },
					{ id: "site-globals", label: "shell.nav.globals", icon: SlidersHorizontalIcon, to: "/sites/$siteId/globals" },
					{
						id: "site-translations",
						label: "shell.nav.translations",
						icon: LanguagesIcon,
						to: "/sites/$siteId/translations",
						requires: "entry.edit",
					},
					{
						id: "site-imports",
						label: "shell.nav.imports",
						icon: ImportIcon,
						to: "/sites/$siteId/imports",
						requires: "import.run",
					},
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
					{
						id: "site-templates",
						label: "shell.nav.templates",
						icon: LayoutTemplateIcon,
						to: "/sites/$siteId/templates",
					},
					{
						id: "site-components",
						label: "shell.nav.components",
						icon: ComponentIcon,
						to: "/sites/$siteId/components",
					},
					{
						id: "site-design-system",
						label: "shell.nav.designSystem",
						icon: PaletteIcon,
						to: "/sites/$siteId/design-system",
					},
					{ id: "site-loops", label: "shell.nav.loops", icon: RepeatIcon, to: "/sites/$siteId/loops" },
					{ id: "site-filters", label: "shell.nav.filters", icon: ListFilterIcon, to: "/sites/$siteId/filters" },
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
						id: "site-ai-translation",
						label: "shell.nav.aiTranslation",
						icon: SparklesIcon,
						to: "/sites/$siteId/ai-translation",
						requires: "translation.manage",
					},
					{
						id: "site-accessibility-statement",
						label: "statement.heading",
						icon: SearchCheckIcon,
						to: "/sites/$siteId/accessibility-statement",
						requires: "structure.edit",
					},
					{
						id: "site-seo",
						label: "shell.nav.seo",
						icon: SearchCheckIcon,
						to: "/sites/$siteId/seo",
						requires: "structure.edit",
					},
					{
						id: "site-crawlers",
						label: "shell.nav.crawlers",
						icon: BotIcon,
						to: "/sites/$siteId/crawlers",
						requires: "aiCrawlers.manage",
					},
					{
						id: "site-consent-banner",
						label: "shell.nav.consentBanner",
						icon: CookieIcon,
						to: "/sites/$siteId/consent-banner",
						requires: "entry.edit",
					},
					{
						id: "site-email",
						label: "shell.nav.siteEmail",
						icon: MailIcon,
						to: "/sites/$siteId/email",
						requires: "structure.edit",
					},
					{
						id: "site-content-api",
						label: "shell.nav.contentApi",
						icon: BracesIcon,
						to: "/sites/$siteId/content-api",
						requires: "structure.edit",
					},
					{
						id: "site-webhooks",
						label: "shell.nav.webhooks",
						icon: WebhookIcon,
						to: "/sites/$siteId/webhooks",
						requires: "structure.edit",
					},
					{
						id: "site-report-branding",
						label: "shell.nav.reportBranding",
						icon: PaletteIcon,
						to: "/sites/$siteId/report-branding",
						requires: "reportBranding.manage",
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
					{
						id: "site-export",
						label: "shell.nav.siteExport",
						icon: PackageIcon,
						to: "/sites/$siteId/export",
						requires: "site.export",
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
 * A Site's Forms as Content items, after Media: one each, with its Submissions and Emails tabs for
 * clients and its Build and Settings tabs for Staff. The place lists the Forms only for people who may
 * see them (Staff, and the clients who change their emails), never Authors.
 */
function formItems(forms: readonly PlaceForm[]): NavItem[] {
	return forms.map((form) => ({
		id: `form-${form.id}`,
		label: { text: form.name },
		icon: InboxIcon,
		to: "/sites/$siteId/forms/$formId",
		params: { formId: form.id },
	}));
}

/** The sidebar of a place, with only the groups and items the person may see, and no empty groups. */
export function navigationFor(place: AdminPlace): LevelNavigation {
	const visible = (entry: { requires?: Permission; dashboards?: boolean }) =>
		(!entry.requires || place.permissions.includes(entry.requires)) &&
		(!entry.dashboards || (place.level !== "install" && place.dashboards));
	const level = NAVIGATION[place.level];
	const groups =
		place.level === "site"
			? level.groups.map((group) =>
					group.id === "content"
						? {
								...group,
								items: [
									...group.items.slice(0, 2),
									...postTypeItems(place.postTypes),
									...group.items.slice(2, 3),
									...formItems(place.forms),
									...group.items.slice(3),
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
