import type { Database } from "@webcraft/db";

import { readSettingsRow, writeSettingsRow } from "../install-settings.ts";
import {
	FOOTER_MAX_LENGTH,
	isAccentColour,
	isLogoUrl,
	LOGO_URL_MAX_LENGTH,
	SENDER_NAME_MAX_LENGTH,
} from "./branding-rules.ts";

/**
 * Install branding: what the Superadmin sets for every System email. Null means the default: the
 * Install's name (or WebCraft) as sender name, no logo, WebCraft's accent colour, no footer text.
 */
export type InstallBrandingValues = {
	senderName: string | null;
	/** An HTTPS address of the logo image. */
	logoUrl: string | null;
	/** `#rrggbb`. */
	accentColour: string | null;
	footer: string | null;
};

/** Install branding with every default filled in, as an email uses it. */
export type EmailBranding = {
	senderName: string;
	logoUrl: string | null;
	accentColour: string;
	footer: string | null;
	/** The Install's name, or WebCraft when it has none. */
	installName: string;
};

export type InstallBranding = {
	read(): Promise<InstallBrandingValues>;
	/** Changes the given values (null resets one to its default) and answers all of them. */
	update(changes: Partial<InstallBrandingValues>): Promise<InstallBrandingValues>;
	/** The branding an email is sent with, defaults filled in. */
	resolve(): Promise<EmailBranding>;
};

/** WebCraft's own accent colour for emails: the admin's orange, dark enough for white text. */
export const DEFAULT_ACCENT_COLOUR = "#c2410c";

export { FOOTER_MAX_LENGTH, isAccentColour, isLogoUrl, LOGO_URL_MAX_LENGTH, SENDER_NAME_MAX_LENGTH };

const PRODUCT_NAME = "WebCraft";

export function createInstallBranding(database: Database): InstallBranding {
	const read = async (): Promise<InstallBrandingValues> => {
		const row = await readSettingsRow(database.db);
		return {
			senderName: row?.emailSenderName ?? null,
			logoUrl: row?.emailLogoUrl ?? null,
			accentColour: row?.emailAccentColour ?? null,
			footer: row?.emailFooter ?? null,
		};
	};
	return {
		read,
		async update(changes) {
			const values: Parameters<typeof writeSettingsRow>[1] = {};
			if (changes.senderName !== undefined) values.emailSenderName = checkSenderName(changes.senderName);
			if (changes.logoUrl !== undefined) values.emailLogoUrl = checkLogoUrl(changes.logoUrl);
			if (changes.accentColour !== undefined) values.emailAccentColour = checkAccentColour(changes.accentColour);
			if (changes.footer !== undefined) values.emailFooter = checkFooter(changes.footer);
			if (Object.keys(values).length > 0) await writeSettingsRow(database.db, values);
			return read();
		},
		async resolve() {
			const row = await readSettingsRow(database.db);
			const installName = row?.name ?? PRODUCT_NAME;
			return {
				senderName: row?.emailSenderName ?? installName,
				logoUrl: row?.emailLogoUrl ?? null,
				accentColour: row?.emailAccentColour ?? DEFAULT_ACCENT_COLOUR,
				footer: row?.emailFooter ?? null,
				installName,
			};
		},
	};
}

function checkSenderName(value: string | null): string | null {
	const name = value?.replace(/\s+/g, " ").trim();
	if (!name) return null;
	if (name.length > SENDER_NAME_MAX_LENGTH) throw new TypeError("The sender name is too long.");
	return name;
}

function checkLogoUrl(value: string | null): string | null {
	const address = value?.trim();
	if (!address) return null;
	if (!isLogoUrl(address)) throw new TypeError("The logo must be an HTTPS address.");
	return address;
}

function checkAccentColour(value: string | null): string | null {
	const colour = value?.trim().toLowerCase();
	if (!colour) return null;
	if (!isAccentColour(colour)) throw new TypeError("The accent colour must look like #c2410c.");
	return colour;
}

function checkFooter(value: string | null): string | null {
	const footer = value?.replace(/\r\n?/g, "\n").trim();
	if (!footer) return null;
	if (footer.length > FOOTER_MAX_LENGTH) throw new TypeError("The footer text is too long.");
	return footer;
}
