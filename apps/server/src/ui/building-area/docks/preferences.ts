import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { BuildingAreaApiClient } from "@webcraft/api";

import { LAYOUT_VERSION, type Layout, storedLayout } from "./layout.ts";

/** How long after the last change the layout is written (BA-05): a drag or a run of key presses saves once. */
export const SAVE_AFTER_MS = 500;

/** Where the Site's address serves the Management API to the building area (`site/building-area/api.ts`). */
const API_PATH = "/_webcraft/build/api/rpc";

/** The header the session's header token goes in, as every edit request carries it. */
const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

export type LayoutSaver = {
	/** Writes the layout (null: the defaults) to the person's editor preferences, 500 ms after the last change. */
	save(layout: Layout | null): void;
	/** Writes what is waiting now (leaving the page). */
	flush(): Promise<void>;
};

/**
 * Keeps the panel layout in the person's editor preferences (`me.saveEditorPreferences`, BA-03), on
 * the Site's address as the shell calls the Management API: the same on every Site and in every
 * browser they use. A write that fails is reported once until one succeeds again.
 */
export function layoutSaver(options: { siteId: string; token: string; failed(): void }): LayoutSaver {
	const api = createORPCClient(
		new RPCLink({
			url: new URL(API_PATH, window.location.origin).toString(),
			headers: { [EDIT_TOKEN_HEADER]: options.token },
			// Kept alive, so the last change is written even as the page goes.
			fetch: (request, init) => globalThis.fetch(request, { ...init, keepalive: true }),
		}),
	) as BuildingAreaApiClient;

	let waiting: { layout: Layout | null } | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let reported = false;

	const write = async () => {
		if (timer) clearTimeout(timer);
		timer = null;
		const next = waiting;
		waiting = null;
		if (!next) return;
		try {
			await api.me.saveEditorPreferences({
				siteId: options.siteId,
				preferences: { version: LAYOUT_VERSION, layout: storedLayout(next.layout) },
			});
			reported = false;
		} catch {
			if (!reported) options.failed();
			reported = true;
		}
	};

	return {
		save(layout) {
			waiting = { layout };
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void write(), SAVE_AFTER_MS);
		},
		flush: write,
	};
}
