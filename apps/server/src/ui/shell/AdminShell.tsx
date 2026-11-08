import { Link, useMatchRoute } from "@tanstack/react-router";
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
import type { ReactNode } from "react";

import { useT } from "../i18n.tsx";
import { Breadcrumbs } from "./Breadcrumbs.tsx";
import { ContextSwitcher } from "./ContextSwitcher.tsx";
import type { ShellContext, SignedInPerson } from "./context.ts";
import { type AdminPlace, navigationFor, placeParams } from "./levels.ts";
import { MasterKeyBanner } from "./MasterKeyBanner.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { UserMenu } from "./UserMenu.tsx";

/**
 * The admin shell: one sidebar (the context switcher, the current level's items, the person's menu
 * and the light/dark switch), a top bar with breadcrumbs, and the page. Banners show above the page.
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
	return (
		<SidebarProvider>
			<AdminSidebar shell={shell} person={person} place={place} />
			<SidebarInset>
				<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger label={t("shell.toggleSidebar")} />
					<Breadcrumbs place={place} />
				</header>
				<main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
					{shell.banners.masterKey ? <MasterKeyBanner /> : null}
					<div className="mx-auto w-full max-w-5xl flex-1 p-6 md:p-10">{children}</div>
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
							<SidebarGroupLabel id={`nav-${group.id}`}>{t(group.label)}</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu aria-labelledby={`nav-${group.id}`}>
									{group.items.map((item) => {
										const active = Boolean(matchRoute({ to: item.to, params: params as never, fuzzy: !item.exact }));
										return (
											<SidebarMenuItem key={item.id}>
												<SidebarMenuButton render={<Link to={item.to} params={params as never} />} isActive={active}>
													<item.icon aria-hidden="true" />
													<span>{t(item.label)}</span>
												</SidebarMenuButton>
											</SidebarMenuItem>
										);
									})}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					))}
				</SidebarContent>
				<SidebarFooter className="border-sidebar-border border-t">
					<SidebarMenu>
						<SidebarMenuItem className="flex items-center gap-1">
							<UserMenu person={person} />
							<ThemeSwitch theme={shell.theme} />
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarFooter>
			</nav>
		</Sidebar>
	);
}
