import type { LinkProps } from "@tanstack/react-router";
import type { Permission } from "@webcraft/core";
import {
	AccessibilityIcon,
	ActivityIcon,
	ArchiveIcon,
	ArchiveRestoreIcon,
	BotIcon,
	BracesIcon,
	BugIcon,
	Building2Icon,
	ChartColumnIcon,
	ClipboardListIcon,
	ComponentIcon,
	CookieIcon,
	DatabaseIcon,
	DownloadIcon,
	FileClockIcon,
	FileCodeIcon,
	FileTextIcon,
	FilterIcon,
	GlobeIcon,
	HardDriveIcon,
	HistoryIcon,
	ImagesIcon,
	ImportIcon,
	InboxIcon,
	KeyRoundIcon,
	LanguagesIcon,
	LayoutGridIcon,
	LayoutTemplateIcon,
	ListFilterIcon,
	type LucideIcon,
	MailIcon,
	NewspaperIcon,
	PackageIcon,
	PaletteIcon,
	PlusIcon,
	PuzzleIcon,
	RepeatIcon,
	ScrollTextIcon,
	SearchCheckIcon,
	ServerIcon,
	SettingsIcon,
	ShieldCheckIcon,
	ShieldIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	SquareDashedIcon,
	TargetIcon,
	UserIcon,
	UsersIcon,
	WebhookIcon,
} from "lucide-react";

import type { MessageKey } from "../i18n.tsx";

/**
 * The admin has three levels: the Install, a Workspace and a Site. The sidebar shows the rows of
 * the level the person is at; the context switcher at its top moves between levels.
 */
export type AdminLevel = "install" | "workspace" | "site";

export type PlaceWorkspace = { id: string; name: string };

export type PlaceSite = { id: string; name: string; slug: string };

/** One of a Site's Post Types, as the sidebar lists it: Pages (`builtIn: "page"`), then the rest. */
export type PlacePostType = {
	id: string;
	name: string;
	builtIn: "page" | null;
	/** How many Entries it has, when what the Site loads says so: the row shows the number then. */
	entries?: number;
};

/** One of a Site's Forms, as the Forms secondary sidebar lists it. */
export type PlaceForm = {
	id: string;
	name: string;
	/** How many of its Submissions nobody has opened yet, when what the Site loads says so. */
	newSubmissions?: number;
};

/** One Dashboard the person sees at the place, as the Analytics secondary sidebar lists it. */
export type PlaceDashboard = { id: string; name: string };

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
			/**
			 * The Workspace Dashboards the person sees, for Analytics; null when they neither see one nor
			 * build them, and the sidebar has no Analytics row.
			 */
			dashboards: readonly PlaceDashboard[] | null;
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
			/** The Site's Forms, for people who may see them: the Forms row opens them. */
			forms: readonly PlaceForm[];
			/** How many new Submissions the Site's Forms hold together, when what the Site loads says so. */
			newSubmissions?: number;
			languages: PlaceLanguages;
			/** The Permissions Modules running on the Site add that the person holds (`forms.submissions.view`). */
			modulePermissions: readonly string[];
			/** How many of the Site's Drafts the person may publish: Publish all in the top bar says it. */
			drafts: number;
			/** How many Reviews wait on the Site for the person to act on: the Overview row says it. */
			reviews: number;
			/**
			 * The Site's Dashboards the person sees, for Analytics; null when they neither see one nor
			 * build them, and the sidebar has no Analytics row.
			 */
			dashboards: readonly PlaceDashboard[] | null;
	  };

/** An address in the admin: a route with its parameters. */
export type NavTarget = { to: LinkProps["to"]; params: Readonly<Record<string, string>> };

/** Words at a row's end: how many are new ("5 new"), what waits ("2 to review"), who it is for ("Staff only"). */
export type NavBadge = {
	tone: "info" | "warn" | "outline";
	label: MessageKey;
	/** The number the label says, for labels that take one. */
	count?: number;
};

/**
 * One row of the navigation, as the person sees it. A row with `sections` opens a secondary sidebar
 * inside the page card and leads to the first row there.
 */
