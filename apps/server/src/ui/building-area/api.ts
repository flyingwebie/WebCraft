import type en from "../../messages/en.json";

/** The building area's words, in the person's Admin language (`buildingArea` in the message files). */
export type Words = (typeof en)["buildingArea"];

/** What the shell reads as it starts, from the JSON block its document carries. */
export type ShellConfig = {
	/** The Edit mode session's header token, which every edit request carries. */
	token: string;
	/** The page the frame opens: its path on the Site, with its query. */
	page: string;
	/** Where the logo tile goes back to: an address on the admin. */
	returnTo: string;
	/** The person's Admin language, and the shell's words in it. */
	language: string;
	words: Words;
	/** Whether the frame's pages run in Safe mode (none of the Site's own scripts). */
	safe: boolean;
};

/** An edit request's answer: its JSON, or the refusal's code. */
export type EditAnswer<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

/** Sends edit requests (`/_webcraft/edit/api/<action>`) for the session, as the editing bar does. */
export type EditRequests = <T = unknown>(action: string, body: unknown) => Promise<EditAnswer<T>>;

/** The header edit requests carry the session's header token in. */
const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

/**
 * The edit requests of the Site's own page (`save`, `state`, …), from the shell: a `POST` of JSON to
 * the Site's own address with the session's header token, the edit cookie going with it.
 */
export function editRequests(token: string): EditRequests {
	return async <T>(action: string, body: unknown): Promise<EditAnswer<T>> => {
		try {
			const response = await fetch(`/_webcraft/edit/api/${action}`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", [EDIT_TOKEN_HEADER]: token },
				body: JSON.stringify(body),
			});
			const data: unknown = await response.json().catch(() => null);
			if (response.ok) return { ok: true, data: data as T };
			const code = (data as { code?: unknown } | null)?.code;
			return { ok: false, status: response.status, code: typeof code === "string" ? code : "generic" };
		} catch {
			return { ok: false, status: 0, code: "network" };
		}
	};
}

/** A word with its `{name}` parts filled in. */
export function fill(text: string, values: Record<string, string> = {}): string {
	return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
