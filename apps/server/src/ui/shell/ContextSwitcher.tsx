import { useNavigate } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { SidebarMenuButton } from "@webcraft/ui/components/sidebar.tsx";
import { ChevronsUpDownIcon } from "lucide-react";

import { useT } from "../i18n.tsx";
import { initials, roleLabel, type ShellContext } from "./context.ts";
import type { AdminPlace } from "./levels.ts";

/** Where the switcher can go: the Install, a Workspace or a Site, as one radio value. */
type Destination = "install" | `workspace:${string}` | `site:${string}`;

/**
 * The context switcher at the top of the sidebar: shows where the person is (the Install, a
 * Workspace or a Site) and moves between them: to the Install, to any Workspace they reach, and to
 * the Sites of the Workspace they are in.
 */
export function ContextSwitcher({ shell, place }: { shell: ShellContext; place: AdminPlace }) {
	const t = useT();
	const navigate = useNavigate();
	const installName = shell.install.name ?? t("app.name");
	const role = t(roleLabel(shell.person?.installRole ?? null));

	const { title, subtitle } =
		place.level === "install"
			? { title: installName, subtitle: t("shell.switcher.installSubtitle", { role }) }
			: place.level === "workspace"
				? {
						title: place.workspace.name,
						subtitle: t("shell.switcher.workspaceSubtitle", { count: place.sites.length }),
					}
				: {
						title: place.site.name,
						subtitle: t("shell.switcher.siteSubtitle", { workspace: place.workspace.name, slug: place.site.slug }),
					};
	const current: Destination =
		place.level === "install"
			? "install"
			: place.level === "workspace"
				? `workspace:${place.workspace.id}`
				: `site:${place.site.id}`;

	const go = (destination: Destination) => {
		const [kind, id = ""] = destination.split(":");
		if (kind === "workspace") void navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: id } });
		else if (kind === "site") void navigate({ to: "/sites/$siteId", params: { siteId: id } });
		else void navigate({ to: "/" });
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
				<Avatar className="size-8 rounded-md">
					<AvatarFallback className="bg-primary text-primary-foreground rounded-md">{initials(title)}</AvatarFallback>
				</Avatar>
				<span className="grid flex-1 text-start leading-tight">
					<span className="truncate font-semibold">{title}</span>
					<span className="text-muted-foreground truncate text-xs">{subtitle}</span>
				</span>
				<span className="sr-only">{t("shell.switcher.label")}</span>
				<ChevronsUpDownIcon className="ms-auto size-4" aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-[70svh] min-w-64">
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("shell.switcher.heading")}</DropdownMenuLabel>
					<DropdownMenuRadioGroup value={current} onValueChange={go}>
						<DropdownMenuRadioItem value="install">
							<span className="flex flex-col">
								<span>{installName}</span>
								<span className="text-muted-foreground text-xs">{t("shell.switcher.install")}</span>
							</span>
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				{shell.workspaces.length > 0 ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel>{t("shell.switcher.workspaces")}</DropdownMenuLabel>
							<DropdownMenuRadioGroup value={current} onValueChange={go}>
								{shell.workspaces.map((workspace) => (
									<DropdownMenuRadioItem key={workspace.id} value={`workspace:${workspace.id}`}>
										{workspace.name}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</>
				) : null}
				{place.level !== "install" && place.sites.length > 0 ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel>{t("shell.switcher.sitesIn", { workspace: place.workspace.name })}</DropdownMenuLabel>
							<DropdownMenuRadioGroup value={current} onValueChange={go}>
								{place.sites.map((site) => (
									<DropdownMenuRadioItem key={site.id} value={`site:${site.id}`}>
										<span className="flex flex-col">
											<span>{site.name}</span>
											<span className="text-muted-foreground text-xs">{site.slug}</span>
										</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
