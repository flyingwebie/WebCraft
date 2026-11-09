import type { Permission } from "../permissions/roles.ts";

/**
 * The Permission an action on a publishable item needs, by its kind: `content` for Members' items
 * (Entries, the Globals, the Consent banner's words), `formEmails.edit` for a Form's emails (Content
 * whoever may edit them reaches), and `structure.edit` for Structure (Templates, Components, Loops,
 * Filters, scripts, Forms, the Design system). Publishing, reading history and restoring all split
 * items this way.
 */
export function itemPermission(kind: string, content: Permission): Permission {
	if (kind === "formEmails") return "formEmails.edit";
	return kind === "entry" || kind === "globals" || kind === "consentBanner" ? content : "structure.edit";
}
