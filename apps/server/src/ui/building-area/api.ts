import type en from "../../messages/en.json";
import type { Layout } from "./docks/layout.ts";

/** The building area's words, in the person's Admin language (`buildingArea` in the message files). */
export type Words = (typeof en)["buildingArea"];

/** What the shell reads as it starts, from the JSON block its document carries. */
export type ShellConfig = {
	/** The Edit mode session's header token, which every edit request carries. */
	token: string;
	/**
	 * The page the address opens, when it opens a page: its path on the Site, with its query (null for
	 * a Template, a Component or a Form, and when it opens nothing). The shell reads its document from
	 * its own address (`documents.ts`), which Back and Forward change too.
	 */
	page: string | null;
	/** Where the logo tile goes back to: an address on the admin. */
	returnTo: string;
	/** The person's Admin language, and the shell's words in it. */
	language: string;
	words: Words;
	/** Whether the frame's pages run in Safe mode (none of the Site's own scripts). */
	safe: boolean;
	/** The Site being edited. */
	site: { id: string; name: string };
	/** The person editing, for the avatar at the foot of the rail. */
	person: { name: string };
	/** The Design system's breakpoints (its Draft), narrowest first: the size readout names the one a width is in. */
	breakpoints: { name: string; width: number }[];
	/** Whether the Design system has Dark mode: the rail's Dark preview shows the page with its dark values. */
	darkMode: boolean;
	/**
	 * The Site's Staging address, for "View on Staging" (a new tab): null while the Site has none, or
	 * when the building area is on it already (a new tab there would open the building area again).
	 */
	staging: string | null;
	/** The Site's settings in the admin (the rail's Settings, in a new tab). */
	settings: string;
	/** The Site in the admin (`…/sites/<id>`): the places link to its screens for what they don't do. */
	admin: string;
	/** The Site's languages, the Default language first (the Content place's languages). */
	languages: { default: string; all: { code: string; name: string }[] };
	/** Where the person keeps their panels (their editor preferences); null for the defaults. */
	layout: Layout | null;
};

/** What the `state` edit request says of a page, as far as the shell reads it. */
export type PageState = {
	/** The page's changes in its Draft (its Entry's values, the Globals it shows, its Loops' items). */
	changes: unknown[];
	/** The Reviews of the page's items: waiting (`inReview`) or sent back. */
	reviews: { status: "inReview" | "sentBack" }[];
	/** The language the page is shown in. */
	language: { code: string; name: string };
	/** The page in each of the Site's languages (none on a Site with one language). */
	languages: { code: string; name: string; path: string; current: boolean }[];
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
