import { Link, useRouter } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { SidebarMenuButton } from "@webcraft/ui/components/sidebar.tsx";
import { BotIcon, ChevronsUpDownIcon, KeyRoundIcon, LogOutIcon, UserIcon } from "lucide-react";

import { getApi } from "../api.ts";
import { useT } from "../i18n.tsx";
import { initials, roleLabel, type SignedInPerson } from "./context.ts";

/** The signed-in person's name and role, opening their account menu. */
export function UserMenu({ person }: { person: SignedInPerson }) {
	const t = useT();
	const router = useRouter();
	const role = t(roleLabel(person.installRole));

	const signOut = async () => {
		const api = await getApi();
		await api.session.signOut();
		await router.navigate({ to: "/sign-in" });
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
				<Avatar className="size-8">
					<AvatarFallback>{initials(person.name)}</AvatarFallback>
				</Avatar>
				<span className="grid flex-1 text-start leading-tight">
					<span className="truncate font-medium">{person.name}</span>
					<span className="text-muted-foreground truncate text-xs">{role}</span>
				</span>
				<span className="sr-only">{t("shell.userMenu.label")}</span>
				<ChevronsUpDownIcon className="ms-auto size-4" aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="min-w-56">
				<DropdownMenuGroup>
					<DropdownMenuItem render={<Link to="/account" />}>
						<UserIcon aria-hidden="true" />
						{t("shell.userMenu.account")}
					</DropdownMenuItem>
					<DropdownMenuItem render={<Link to="/account/api-tokens" />}>
						<KeyRoundIcon aria-hidden="true" />
						{t("shell.userMenu.apiTokens")}
					</DropdownMenuItem>
					<DropdownMenuItem render={<Link to="/account/ai-clients" />}>
						<BotIcon aria-hidden="true" />
						{t("shell.userMenu.aiClients")}
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={signOut}>
						<LogOutIcon aria-hidden="true" />
						{t("shell.userMenu.signOut")}
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
