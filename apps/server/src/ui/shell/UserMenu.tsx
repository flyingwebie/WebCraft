import { Link, useRouter } from "@tanstack/react-router";
import { ADMIN_LANGUAGES, type AdminLanguageCode, isAdminLanguage } from "@webcraft/core/admin-languages";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { SidebarMenuButton, useSidebar } from "@webcraft/ui/components/sidebar.tsx";
import { ChevronsUpDownIcon, LanguagesIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon, UserIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { initials, roleLabel, type ShellContext, type SignedInPerson } from "./context.ts";

type Theme = SignedInPerson["adminTheme"];

const THEMES: { value: Theme; label: MessageKey; icon: typeof SunIcon }[] = [
	{ value: "system", label: "shell.userMenu.themeSystem", icon: MonitorIcon },
	{ value: "light", label: "shell.userMenu.themeLight", icon: SunIcon },
	{ value: "dark", label: "shell.userMenu.themeDark", icon: MoonIcon },
];

/** The Install default's place in the Admin language list: no language of the person's own. */
const INSTALL_DEFAULT = "install-default";

/**
 * The person's row at the sidebar's foot: their name and role, opening their menu: Account, Admin
 * language, the Theme (System follows the device, or Light, or Dark) and Sign out. Language and Theme
 * are the person's own and saved with their account at once; while someone impersonates them, neither
 * can be changed.
 */
export function UserMenu({ person, shell }: { person: SignedInPerson; shell: ShellContext }) {
	const t = useT();
	const router = useRouter();
	const { isMobile, setOpenMobile } = useSidebar();
	const role = t(roleLabel(person.installRole));
	const [theme, setTheme] = useState<Theme>(person.adminTheme);
	// A change made elsewhere (Your account) shows here too.
	useEffect(() => setTheme(person.adminTheme), [person.adminTheme]);
	const ownPreferences = !shell.impersonation;
	const installDefault = ADMIN_LANGUAGES.find((option) => option.code === shell.install.defaultAdminLanguage)?.name;

	const save = async (changes: { adminTheme?: Theme; adminLanguage?: AdminLanguageCode | null }) => {
		try {
			const api = await getApi();
			await api.me.updatePreferences(changes);
			// The page takes the new theme or language from the reloaded shell context, in one change.
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	const signOut = async () => {
		const api = await getApi();
		await api.session.signOut();
		await router.navigate({ to: "/sign-in" });
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
				<Avatar className="size-8">
					<AvatarFallback className="bg-sidebar-accent">{initials(person.name)}</AvatarFallback>
				</Avatar>
				<span className="grid flex-1 text-start leading-tight">
					<span className="truncate font-medium">{person.name}</span>
					<span className="text-muted-foreground truncate text-xs">{role}</span>
				</span>
				<span className="sr-only">{t("shell.userMenu.label")}</span>
				<ChevronsUpDownIcon className="ms-auto size-4" aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="min-w-60">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="truncate">{person.name}</DropdownMenuLabel>
					<DropdownMenuItem render={<Link to="/account" />} onClick={isMobile ? () => setOpenMobile(false) : undefined}>
						<UserIcon aria-hidden="true" />
						{t("shell.userMenu.account")}
					</DropdownMenuItem>
					{ownPreferences ? (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<LanguagesIcon aria-hidden="true" />
								{t("shell.userMenu.adminLanguage")}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="min-w-52">
								<DropdownMenuRadioGroup
									value={person.adminLanguage ?? INSTALL_DEFAULT}
									onValueChange={(value: string) => void save({ adminLanguage: isAdminLanguage(value) ? value : null })}
								>
									<DropdownMenuRadioItem value={INSTALL_DEFAULT} closeOnClick>
										{t("account.preferences.installDefault", { language: installDefault ?? "" })}
									</DropdownMenuRadioItem>
									{ADMIN_LANGUAGES.map((option) => (
										<DropdownMenuRadioItem key={option.code} value={option.code} lang={option.code} closeOnClick>
											{option.name}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					) : null}
				</DropdownMenuGroup>
				{ownPreferences ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel>{t("shell.userMenu.theme")}</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={theme}
								onValueChange={(value: Theme) => {
									setTheme(value);
									void save({ adminTheme: value });
								}}
							>
								{THEMES.map((option) => (
									<DropdownMenuRadioItem key={option.value} value={option.value}>
										<option.icon aria-hidden="true" />
										{t(option.label)}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</>
				) : null}
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
