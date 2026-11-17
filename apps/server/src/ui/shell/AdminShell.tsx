import { useRouterState } from "@tanstack/react-router";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarTrigger,
	useSidebar,
} from "@webcraft/ui/components/sidebar.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useT } from "../i18n.tsx";
import { PublishAllButton } from "../publishing/PublishAll.tsx";
import { ReviewFromAddress } from "../review/Review.tsx";
import { AdminSearch } from "./AdminSearch.tsx";
import { BackupFailingBanner } from "./BackupFailingBanner.tsx";
import { Breadcrumbs } from "./Breadcrumbs.tsx";
import type { ShellContext, SignedInPerson } from "./context.ts";
import { ContextSwitcher } from "./ContextSwitcher.tsx";
import { EditOnSiteButton, SiteActionsMenu } from "./EditOnSiteButton.tsx";
import { HealthBanner } from "./HealthBanner.tsx";
import { ImpersonationBanner } from "./ImpersonationBanner.tsx";
import type { AdminPlace, NavRow } from "./levels.ts";
import { MasterKeyBanner } from "./MasterKeyBanner.tsx";
import { NavigationProvider, RowBadge, RowLink, useNavigation, useRowLabel } from "./navigation.tsx";
import { PageColumn, PageRegionsProvider, usePageRegionsState, useRouteWidth } from "./page.tsx";
import { NavigationSecondary, NavigationSecondaryMenu } from "./SecondarySidebar.tsx";
import { SmtpFailingBanner } from "./SmtpFailingBanner.tsx";
import { StagingButton } from "./StagingButton.tsx";
import { TwoFactorReminderBanner } from "./TwoFactorReminderBanner.tsx";
import { UpdateBanner } from "./UpdateBanner.tsx";
import { UserMenu } from "./UserMenu.tsx";

/**
 * The admin shell, the sidebar's inset variant: the window takes the sidebar's colour; the sidebar
 * (the context switcher, Search, the level's rows, its settings pinned to the foot, the person's
 * menu) sits on it with 8 px around; the page is a card beside it that stays put while the page
 * scrolls inside it. In the card: the top bar (the sidebar's switch, breadcrumbs, and on a Site's
 * pages Staging, Edit on site and Publish all), a thin progress line under it while the next page
 * loads, the secondary sidebar of the row the page sits under, and the page's column at the width
 * its route asks for. `docs/development.md` › "Admin screens" says how a screen fits in.
 */
export function AdminShell({
	shell,
	person,
	place,
	children,
}: {
	shell: ShellContext;
	person: SignedInPerson;
	place: AdminPlace;
	children: ReactNode;
}) {
	const pageRegions = usePageRegionsState();
	return (
		<SidebarProvider>
			<NavigationProvider place={place} shell={shell}>
				<AdminSidebar shell={shell} person={person} place={place} />
				<SidebarInset>
					{/* The top bar's Publish all opens a sheet over the page card too. */}
					<PageRegionsProvider value={pageRegions.regions}>
						<TopBar shell={shell} place={place} />
						<PageCard shell={shell} place={place} regions={pageRegions}>
							{children}
						</PageCard>
					</PageRegionsProvider>
				</SidebarInset>
			</NavigationProvider>
		</SidebarProvider>
	);
}

