import { useNavigate } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { SidebarMenuButton } from "@webcraft/ui/components/sidebar.tsx";
import { ChevronsUpDownIcon } from "lucide-react";

import { useT } from "../i18n.tsx";
import { initials, type ShellContext } from "./context.ts";
import { type AdminPlace, LEVEL_HOMES } from "./levels.ts";

/**
 * The context switcher at the top of the sidebar: shows where the person is (the Install, a
 * Workspace or a Site) and moves between them. Until Workspaces exist, the Install is the only place.
 */
export function ContextSwitcher({ shell, place }: { shell: ShellContext; place: AdminPlace }) {
	const t = useT();
	const navigate = useNavigate();
	const name = shell.install.name ?? t("app.name");
	const role = shell.person?.installRole === "superadmin" ? t("roles.superadmin") : t("roles.none");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
				<Avatar className="size-8 rounded-md">
					<AvatarFallback className="bg-primary text-primary-foreground rounded-md">{initials(name)}</AvatarFallback>
				</Avatar>
				<span className="grid flex-1 text-start leading-tight">
					<span className="truncate font-semibold">{name}</span>
					<span className="text-muted-foreground truncate text-xs">
						{t("shell.switcher.installSubtitle", { role })}
					</span>
				</span>
				<span className="sr-only">{t("shell.switcher.label")}</span>
				<ChevronsUpDownIcon className="ms-auto size-4" aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-64">
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("shell.switcher.heading")}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={place.level}
						onValueChange={(level: AdminPlace["level"]) => navigate({ to: LEVEL_HOMES[level] })}
					>
						<DropdownMenuRadioItem value="install">
							<span className="flex flex-col">
								<span>{name}</span>
								<span className="text-muted-foreground text-xs">{t("shell.switcher.install")}</span>
							</span>
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
