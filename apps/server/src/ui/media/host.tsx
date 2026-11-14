import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiClient } from "@webcraft/api";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";

import type { MediaItem } from "./preview.ts";

/**
 * The Media library's procedures the shared Media parts call (`ui/media/*`): what both the admin's
 * client (`/api/rpc`) and the building area's (the Site's address, `BUILDING_AREA_PROCEDURES`) answer.
 */
export type MediaApi = Pick<
	ApiClient["media"],
	| "list"
	| "get"
	| "overview"
	| "usage"
	| "upload"
	| "update"
	| "replace"
	| "importUrl"
	| "delete"
	| "restore"
	| "deleteForever"
	| "emptyTrash"
> & { folders: Pick<ApiClient["media"]["folders"], "list" | "create" | "rename" | "delete"> };

/** A place a file is used, as `media.usage` answers it. */
export type MediaUse = Awaited<ReturnType<ApiClient["media"]["usage"]>>["usedIn"][number];

/** How the host links a place a file is used in: `children` in its link, or as words where it has none for that place. */
export type MediaUseLink = ComponentType<{
	siteId: string;
	use: MediaUse;
	/** Whether the person may change Structure (Loops and the SEO settings are theirs). */
	structure: boolean;
	className: string;
	children: ReactNode;
}>;

/**
 * Where the shared Media parts run (the admin's Media screen, or the building area's Media place on the
 * Site's address), and what they need from it. The parts import no router and no client of their own,
 * so the building area's shell reuses them as they are (ADR 0037, BA-22).
 */
export type MediaHost = {
	/** The Management API's Media procedures, as the host calls them. */
	api(): Promise<MediaApi>;
	/** Whether files are shown from the Site's own `/_media/` (on the Site's address), not through the admin. */
	site: boolean;
	/** How a place that uses a file links to where it is changed; null: words without a link. */
	UseLink: MediaUseLink | null;
	/**
	 * A picker of the host's own for a media Field's Choose (the building area's Media place in a
	 * dialog): answers the chosen file, or null when nothing was chosen. Null: the Field's own dialog.
	 */
	choose: ((request: { siteId: string; current: string | null }) => Promise<MediaItem | null>) | null;
	/** Where focus goes once the control a dialog came from is gone (a file moved to the Trash). */
	focusMain(): void;
};

let adminClient: ApiClient | undefined;

/** The admin's Media procedures, from the browser (the parts call them only from what people do). */
async function adminMedia(): Promise<MediaApi> {
	adminClient ??= createORPCClient(new RPCLink({ url: new URL("/api/rpc", window.location.origin).toString() }));
	return adminClient.media;
}

/** The admin's host: its own Management API, previews through the admin, links left to the screen that knows its routes. */
export const ADMIN_MEDIA_HOST: MediaHost = {
	api: adminMedia,
	site: false,
	UseLink: null,
	choose: null,
	focusMain: () => document.getElementById("main")?.focus(),
};

const MediaHostContext = createContext<MediaHost>(ADMIN_MEDIA_HOST);

/** Gives the Media parts inside their host. */
export const MediaHostProvider = MediaHostContext.Provider;

/** The host the Media parts run in (the admin's, unless one is given). */
export function useMediaHost(): MediaHost {
	return useContext(MediaHostContext);
}
