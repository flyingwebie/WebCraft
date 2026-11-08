/**
 * The languages the admin ships in. Each has a complete message file in the admin; `dir` is the
 * writing direction the admin is laid out in.
 */
export const ADMIN_LANGUAGES = [
	{ code: "en", name: "English", dir: "ltr" },
	{ code: "it", name: "Italiano", dir: "ltr" },
] as const;

export type AdminLanguageCode = (typeof ADMIN_LANGUAGES)[number]["code"];

/** The Install's default Admin language until the Superadmin chooses another. */
export const DEFAULT_ADMIN_LANGUAGE: AdminLanguageCode = "en";

export const ADMIN_LANGUAGE_CODES = ADMIN_LANGUAGES.map((language) => language.code) as [
	AdminLanguageCode,
	...AdminLanguageCode[],
];

export function isAdminLanguage(code: string): code is AdminLanguageCode {
	return ADMIN_LANGUAGES.some((language) => language.code === code);
}

/** The writing direction of an Admin language. */
export function adminLanguageDirection(code: AdminLanguageCode): "ltr" | "rtl" {
	return ADMIN_LANGUAGES.find((language) => language.code === code)?.dir ?? "ltr";
}