function TopBar({ shell, place }: { shell: ShellContext; place: AdminPlace }) {
	const t = useT();
	const installName = shell.install.name ?? t("app.name");
	// The editing bar links to Publish all with `?publishAll=1`: the list opens at once.
	const publishAllAsked = useRouterState({
		select: (state) => String((state.location.search as { publishAll?: unknown }).publishAll ?? "") === "1",
	});
	const mayPublish =
		place.level === "site" &&
		(place.permissions.includes("entry.publish") || place.permissions.includes("structure.edit"));
	// The Staging address and Edit mode open only as yourself, never while impersonating.
	const mayStage = place.level === "site" && !shell.impersonation;
	const mayEdit = place.level === "site" && place.permissions.includes("entry.edit") && !shell.impersonation;
	return (
		<header className="@container/bar relative flex h-14 shrink-0 items-center gap-3 border-b px-4">
			<SidebarTrigger label={t("shell.toggleSidebar")} />
			<Breadcrumbs place={place} installName={installName} />
			{place.level === "site" ? (
				<div className="ms-auto flex shrink-0 items-center gap-2">
					{/* Where the bar is narrow (a phone), Staging and Edit on site wait in one menu. */}
					<div className="hidden items-center gap-2 @3xl/bar:flex">
						{mayStage ? <StagingButton siteId={place.site.id} /> : null}
						{mayEdit ? <EditOnSiteButton siteId={place.site.id} /> : null}
					</div>
					{mayStage || mayEdit ? (
						<SiteActionsMenu siteId={place.site.id} staging={mayStage} edit={mayEdit} className="@3xl/bar:hidden" />
					) : null}
					{mayPublish ? <PublishAllButton siteId={place.site.id} count={place.drafts} open={publishAllAsked} /> : null}
					{/* A Review opens over any screen of the Site, from `?review=<id>`. */}
					<ReviewFromAddress siteId={place.site.id} />
				</div>
			) : null}
			<RouteProgress />
		</header>
	);
}

/**
 * A thin line under the top bar while the next page loads, once that takes longer than 150 ms (a
 * quick change shows nothing). It is a progress bar for assistive technology, named "Loading the page".
 */
function RouteProgress() {
	const t = useT();
	const pending = useRouterState({ select: (state) => state.status === "pending" });
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!pending) {
			setShown(false);
			return;
		}
		const timer = window.setTimeout(() => setShown(true), 150);
		return () => window.clearTimeout(timer);
	}, [pending]);
	if (!shown) return null;
	return (
		<div
			role="progressbar"
			aria-label={t("shell.loading")}
			data-slot="route-progress"
			className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
		>
			<div className="bg-primary animate-route-progress h-full w-1/3 motion-reduce:w-full motion-reduce:animate-none" />
		</div>
	);
}

/**
 * The card under the top bar: the secondary sidebar (the navigation's, or one a screen shows in its
 * place), then the page's column, which scrolls, with the banners above the page and a settings
 * form's foot bar below what scrolls. Sheets cover all of it (not the top bar) under a dark layer.
 */
function PageCard({
	shell,
	place,
	regions: { setCover, setFoot, setAside, asideClaimed },
	children,
}: {
	shell: ShellContext;
	place: AdminPlace;
	regions: ReturnType<typeof usePageRegionsState>;
	children: ReactNode;
}) {
	const { position } = useNavigation();
	const width = useRouteWidth();
	const parent = position.parent;
	return (
		<div ref={setCover} className="relative flex min-h-0 flex-1">
			<div ref={setAside} className="contents" />
			{parent && !asideClaimed ? <NavigationSecondary parent={parent} current={position.secondary} /> : null}
			<main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
				{parent && !asideClaimed ? <NavigationSecondaryMenu parent={parent} current={position.secondary} /> : null}
				<div className="min-h-0 flex-1 overflow-y-auto" data-slot="page-scroll">
					{shell.impersonation ? (
						<ImpersonationBanner key={String(shell.impersonation.endsAt)} impersonation={shell.impersonation} />
					) : null}
					{shell.banners.health && shell.banners.health.failing.length > 0 ? (
						<HealthBanner failing={shell.banners.health.failing} />
					) : null}
					{/* Install health's banner says it once the Install SMTP's failure makes that part Failing. */}
					{shell.banners.smtpFailing && !shell.banners.health?.failing.includes("smtp") ? <SmtpFailingBanner /> : null}
					{shell.banners.masterKey ? <MasterKeyBanner /> : null}
					{/* Install health's banner says it once the last Backup's failure makes that part Failing. */}
					{shell.banners.backupFailing && !shell.banners.health?.failing.includes("backups") ? (
						<BackupFailingBanner />
					) : null}
					{shell.twoFactor?.reminder ? <TwoFactorReminderBanner /> : null}
					{shell.banners.update && place.level === "install" ? <UpdateBanner update={shell.banners.update} /> : null}
					{/*
					 * The page's own breakpoints follow this area, not the window: a screen's columns
					 * (`@2xl/page:`, `@4xl/page:`, `@6xl/page:`) fit whether a secondary sidebar is there.
					 */}
					<div className="@container/page p-4 md:p-8">
						<PageColumn width={width}>{children}</PageColumn>
					</div>
				</div>
				<div ref={setFoot} className="shrink-0 empty:hidden" data-slot="page-foot" />
			</main>
		</div>
	);
}

