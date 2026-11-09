import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiClient } from "@webcraft/api";
import { useEffect } from "react";

import { getApi } from "../api.ts";
import { type HistoryItem, itemSearch, readItem } from "./model.ts";

let closingClient: ApiClient | undefined;

/**
 * The Management API for a call made as the tab closes: its requests are sent with `keepalive`, so
 * the browser finishes them after the page is gone.
 */
function closingApi(): ApiClient {
	closingClient ??= createORPCClient(
		new RPCLink({
			url: new URL("/api/rpc", window.location.origin).toString(),
			fetch: (request, init) => globalThis.fetch(request, { ...init, keepalive: true }),
		}),
	);
	return closingClient;
}

/**
 * Tells the server an editor of `item` closed (`history.leave`), when the page using it unmounts and
 * when the tab closes, so its Draft is kept as a Checkpoint if it changed since the newest one. Until
 * Co-editing knows who else is editing, every editor closing counts as the last one.
 */
export function useLeaveOnClose(siteId: string, item: HistoryItem): void {
	const { item: kind, itemId } = itemSearch(item);
	useEffect(() => {
		const closed = readItem({ item: kind, itemId });
		if (!closed) return;
		let left = false;
		const leave = (api: Promise<ApiClient> | ApiClient) => {
			if (left) return;
			left = true;
			void Promise.resolve(api)
				.then((client) => client.history.leave({ siteId, item: closed }))
				.catch(() => {
					// Nothing to do: closing an editor never fails for the person.
				});
		};
		const onPageHide = () => leave(closingApi());
		window.addEventListener("pagehide", onPageHide);
		return () => {
			window.removeEventListener("pagehide", onPageHide);
			leave(getApi());
		};
	}, [siteId, kind, itemId]);
}
