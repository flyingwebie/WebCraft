// The rules for Install branding values, with no imports, so the admin's browser code can check a
// form with exactly the rules the server applies (`@webcraft/core/email-branding`).

export const SENDER_NAME_MAX_LENGTH = 80;
export const FOOTER_MAX_LENGTH = 500;
export const LOGO_URL_MAX_LENGTH = 2048;

/** An accent colour as Install branding takes it: `#rrggbb`. */
export function isAccentColour(value: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** A logo address as Install branding takes it: an absolute HTTPS URL. */
export function isLogoUrl(value: string): boolean {
	if (value.length > LOGO_URL_MAX_LENGTH) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}