export type NavRow = NavTarget & {
	id: string;
	/** A message, or a name people gave (a Post Type's, a Form's, a Dashboard's), shown as it is. */
	label: MessageKey | { text: string };
	icon: LucideIcon;
	/** Current only on this very page, not on the pages below it (a level's home). */
	exact: boolean;
	/** More addresses the row is current under, when nothing nearer claims the page. */
	covers: readonly NavTarget[];
	/** A plain number at the row's end, such as how many Sites. */
	count?: number;
	badge?: NavBadge;
	/** The rows of the secondary sidebar this row opens, in sections (a section may have a label). */
	sections?: readonly NavSection[];
	/**
	 * How the row is named in the breadcrumbs while a page of its secondary sidebar is open: its label
	 * unless given ("Settings" for Site settings), or nothing when the pages name it themselves.
	 */
	crumb?: MessageKey | null;
};

export type NavSection = { id: string; label?: MessageKey; rows: readonly NavRow[] };

export type NavGroup = { id: string; label?: MessageKey; rows: readonly NavRow[] };

/**
 * One level's navigation: the sidebar's groups of rows, the rows pinned to its foot, and the areas
 * reached from elsewhere (the person's menu) that have a secondary sidebar of their own.
 */
export type LevelNavigation = { groups: NavGroup[]; footer: NavRow[]; aside: NavRow[] };

/** What a row is made from: its address may come from its first row, its Permission decides who sees it. */
type RowInput = {
	id: string;
	label: MessageKey | { text: string };
	icon: LucideIcon;
	to?: LinkProps["to"];
	params?: Readonly<Record<string, string>>;
	/** Shown only to people holding this Permission at the place; everyone sees it when absent. */
	requires?: Permission;
	/** Left out for people holding this Permission, who find it somewhere else. */
	unless?: Permission;
	/** Left out altogether when false. */
	when?: boolean;
	exact?: boolean;
	covers?: readonly LinkProps["to"][];
	count?: number;
	badge?: NavBadge;
	sections?: readonly { id: string; label?: MessageKey; rows: readonly RowInput[] }[];
	crumb?: MessageKey | null;
};

type GroupInput = { id: string; label?: MessageKey; rows: readonly RowInput[] };

/** The Module whose admin pages are Goals and Funnels: Analytics lists them under "Measure". */
const SITE_ANALYTICS = "site-analytics";

