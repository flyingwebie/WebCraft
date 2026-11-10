import { ORPCError } from "@orpc/server";
import { toApiError } from "@webcraft/api";
import {
	type Access,
	type CoEditing,
	createCoEditing,
	DRAFTS_PROTOCOL,
	DraftNotLiveError,
	EDIT_TOKEN_PROTOCOL_PREFIX,
	type HistoryItem,
	type InstallServices,
	isLiveKind,
	isUuid,
	type SiteHost,
	type SocketPeer,
	type SocketSession,
	TooManyDraftsError,
} from "@webcraft/core";

import { clientAddress } from "../client-address.ts";
import { json, plainText } from "../responses.ts";
import { cookieValue } from "../site/cookies.ts";
import { editCookieName, editSessionOf } from "../site/edit-mode.ts";
import { ADMIN_DRAFTS_PREFIX, EDIT_DRAFTS_PREFIX } from "./paths.ts";

export { ADMIN_DRAFTS_PREFIX, EDIT_DRAFTS_PREFIX } from "./paths.ts";

/**
 * Co-editing's WebSockets (ADR 0025): one per Draft an editor has open, upgraded from a `GET` that
 * names the item. The admin's editors open `/api/drafts/<site id>/<kind>[/<id>]` on the admin host
 * with the session cookie; Edit mode opens `/_webcraft/edit/drafts/<kind>[/<id>]` on the Site's own
 * domain with the edit cookie, and its header token as a WebSocket subprotocol (a browser can't send
 * a header there). Both must come from their own pages (`Origin`), as every request that carries a
 * cookie must. What the item is and who may open it is checked by the data layer, as for any read.
 */

/** A socket accepted: the subprotocol it speaks, and what to call once it is open. */
export type SocketUpgrade = { protocol: string; open(peer: SocketPeer): SocketSession };

/** What a WebSocket upgrade gets: a refusal, or a socket to open. */
export type UpgradeAnswer = Response | SocketUpgrade;

export type DraftSockets = {
	/** An upgrade on the admin host. */
	admin(request: Request): Promise<UpgradeAnswer>;
	/** An upgrade on one of a Site's hostnames, in Edit mode. */
	site(request: Request, host: SiteHost): Promise<UpgradeAnswer>;
	stop(): Promise<void>;
};

