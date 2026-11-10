import { Link, useMatches, useMatchRoute, useRouterState } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
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
} from "@webcraft/ui/components/sidebar.tsx";
import { PuzzleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useT } from "../i18n.tsx";
import { PublishAllButton } from "../publishing/PublishAll.tsx";
import { BackupFailingBanner } from "./BackupFailingBanner.tsx";
import { Breadcrumbs } from "./Breadcrumbs.tsx";
import { ContextSwitcher } from "./ContextSwitcher.tsx";
import type { ShellContext, SignedInPerson } from "./context.ts";
import { EditOnSiteButton } from "./EditOnSiteButton.tsx";
import { ImpersonationBanner } from "./ImpersonationBanner.tsx";
import { type AdminPlace, navigationFor, placeParams } from "./levels.ts";
import { MasterKeyBanner } from "./MasterKeyBanner.tsx";
import { SmtpFailingBanner } from "./SmtpFailingBanner.tsx";
import { StagingButton } from "./StagingButton.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { TwoFactorReminderBanner } from "./TwoFactorReminderBanner.tsx";
import { UpdateBanner } from "./UpdateBanner.tsx";
import { UserMenu } from "./UserMenu.tsx";

/**
 * The admin shell: one sidebar (the context switcher, the current level's items, the person's menu
 * and the light/dark switch), a top bar with breadcrumbs (and on a Site's pages, Staging, Edit on
 * site and Publish all with how many changes it holds), and the page. Banners show above the page.
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
	const t = useT();
	const wide = useMatches().some((match) => match.staticData.wide);
	// The editing bar links to Publish all with `?publishAll=1`: the list opens at once.
	const publishAllAsked = useRouterState({
		select: (state) => String((state.location.search as { publishAll?: unknown }).publishAll ?? "") === "1",
	});
	const mayPublish =
		place.level === "site" &&
		(place.permissions.includes("entry.publish") || place.permissions.includes("structure.edit"));
	return (
		<SidebarProvider>
			<AdminSidebar shell={shell} person={person} place={place} />
			<SidebarInset>
				<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger label={t("shell.toggleSidebar")} />
					<Breadcrumbs place={place} />
					{place.level === "site" ? (
						<div className="ms-auto flex items-center gap-2">
							{/* The Staging address and Edit mode open only as yourself, never while impersonating. */}
							{shell.impersonation ? null : <StagingButton siteId={place.site.id} />}
							{place.permissions.includes("entry.edit") && !shell.impersonation ? (
								<EditOnSiteButton siteId={place.site.id} />
							) : null}
							{mayPublish ? (
								<PublishAllButton siteId={place.site.id} count={place.drafts} open={publishAllAsked} />
							) : null}
						</div>
					) : null}
				</header>
				<main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
					{shell.impersonation ? (
						<ImpersonationBanner key={String(shell.impersonation.endsAt)} impersonation={shell.impersonation} />
					) : null}
					{shell.banners.smtpFailing ? <SmtpFailingBanner /> : null}
					{shell.banners.masterKey ? <MasterKeyBanner /> : null}
					{shell.banners.backupFailing ? <BackupFailingBanner /> : null}
					{shell.twoFactor?.reminder ? <TwoFactorReminderBanner /> : null}
					{shell.banners.update && place.level === "install" ? <UpdateBanner update={shell.banners.update} /> : null}
					<div className={`mx-auto w-full flex-1 p-6 md:p-10 ${wide ? "max-w-screen-2xl" : "max-w-5xl"}`}>
						{children}
					</div>
				</main>
			</SidebarInset>
		</SidebarProvider>
	);
}

function AdminSidebar({ shell, person, place }: { shell: ShellContext; person: SignedInPerson; place: AdminPlace }) {
	const t = useT();
	const matchRoute = useMatchRoute();
	const navigation = navigationFor(place);
	const params = placeParams(place);
	const modulePages = place.level === "install" ? [] : place.modulePages;

	return (
		<Sidebar mobileTitle={t("shell.navLabel")}>
			<nav aria-label={t("shell.navLabel")} className="flex min-h-0 flex-1 flex-col">
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<ContextSwitcher shell={shell} place={place} />
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>
				<SidebarContent>
					{navigation.groups.map((group) => (
						<SidebarGroup key={group.id}>
							<SidebarGroupLabel id={`nav-${group.id}`} className="justify-between">
								{t(group.label)}
								{group.note ? (
									<Badge variant="outline" className="font-normal">
										{t(group.note)}
									</Badge>
								) : null}
							</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu aria-labelledby={`nav-${group.id}`}>
									{group.items.map((item) => {
										const itemParams = { ...params, ...item.params };
										const active = Boolean(
											matchRoute({ to: item.to, params: itemParams as never, fuzzy: !item.exact }),
										);
										return (
											<SidebarMenuItem key={item.id}>
												<SidebarMenuButton
													render={<Link to={item.to} params={itemParams as never} />}
													isActive={active}
												>
													<item.icon aria-hidden="true" />
													<span>{typeof item.label === "string" ? t(item.label) : item.label.text}</span>
													{item.reviews && place.level === "site" && place.reviews > 0 ? (
														<Badge variant="secondary" className="ms-auto">
															{t("review.navBadge", { count: place.reviews })}
														</Badge>
													) : null}
												</SidebarMenuButton>
											</SidebarMenuItem>
										);
									})}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					))}
					{modulePages.length > 0 ? (
						<SidebarGroup>
							<SidebarGroupLabel id="nav-module-pages">{t("shell.nav.modulePagesGroup")}</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu aria-labelledby="nav-module-pages">
									{modulePages.map((page) => {
										const link =
											place.level === "site"
												? ({ to: "/sites/$siteId/m/$moduleId/$", params: { siteId: place.site.id } } as const)
												: ({
														to: "/workspaces/$workspaceId/m/$moduleId/$",
														params: { workspaceId: params.workspaceId ?? "" },
													} as const);
										const pageParams = { ...link.params, moduleId: page.moduleId, _splat: page.path };
										const active = Boolean(matchRoute({ to: link.to, params: pageParams as never }));
										return (
											<SidebarMenuItem key={`${page.moduleId}/${page.path}`}>
												<SidebarMenuButton
													render={<Link to={link.to} params={pageParams as never} />}
													isActive={active}
												>
													<PuzzleIcon aria-hidden="true" />
													<span>{page.label}</span>
												</SidebarMenuButton>
											</SidebarMenuItem>
										);
									})}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					) : null}
				</SidebarContent>
				<SidebarFooter className="border-sidebar-border border-t">
					<SidebarMenu>
						<SidebarMenuItem className="flex items-center gap-1">
							<UserMenu person={person} />
							{/* Light or dark is the person's own preference: never changed while impersonating them. */}
							{shell.impersonation ? null : <ThemeSwitch theme={shell.theme} />}
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarFooter>
			</nav>
		</Sidebar>
	);
}
