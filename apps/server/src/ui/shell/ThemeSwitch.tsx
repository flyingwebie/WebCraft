import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { getApi } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { ShellContext } from "./context.ts";

/** Whether the device asks for dark colours. */
function deviceIsDark(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * The light/dark switch: a toggle button, pressed when the admin is dark. Until a person chooses,
 * the admin follows the device; the choice is saved with their account.
 */
export function ThemeSwitch({ theme }: { theme: ShellContext["theme"] }) {
	const t = useT();
	const router = useRouter();
	const [dark, setDark] = useState(theme === "dark");

	useEffect(() => {
		setDark(theme === "dark" || (theme === "system" && deviceIsDark()));
	}, [theme]);

	const toggle = async () => {
		const next = dark ? "light" : "dark";
		setDark(!dark);
		const api = await getApi();
		await api.me.updatePreferences({ adminTheme: next });
		// The page takes the new theme from the reloaded shell context, in one change.
		await router.invalidate();
	};

	return (
		<Button variant="ghost" size="icon" aria-pressed={dark} aria-label={t("shell.darkTheme")} onClick={toggle}>
			{dark ? <MoonIcon aria-hidden="true" /> : <SunIcon aria-hidden="true" />}
		</Button>
	);
}