function AdminSidebar({ shell, person, place }: { shell: ShellContext; person: SignedInPerson; place: AdminPlace }) {
	const t = useT();
	const navigation = useNavigation();
	return (
		<Sidebar variant="inset" mobileTitle={t("shell.navLabel")}>
			<nav aria-label={t("shell.navLabel")} className="flex min-h-0 flex-1 flex-col">
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<ContextSwitcher shell={shell} place={place} />
						</SidebarMenuItem>
					</SidebarMenu>
					<AdminSearch shell={shell} place={place} />
				</SidebarHeader>
				{/* The groups follow one another with no gap of their own: each has 8 px around it. */}
				<SidebarContent className="gap-0">
					{navigation.groups.map((group) => (
						<SidebarGroup key={group.id}>
							{group.label ? (
								<SidebarGroupLabel id={`nav-${group.id}`} className="text-muted-foreground">
									{t(group.label)}
								</SidebarGroupLabel>
							) : null}
							<SidebarGroupContent>
								<SidebarMenu aria-labelledby={group.label ? `nav-${group.id}` : undefined}>
									{group.rows.map((row) => (
										<NavItem key={row.id} row={row} />
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					))}
				</SidebarContent>
				{/* The level's settings, pinned above the person; the foot has no rule above it. */}
				{navigation.footer.length > 0 ? (
					<SidebarGroup>
						<SidebarMenu>
							{navigation.footer.map((row) => (
								<NavItem key={row.id} row={row} />
							))}
						</SidebarMenu>
					</SidebarGroup>
				) : null}
				<SidebarFooter>
					<SidebarMenu>
						<SidebarMenuItem>
							<UserMenu person={person} shell={shell} />
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarFooter>
			</nav>
		</Sidebar>
	);
}

/**
 * One row of the sidebar: its icon, its name, then a badge, a count, and a chevron when it opens a
 * secondary sidebar. The current row is shown and says so (`aria-current`): `page` on its own page,
 * `true` while the page is one of its secondary sidebar's.
 */
function NavItem({ row }: { row: NavRow }) {
	const label = useRowLabel();
	const { position } = useNavigation();
	const { isMobile, setOpenMobile } = useSidebar();
	const isCurrent = position.primary?.id === row.id;
	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				isActive={isCurrent}
				render={
					<RowLink
						row={row}
						current={isCurrent ? (position.secondary ? "true" : "page") : undefined}
						// On a phone the sidebar is a sheet over the page: a choice closes it.
						onClick={isMobile ? () => setOpenMobile(false) : undefined}
					/>
				}
			>
				<row.icon aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate">{label(row.label)}</span>
				{row.badge ? <RowBadge badge={row.badge} className="shrink-0" /> : null}
				{row.count !== undefined ? (
					<span className="text-muted-foreground shrink-0 text-xs tabular-nums">{row.count}</span>
				) : null}
				{row.sections ? (
					<ChevronRightIcon className={cn("text-muted-foreground size-3.5! rtl:rotate-180")} aria-hidden="true" />
				) : null}
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}
