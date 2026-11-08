import type { ApiClient } from "@webcraft/api";

import type { MessageKey } from "../i18n.tsx";

/** What every admin page knows: who is signed in, the Admin language and theme, banners to show. */
export type ShellContext = Awaited<ReturnType<ApiClient["shell"]["context"]>>;

export type SignedInPerson = NonNullable<ShellContext["person"]>;

/** Up to two initials for an avatar: "Ada Lovelace" → "AL". */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
	return letters
		.map((word) => Array.from(word ?? "")[0] ?? "")
		.join("")
		.toLocaleUpperCase();
}

/** The message naming a person's Install-level role: Superadmin, Staff, or just signed in. */
export function roleLabel(installRole: string | null): MessageKey {
	switch (installRole) {
		case "superadmin":
			return "roles.superadmin";
		case "staff":
			return "roles.staff";
		default:
			return "roles.none";
	}
}