export function createDraftSockets(services: InstallServices): DraftSockets {
	let hub: CoEditing | null = null;
	// Made on first use: a web process nobody co-edits on never listens.
	const coEditing = () => {
		hub ??= createCoEditing({
			database: services.database,
			databaseUrl: services.config.databaseUrl,
			data: services.data,
			history: services.history,
			clock: services.clock,
			log: services.log.child({ area: "co-editing" }),
			components: services.modules.components,
			describe: (error) => {
				const refusal = toApiError(error);
				return refusal instanceof ORPCError
					? { code: refusal.code, message: refusal.message, data: refusal.data }
					: null;
			},
		});
		return hub;
	};

	const accept = async (
		siteId: string,
		item: HistoryItem,
		access: Access,
		recheck: () => Promise<Access | null>,
	): Promise<UpgradeAnswer> => {
		try {
			const opened = await coEditing().open({ siteId, item, access, recheck });
			return { protocol: DRAFTS_PROTOCOL, open: (peer) => opened.attach(peer) };
		} catch (error) {
			if (error instanceof DraftNotLiveError) return json(404, { code: "NOT_FOUND", message: error.message });
			if (error instanceof TooManyDraftsError) {
				return json(429, { code: "TOO_MANY_REQUESTS", message: error.message }, { "retry-after": "60" });
			}
			const refusal = toApiError(error);
			if (!(refusal instanceof ORPCError)) throw error;
			return json(refusal.status, { code: refusal.code, message: refusal.message });
		}
	};

	return {
		async admin(request) {
			const refused = upgradeRefusal(request);
			if (refused) return refused;
			const path = new URL(request.url).pathname.slice(ADMIN_DRAFTS_PREFIX.length).split("/");
			const [siteId = "", ...rest] = path;
			const item = itemOf(rest);
			if (!item || !isUuid(siteId)) return json(404, { code: "NOT_FOUND", message: "There is no such Draft." });
			const { session } = await services.auth.session({
				headers: request.headers,
				clientAddress: clientAddress(request, services.config),
			});
			if (!session) return json(401, { code: "UNAUTHORIZED", message: "Sign in first." });
			const via = { kind: "admin" } as const;
			const access: Access = {
				actor: await services.actors.person(session.personId),
				via,
				identityCheckedAt: session.identityCheckedAt,
			};
			// Before every change: the session still signed in, the person's access as it is now.
			const recheck = async (): Promise<Access | null> => {
				const current = await services.auth.activeSession(session.id);
				if (!current) return null;
				return {
					actor: await services.actors.person(current.personId),
					via,
					identityCheckedAt: current.identityCheckedAt,
				};
			};
			return accept(siteId, item, access, recheck);
		},

		async site(request, host) {
			const refused = upgradeRefusal(request);
			if (refused) return refused;
			const item = itemOf(new URL(request.url).pathname.slice(EDIT_DRAFTS_PREFIX.length).split("/"));
			if (!item) return json(404, { code: "NOT_FOUND", message: "There is no such Draft." });
			const edit = await editSessionOf(services, request, host);
			if (!edit.session) {
				return json(401, { code: "EDIT_MODE_ENDED", message: "Edit mode has ended. Open it again from the admin." });
			}
			const token = protocolsOf(request)
				.find((protocol) => protocol.startsWith(EDIT_TOKEN_PROTOCOL_PREFIX))
				?.slice(EDIT_TOKEN_PROTOCOL_PREFIX.length);
			if (!token || !(await services.editMode.checkHeaderToken(edit.session, token))) {
				return json(403, { code: "EDIT_REQUEST_REFUSED", message: "The request has no valid Edit mode token." });
			}
			const cookie = cookieValue(request, editCookieName(new URL(request.url).hostname)) ?? "";
			const recheck = async (): Promise<Access | null> =>
				(await services.editMode.session(host, cookie))?.access ?? null;
			return accept(host.site.id, item, edit.session.access, recheck);
		},

		async stop() {
			await hub?.stop();
			hub = null;
		},
	};
}

/**
 * What keeps a request from becoming a Draft's socket: anything but a WebSocket upgrade speaking
 * WebCraft's subprotocol, and an upgrade another site's page asks for. Browsers send `Origin` with
 * every WebSocket upgrade, so one without it doesn't come from the page it claims to.
 */
function upgradeRefusal(request: Request): Response | null {
	if (request.method !== "GET") return plainText(405, "Method Not Allowed", { allow: "GET" });
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !request.headers.get("sec-websocket-key")) {
		return plainText(426, "Upgrade Required", { upgrade: "websocket" });
	}
	if (!protocolsOf(request).includes(DRAFTS_PROTOCOL)) {
		return json(400, { code: "BAD_REQUEST", message: `Speak the ${DRAFTS_PROTOCOL} subprotocol.` });
	}
	const origin = request.headers.get("origin");
	const fetchSite = request.headers.get("sec-fetch-site");
	let sameOrigin = false;
	try {
		sameOrigin = origin !== null && new URL(origin).host === new URL(request.url).host;
	} catch {
		sameOrigin = false;
	}
	if (!sameOrigin || (fetchSite !== null && fetchSite !== "same-origin")) {
		return json(403, { code: "FORBIDDEN", message: "A Draft can only be opened from WebCraft's own pages." });
	}
	return null;
}

function protocolsOf(request: Request): string[] {
	return (request.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((protocol) => protocol.trim())
		.filter(Boolean);
}

/** The item a socket's path names: `<kind>/<id>`, or the kind alone for the Globals. */
function itemOf(parts: readonly string[]): HistoryItem | null {
	const [kind = "", id, ...more] = parts;
	if (more.length > 0 || !isLiveKind(kind)) return null;
	if (kind === "globals") return id === undefined || id === "" ? { kind } : null;
	return id && isUuid(id) ? { kind, id } : null;
}
