import { createDraftClient, DRAFTS_PROTOCOL, type Json } from "@webcraft/core/draft-document";
import { editorHistory, type HistoryResult } from "./editor-history.ts";

type Request = <T>(method: "transferHistory" | "claimHistory" | "reverseHistory", input: object) => Promise<T>;

/** Connections for departed Drafts are opened only for the operation and closed afterwards. */
export function connectHistory(siteId: string, request: Request, siteMode = false, token?: string | null) {
	const history = editorHistory();
	history.siteId = siteId;
	history.transport(
		async (resource) => {
			if (!resource.startsWith(`draft:${siteId}:`))
				return {
					reverse: (from, to) => request<HistoryResult>("reverseHistory", { resource, from, to }),
				};
			return { reverse: (from, to) => reverseDraft(resource, from, to, siteMode) };
		},
		(payload) => request<{ token: string }>("transferHistory", { payload }).then((result) => result.token),
	);
	const hash = new URLSearchParams(location.hash.slice(1));
	const claim = token ?? hash.get("wc-history");
	if (hash.has("wc-history")) {
		hash.delete("wc-history");
		window.history.replaceState(
			window.history.state,
			"",
			location.pathname + location.search + (hash.size ? `#${hash}` : ""),
		);
	}
	if (
		claim &&
		(performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type !== "reload"
	) {
		return request<{ payload: string | null }>("claimHistory", { token: claim }).then((result) => {
			if (result.payload) history.restore(result.payload);
		});
	}
	return Promise.resolve();
}

async function reverseDraft(resource: string, from: Json, to: Json, siteMode: boolean): Promise<HistoryResult> {
	const [, siteId, kind, id] = resource.split(":");
	const path = siteMode
		? `/_webcraft/edit/drafts/${kind}${id ? `/${id}` : ""}`
		: `/api/drafts/${siteId}/${kind}${id ? `/${id}` : ""}`;
	const url = new URL(path, location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const token = document.querySelector('meta[name="webcraft-edit-token"]')?.getAttribute("content");
	const socket = new WebSocket(url, [DRAFTS_PROTOCOL, ...(siteMode && token ? [`webcraft-edit-token.${token}`] : [])]);
	socket.binaryType = "arraybuffer";
	const draft = createDraftClient();
	let ends: ReturnType<typeof draft.connect> | undefined;
	socket.addEventListener("open", () => {
		ends = draft.connect({
			send: (data) => socket.send(typeof data === "string" ? data : new Uint8Array(data)),
			close: () => socket.close(),
		});
	});
	socket.addEventListener("message", (event) =>
		ends?.receive(typeof event.data === "string" ? event.data : new Uint8Array(event.data)),
	);
	socket.addEventListener("close", () => ends?.closed());
	try {
		const start = Date.now();
		while (draft.status() === "connecting" && Date.now() - start < 10_000)
			await new Promise((resolve) => setTimeout(resolve, 20));
		return await draft.reverse(from, to);
	} finally {
		draft.close();
		socket.close();
	}
}