/** The Install level: running the Install, then its settings at the foot. */
function installNavigation(workspaces: number): { groups: GroupInput[]; footer: RowInput[] } {
	return {
		groups: [
			{
				id: "install",
				label: "shell.nav.installGroup",
				rows: [
					{ id: "overview", label: "shell.nav.overview", icon: LayoutGridIcon, to: "/", exact: true },
					{
						id: "workspaces",
						label: "shell.nav.workspaces",
						icon: Building2Icon,
						to: "/workspaces",
						count: workspaces,
					},
					{ id: "staff", label: "shell.nav.staff", icon: ShieldIcon, to: "/staff", requires: "staff.manage" },
					{
						id: "services-list",
						label: "shell.nav.servicesList",
						icon: ServerIcon,
						to: "/services",
						requires: "servicesList.edit",
					},
					{
						id: "logs-and-health",
						label: "shell.nav.logsAndHealth",
						icon: ActivityIcon,
						sections: [
							{
								id: "logs-and-health",
								rows: [
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
								],
							},
						],
					},
				],
			},
		],
		footer: [
			{
				id: "install-settings",
				label: "shell.nav.installSettingsGroup",
				icon: SettingsIcon,
				sections: [
					{
						id: "install-settings",
						rows: [
							{
								id: "general",
								label: "shell.nav.general",
								icon: SlidersHorizontalIcon,
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
							{ id: "ai", label: "shell.nav.ai", icon: SparklesIcon, to: "/settings/ai", requires: "install.manage" },
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
			},
		],
	};
}

/** The Workspace level: its Sites, Analytics, people and log, then its settings at the foot. */
function workspaceNavigation(place: Extract<AdminPlace, { level: "workspace" }>): {
	groups: GroupInput[];
	footer: RowInput[];
} {
	return {
		groups: [
			{
				id: "workspace",
				label: "shell.nav.workspaceGroup",
				rows: [
					{
						id: "sites",
						label: "shell.nav.sites",
						icon: GlobeIcon,
						to: "/workspaces/$workspaceId",
						exact: true,
						count: place.sites.length,
					},
					analyticsRow({
						id: "workspace-analytics",
						dashboards: place.dashboards,
						list: "/workspaces/$workspaceId/dashboards",
						one: "/workspaces/$workspaceId/dashboards/$dashboardId",
						measure: [],
					}),
					{
						id: "members",
						label: "shell.nav.members",
						icon: UsersIcon,
						to: "/workspaces/$workspaceId/members",
						requires: "member.manage",
					},
					{
						id: "workspace-audit-log",
						label: "shell.nav.auditLog",
						icon: HistoryIcon,
						to: "/workspaces/$workspaceId/audit-log",
						requires: "audit.view",
					},
				],
			},
		],
		footer: [
			{
				id: "workspace-settings",
				label: "shell.nav.workspaceSettings",
				icon: SettingsIcon,
				crumb: "shell.nav.settingsCrumb",
				sections: [
					{
						id: "workspace-settings",
						rows: [
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
					modulePagesSection(place.modulePages, "/workspaces/$workspaceId/m/$moduleId/$"),
				],
			},
		],
	};
}

/** The Site level: Content, Insights, Structure for Staff, then the Site's settings at the foot. */
function siteNavigation(place: Extract<AdminPlace, { level: "site" }>): { groups: GroupInput[]; footer: RowInput[] } {
	const measure = place.modulePages.filter((page) => page.moduleId === SITE_ANALYTICS);
	const otherModulePages = place.modulePages.filter((page) => page.moduleId !== SITE_ANALYTICS);
	// Pages first, then the rest by name, as the list gives them.
	const postTypes = [...place.postTypes].sort((a, b) => Number(b.builtIn === "page") - Number(a.builtIn === "page"));
	return {
		groups: [
			{
				id: "content",
				label: "shell.nav.contentGroup",
				rows: [
					{
						id: "site-overview",
						label: "shell.nav.overview",
						icon: LayoutGridIcon,
						to: "/sites/$siteId",
						exact: true,
						badge: place.reviews > 0 ? { tone: "warn", label: "review.navBadge", count: place.reviews } : undefined,
					},
					...postTypes.map(
						(postType): RowInput => ({
							id: `post-type-${postType.id}`,
							label: { text: postType.name },
							icon: postType.builtIn === "page" ? FileTextIcon : NewspaperIcon,
							to: "/sites/$siteId/entries/$postTypeId",
							params: { postTypeId: postType.id },
							count: postType.entries,
						}),
					),
					{ id: "site-media", label: "shell.nav.media", icon: ImagesIcon, to: "/sites/$siteId/media" },
					{
						// The Site's Forms for the people who read their Submissions and change their emails: one
						// row each in the secondary sidebar. Staff build Forms under Structure.
						id: "site-form-submissions",
						label: "shell.nav.forms",
						icon: ClipboardListIcon,
						badge:
							place.newSubmissions !== undefined && place.newSubmissions > 0
								? { tone: "info", label: "shell.nav.newCount", count: place.newSubmissions }
								: undefined,
						sections: [
							{
								id: "forms",
								rows: place.forms.map(
									(form): RowInput => ({
										id: `form-${form.id}`,
										label: { text: form.name },
										icon: InboxIcon,
										to: "/sites/$siteId/forms/$formId",
										params: { formId: form.id },
										count: form.newSubmissions,
									}),
								),
							},
						],
					},
					{
						id: "site-globals",
						label: "shell.nav.globals",
						icon: SlidersHorizontalIcon,
						to: "/sites/$siteId/globals",
					},
					{
						// Staff find Popups under Structure, where they build them; Members change a Popup's words here.
						id: "site-popups-content",
						label: "shell.nav.popups",
						icon: SquareDashedIcon,
						to: "/sites/$siteId/popups",
						unless: "structure.edit",
					},
					{
						id: "site-translations",
						label: "shell.nav.translations",
						icon: LanguagesIcon,
						to: "/sites/$siteId/translations",
						requires: "entry.edit",
					},
				],
			},
			{
				id: "insights",
				label: "shell.nav.insightsGroup",
				rows: [
					analyticsRow({
						id: "site-analytics",
						dashboards: place.dashboards,
						list: "/sites/$siteId/dashboards",
						one: "/sites/$siteId/dashboards/$dashboardId",
						measure: measure.map(
							(page): RowInput => ({
								id: `measure-${page.path}`,
								label: { text: page.label },
								icon: page.path === "funnels" ? FilterIcon : TargetIcon,
								to: "/sites/$siteId/m/$moduleId/$",
								params: { moduleId: page.moduleId, _splat: page.path },
							}),
						),
					}),
					{ id: "site-checks", label: "shell.nav.checks", icon: SearchCheckIcon, to: "/sites/$siteId/checks" },
				],
			},
			{
				// Structure is one row: what shapes the Site is in its secondary sidebar. Members never see it.
				id: "structure",
				rows: [
					{
						id: "site-structure",
						label: "shell.nav.structureGroup",
						icon: DatabaseIcon,
						requires: "structure.edit",
						badge: { tone: "outline", label: "shell.nav.staffOnly" },
						sections: [
							{
								id: "structure",
								rows: [
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
									{
										id: "site-filters",
										label: "shell.nav.filters",
										icon: ListFilterIcon,
										to: "/sites/$siteId/filters",
									},
									{
										// The list of Forms, where Staff make one; a Form itself opens under Content › Forms.
										id: "site-forms",
										label: "shell.nav.forms",
										icon: ClipboardListIcon,
										to: "/sites/$siteId/forms",
										exact: true,
									},
									{
										id: "site-popups",
										label: "shell.nav.popups",
										icon: SquareDashedIcon,
										to: "/sites/$siteId/popups",
									},
									{
										id: "site-libraries",
										label: "shell.nav.libraries",
										icon: PackageIcon,
										to: "/sites/$siteId/libraries",
									},
								],
							},
						],
					},
				],
			},
		],
		footer: [
			{
				id: "site-settings",
				label: "shell.nav.siteSettingsGroup",
				icon: SettingsIcon,
				crumb: "shell.nav.settingsCrumb",
				sections: [
					{
						id: "site-settings-general",
						label: "shell.nav.settings.general",
						rows: [
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
								id: "site-email",
								label: "shell.nav.siteEmail",
								icon: MailIcon,
								to: "/sites/$siteId/email",
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
					{
						id: "site-settings-translation",
						label: "shell.nav.settings.translation",
						rows: [
							{
								id: "site-ai-translation",
								label: "shell.nav.aiTranslation",
								icon: SparklesIcon,
								to: "/sites/$siteId/ai-translation",
								requires: "translation.manage",
							},
						],
					},
					{
						id: "site-settings-search",
						label: "shell.nav.settings.searchAndPrivacy",
						rows: [
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
								id: "site-accessibility-statement",
								label: "statement.heading",
								icon: AccessibilityIcon,
								to: "/sites/$siteId/accessibility-statement",
								requires: "structure.edit",
							},
						],
					},
					{
						id: "site-settings-integrations",
						label: "shell.nav.settings.integrations",
						rows: [
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
								id: "site-outside-scripts",
								label: "shell.nav.outsideScripts",
								icon: FileCodeIcon,
								to: "/sites/$siteId/outside-scripts",
								requires: "structure.edit",
							},
						],
					},
					{
						id: "site-settings-data",
						label: "shell.nav.settings.data",
						rows: [
							{
								id: "site-imports",
								label: "shell.nav.imports",
								icon: ImportIcon,
								to: "/sites/$siteId/imports",
								requires: "import.run",
							},
							{
								id: "site-export",
								label: "shell.nav.siteExport",
								icon: DownloadIcon,
								to: "/sites/$siteId/export",
								requires: "site.export",
							},
							{
								id: "site-report-branding",
								label: "shell.nav.reportBranding",
								icon: PaletteIcon,
								to: "/sites/$siteId/report-branding",
								requires: "reportBranding.manage",
							},
						],
					},
					modulePagesSection(otherModulePages, "/sites/$siteId/m/$moduleId/$"),
				],
			},
		],
	};
}

/**
 * Analytics: one row whose secondary sidebar lists the Dashboards the person sees by name, "New
 * Dashboard" for the people who build them (it opens the list of Dashboards, where one is made), and
 * under "Measure" what a Site counts (Goals, Funnels). The row opens the first Dashboard, or the list
 * while there is none; nobody without a Dashboard to see or build gets the row.
 */
function analyticsRow(input: {
	id: string;
	dashboards: readonly PlaceDashboard[] | null;
	list: LinkProps["to"];
	one: LinkProps["to"];
	measure: readonly RowInput[];
}): RowInput {
	const dashboards = input.dashboards ?? [];
	const first = dashboards[0];
	return {
		id: input.id,
		label: "shell.nav.analytics",
		icon: ChartColumnIcon,
		when: input.dashboards !== null,
		to: first ? input.one : input.list,
		params: first ? { dashboardId: first.id } : undefined,
		// The list of Dashboards and anything under it is Analytics, whichever row it is.
		covers: [input.list],
		sections: [
			{
				id: `${input.id}-dashboards`,
				label: "shell.nav.dashboards",
				rows: [
					...dashboards.map(
						(dashboard): RowInput => ({
							id: `dashboard-${dashboard.id}`,
							label: { text: dashboard.name },
							icon: ChartColumnIcon,
							to: input.one,
							params: { dashboardId: dashboard.id },
						}),
					),
					{
						id: `${input.id}-new`,
						label: "dashboards.new",
						icon: PlusIcon,
						to: input.list,
						exact: true,
						requires: "dashboard.manage",
					},
				],
			},
			{ id: `${input.id}-measure`, label: "shell.nav.measure", rows: input.measure },
		],
	};
}

/** The admin pages Modules add at a place, as the last section of its settings. */
function modulePagesSection(
	pages: readonly PlaceModulePage[],
	to: LinkProps["to"],
): { id: string; label: MessageKey; rows: RowInput[] } {
	return {
		id: "module-pages",
		label: "shell.nav.modulePagesGroup",
		rows: pages.map((page) => ({
			id: `module-page-${page.moduleId}-${page.path}`,
			label: { text: page.label },
			icon: PuzzleIcon,
			to,
			params: { moduleId: page.moduleId, _splat: page.path },
		})),
	};
}

/**
 * Your account's pages, reached from the person's menu at every level: not a row of the sidebar, but
 * with a secondary sidebar like the settings. The pages name themselves in the breadcrumbs.
 */
const ACCOUNT: RowInput = {
	id: "account",
	label: "shell.userMenu.account",
	icon: UserIcon,
	crumb: null,
	sections: [
		{
			id: "account",
			rows: [
				{ id: "account-profile", label: "shell.userMenu.account", icon: UserIcon, to: "/account", exact: true },
				{ id: "account-api-tokens", label: "shell.userMenu.apiTokens", icon: KeyRoundIcon, to: "/account/api-tokens" },
				{ id: "account-ai-clients", label: "shell.userMenu.aiClients", icon: BotIcon, to: "/account/ai-clients" },
				{ id: "account-activity", label: "shell.userMenu.activity", icon: HistoryIcon, to: "/account/activity" },
			],
		},
	],
};

/**
 * The navigation of a place, with only what the person may see: rows whose Permission they hold,
 * sections and groups that have rows, and rows with a secondary sidebar only while it has rows.
 * `workspaces` is how many Workspaces the person reaches (the Install's Workspaces row says it).
 */
export function navigationFor(place: AdminPlace, workspaces = 0): LevelNavigation {
	const base = placeParams(place);
	const resolve = (input: RowInput): NavRow | null => {
		if (input.when === false) return null;
		if (input.requires && !place.permissions.includes(input.requires)) return null;
		if (input.unless && place.permissions.includes(input.unless)) return null;
		const sections = input.sections
			?.map((section) => ({
				id: section.id,
				label: section.label,
				rows: section.rows.map(resolve).filter((row): row is NavRow => row !== null),
			}))
			.filter((section) => section.rows.length > 0);
		// A row with no address of its own leads to the first row of its secondary sidebar: without
		// rows there it is nothing. One with its own address stays, as a plain row.
		const first = sections?.[0]?.rows[0];
		const to = input.to ?? first?.to;
		if (!to) return null;
		return {
			id: input.id,
			label: input.label,
			icon: input.icon,
			to,
			params: input.to ? { ...base, ...input.params } : (first?.params ?? base),
			exact: input.exact ?? false,
			covers: (input.covers ?? []).map((covered) => ({ to: covered, params: base })),
			count: input.count,
			badge: input.badge,
			sections: sections && sections.length > 0 ? sections : undefined,
			crumb: input.crumb,
		};
	};
	const rows = (inputs: readonly RowInput[]) => inputs.map(resolve).filter((row): row is NavRow => row !== null);
	const level =
		place.level === "install"
			? installNavigation(workspaces)
			: place.level === "workspace"
				? workspaceNavigation(place)
				: siteNavigation(place);
	return {
		groups: level.groups
			.map((group) => ({ id: group.id, label: group.label, rows: rows(group.rows) }))
			.filter((group) => group.rows.length > 0),
		footer: rows(level.footer),
		aside: rows([ACCOUNT]),
	};
}

/** Where a page is in the navigation: its row, and the row whose secondary sidebar holds it. */
export type NavPosition = {
	/** The sidebar row that is current: the page's own, or the one whose secondary sidebar holds it. */
	primary: NavRow | null;
	/** The current row of the secondary sidebar, when the page is in one. */
	secondary: NavRow | null;
	/** The row whose secondary sidebar shows beside the page: `primary`, or an area outside the sidebar. */
	parent: NavRow | null;
};

/**
 * The page's place in a navigation: the row whose address is the page's, or the longest one above it.
 * A row's own address counts before an address it merely covers, so exactly one row is current at
 * each level. `pathOf` turns a row's address into a path, as the router writes it.
 */
export function positionIn(
	navigation: LevelNavigation,
	pathname: string,
	pathOf: (target: NavTarget) => string,
): NavPosition {
	const page = trimSlash(pathname);
	const under = (target: NavTarget, exact: boolean): number => {
		const path = trimSlash(pathOf(target));
		if (page === path) return path.length + 1;
		if (!exact && (path === "" || page.startsWith(`${path}/`))) return path.length;
		return -1;
	};
	let best: { row: NavRow; parent: NavRow | null; inSidebar: boolean; score: number } | null = null;
	const consider = (row: NavRow, parent: NavRow | null, inSidebar: boolean) => {
		// Twice the length, so a row's own address beats an equally long address that only covers the page.
		const own = under(row, row.exact) * 2 + 1;
		const covered = Math.max(-1, ...row.covers.map((target) => under(target, false))) * 2;
		const score = Math.max(own, covered);
		if (score > 0 && (!best || score > best.score)) best = { row, parent, inSidebar, score };
		for (const section of row.sections ?? []) for (const child of section.rows) consider(child, row, inSidebar);
	};
	for (const group of navigation.groups) for (const row of group.rows) consider(row, null, true);
	for (const row of navigation.footer) consider(row, null, true);
	for (const row of navigation.aside) consider(row, null, false);
	const found = best as { row: NavRow; parent: NavRow | null; inSidebar: boolean } | null;
	if (!found) return { primary: null, secondary: null, parent: null };
	const parent = found.parent ?? (found.row.sections ? found.row : null);
	const top = found.parent ?? found.row;
	return {
		primary: found.inSidebar ? top : null,
		secondary: found.parent ? found.row : null,
		parent,
	};
}

function trimSlash(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path === "/" ? "" : path;
}

/** The route parameters of a place, for links to its pages. */
export function placeParams(place: AdminPlace): Readonly<Record<string, string>> {
	switch (place.level) {
		case "install":
			return {};
		case "workspace":
			return { workspaceId: place.workspace.id };
		case "site":
			return { siteId: place.site.id };
	}
}

/** The breadcrumbs of a level: the Install, a Workspace, or a Workspace then its Site. */
export function levelCrumbs(
	place: AdminPlace,
	installName: string,
): { label: string; to: LinkProps["to"]; params: Record<string, string> }[] {
	switch (place.level) {
		case "install":
			return [{ label: installName, to: "/", params: {} }];
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
