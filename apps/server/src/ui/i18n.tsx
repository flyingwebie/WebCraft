import type { AdminLanguageCode } from "@webcraft/core/admin-languages";
import type { ReactNode } from "react";
import { createTranslator, IntlProvider, useTranslations } from "use-intl";

import en from "../messages/en.json" with { type: "json" };
import it from "../messages/it.json" with { type: "json" };

/** Every admin message, by Admin language. Each file must say everything `en.json` says. */
export const adminMessages: Record<AdminLanguageCode, typeof en> = { en, it };

declare module "use-intl" {
	interface AppConfig {
		Messages: typeof en;
		Locale: AdminLanguageCode;
	}
}

/**
 * The time zone dates and times are shown in. People have no time zone setting yet, and the page
 * must render the same on the server and in the browser, so the admin shows UTC.
 */
export const ADMIN_TIME_ZONE = "UTC";

/** Shows everything inside in one Admin language. */
export function AdminIntl({ language, children }: { language: AdminLanguageCode; children: ReactNode }) {
	return (
		<IntlProvider locale={language} messages={adminMessages[language]} timeZone={ADMIN_TIME_ZONE}>
			{children}
		</IntlProvider>
	);
}

/** The admin's translator: `t("shell.nav.overview")`. */
export const useT = () => useTranslations();

/** Every message's dotted key, such as `shell.nav.overview`. */
type Leaves<T, Prefix extends string = ""> = {
	[Key in keyof T & string]: T[Key] extends string ? `${Prefix}${Key}` : Leaves<T[Key], `${Prefix}${Key}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof en>;

/** A page's `<title>` in an Admin language, for route `head()` functions (outside React). */
export function pageTitle(language: AdminLanguageCode, page: MessageKey): string {
	const t = createTranslator({ locale: language, messages: adminMessages[language] });
	return t("app.pageTitle", { page: t(page) });
}
