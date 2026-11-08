import type { ApiClient } from "@webcraft/api";

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
