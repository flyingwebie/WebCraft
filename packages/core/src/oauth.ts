import type { Database } from "@webcraft/db";
import {
	oauthClients,
	oauthCodes,
	oauthDeviceCodes,
	oauthGrantSites,
	oauthGrants,
	oauthTokens,
	sites,
	workspaces,
} from "@webcraft/db/schema";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import { networkOf } from "./account.ts";
import {
	type ApiAccess,
	type ApiClientLimits,
	type ApiClientUse,
	ApiTokenInvalidError,
	countClient,
	reaches,
} from "./api-tokens.ts";
import { type AuditVia, recordAudit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import { isUuid } from "./ids.ts";
import { clientNetwork } from "./ip-ranges.ts";
import type { People } from "./people.ts";
import { loadPersonActor } from "./permissions/actors.ts";
import { can, type GrantActor, type Reach } from "./permissions/can.ts";
import { RateLimitedError, type RateLimitRule, type RateLimits, type RateLimitTally } from "./rate-limits.ts";
import type { Access, Executor, WorkspaceScope } from "./tenancy/data-layer.ts";
import { SiteNotFoundError } from "./tenancy/errors.ts";
import { newToken } from "./tokens.ts";
import { chosenToolsets, type ToolsetKey } from "./toolsets.ts";

/**
 * AI clients and OAuth grants (spec › MCP server, ADR 0030): WebCraft is the OAuth 2.1
 * authorization server for its own MCP server at `/mcp`.
 *
 * 1. An AI client registers itself (RFC 7591): its name and the exact addresses it may be sent back
 *    to (https, or http on the loopback interface for apps on the person's own device).
 * 2. It sends the person to the admin's approval page with a PKCE challenge (S256 only). Signed in,
 *    the person sees the client's name and where it will send them back, and chooses one Workspace,
 *    its Sites, the Toolsets, whether it only reads and whether it may publish. Approving is a
 *    Sensitive action: it makes a credential that acts as them.
 * 3. The client exchanges the one-time code (valid a minute) with the PKCE verifier for an access
 *    token (1 hour) and a refresh token (30 days, replaced each time it is used). A code or refresh
 *    token that comes back after it was used ends the grant: someone else may hold it.
 *
 * A client on a device without a browser of its own (`webcraft login`) uses the device authorization
 * grant (RFC 8628) instead: it asks for a device code and a short user code, shows the person the
 * code and an address, and polls the token endpoint while they approve it on the same approval page
 * (`/oauth/device`), choosing the same things. Its tokens are for the public Management API.
 *
 * Codes, tokens and client secrets are never kept, only keyed hashes of them. A grant acts as its
 * person now (`GrantActor`, read fresh on every request), never beyond its Workspace and Sites, and
 * WebCraft revokes it once its person no longer reaches them, as it does API tokens.
 */

/** How long codes and tokens last. */
export const OAUTH_LIFETIMES = {
	codeMs: 60_000,
	/** A device code and its user code: the person has this long to approve it. */
	deviceMs: 10 * 60_000,
	accessMs: 60 * 60 * 1000,
	refreshMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/** What OAuth's codes, tokens and client secrets start with, so people (and secret scanners) recognise them. */
export const OAUTH_PREFIXES = {
	code: "webcraft-code_",
	access: "webcraft-at_",
	refresh: "webcraft-rt_",
	clientSecret: "webcraft-cs_",
	deviceCode: "webcraft-dc_",
} as const;

/** The device authorization grant's type (RFC 8628 §3.4). */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** How long a device client waits between polls at first (seconds); each poll too soon adds 5 (`slow_down`). */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** At most this many device codes an hour from one client address. */
export const OAUTH_DEVICE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * At most this many user codes one person looks up in 15 minutes: a code has 20^8 possible values,
 * and this keeps guessing one hopeless.
 */
export const OAUTH_USER_CODE_LIMIT: RateLimitRule = { limit: 20, windowMs: 15 * 60 * 1000 };

/** The letters user codes are made of: consonants only, so no word is spelt by chance, none confusable. */
const USER_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/** Where the public Management API answers, on the admin host: the resource the CLI's tokens are for. */
export const PUBLIC_API_PATH = "/api/v1";

/** At most this many client registrations an hour from one client address. */
export const OAUTH_REGISTRATION_LIMIT: RateLimitRule = { limit: 20, windowMs: 60 * 60 * 1000 };

/** Where the MCP server answers, on the admin host: the one resource WebCraft's tokens are for. */
export const MCP_PATH = "/mcp";

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_CLIENT_NAME = 100;
/** An unapproved client is forgotten after this long. */
const UNAPPROVED_CLIENT_MS = 7 * 24 * 60 * 60 * 1000;
/** `lastUsedAt` is written at most this often. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * A refusal of the OAuth endpoints, as RFC 6749 and RFC 7591 word them: `error` is the standard
 * code (`invalid_grant`, `invalid_client_metadata`, …) and the answer's status.
 */
export class OAuthRequestError extends Error {
	override name = "OAuthRequestError";
	readonly error: string;
	readonly status: number;
	constructor(error: string, description: string, status = 400) {
		super(description);
		this.error = error;
		this.status = status;
	}
}

/** What a registered client is told about itself (RFC 7591 §3.2.1). */
export type RegisteredClient = {
	client_id: string;
	client_id_issued_at: number;
	client_name: string;
	/** Empty for a client that only uses device codes. */
	redirect_uris: string[];
	grant_types: string[];
	response_types: string[];
	token_endpoint_auth_method: string;
	application_type: string;
	client_secret?: string;
	client_secret_expires_at?: number;
};

/** An authorization request's parameters, as the client sent them (`/oauth/authorize?…`). */
export type AuthorizationParameters = Record<string, string | undefined>;

/** A checked authorization request, as the approval page shows it. */
export type AuthorizationRequest = {
	client: {
		id: string;
		name: string;
		/** The host it sends the person back to, shown plainly. */
		redirectHost: string;
		/** Whether it sends them back to their own device (a loopback address): anything on it could claim the name. */
		onThisDevice: boolean;
	};
	redirectUri: string;
	state: string | null;
};

/**
 * What an authorization request comes to before anyone approves it:
 * - `ask`: a request to show the person;
 * - `refused`: one that can't be answered to the client (an unknown client, an address it didn't
 *   register): the page says so and sends nobody anywhere;
 * - `redirect`: one the client gets an error for, at the address it registered.
 */
export type AuthorizationCheck =
	| { kind: "ask"; request: AuthorizationRequest }
	| { kind: "refused"; problem: "client" | "redirectUri" }
	/**
	 * A registered client and address, but a request that can't be approved (no PKCE, another
	 * response type). `returnTo` is the client's address with the error: the page offers it behind a
	 * button and never follows it by itself, since anyone may register a client with any address, and
	 * a link on the admin's own hostname must not land a signed-in person somewhere else unasked.
	 */
	| {
			kind: "refused";
			problem: "request";
			client: { name: string; redirectHost: string };
			description: string;
			returnTo: string;
	  };

/** What the person chose on the approval page. */
export type GrantChoice = {
	sites: "all" | readonly string[];
	readOnly: boolean;
	mayPublish: boolean;
	toolsets: readonly string[];
};

/** A grant as its person sees it in Your account › AI clients. */
export type OAuthGrantView = {
	id: string;
	/** `redirectHost` is null for a client approved with a device code: it sends nobody anywhere. */
	client: { name: string; redirectHost: string | null };
	workspace: { id: string; name: string };
	sites: "all" | { id: string; name: string }[];
	readOnly: boolean;
	mayPublish: boolean;
	toolsets: ToolsetKey[];
	createdAt: Date;
	lastUsedAt: Date | null;
	/**
	 * `active` while its client can use or refresh it, `expired` once its refresh token ran out
	 * unused, `revoked` once ended.
	 */
	status: "active" | "expired" | "revoked";
	revokedAt: Date | null;
	/**
	 * Who ended it: its person (`person`), its client (`client`), WebCraft when the person lost access
	 * (`access`), or WebCraft when a used code or refresh token came back (`reuse`).
	 */
	revokedReason: "person" | "client" | "access" | "reuse" | null;
};

/** The tokens the token endpoint answers (RFC 6749 §5.1). */
export type TokenAnswer = {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	refresh_token: string;
};

/** What a device sign-in answers its client (RFC 8628 §3.2). */
export type DeviceAuthorizationAnswer = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
};

/**
 * A user code as the approval page shows it: the request to show (`ask`), or why it can't be
 * approved: no such code (`unknown`), too late (`expired`), or already approved or denied (`decided`).
 */
export type DeviceCheck =
	| {
			kind: "ask";
			request: {
				/** The client's name is whatever it registered under: anyone may choose any name. */
				client: { id: string; name: string };
				userCode: string;
				/** What WebCraft itself knows: when the code was asked for, */
				requestedAt: Date;
				/** from which network (the address with its end hidden, null when unknown), */
				network: string | null;
				/** and whether that is the network of the browser looking it up. */
				sameNetwork: boolean;
			};
	  }
	/**
	 * The code came in a link, to a browser on another network than the one that asked for it: nothing
	 * about the sign-in is shown, and the person types the code their own terminal shows instead.
	 */
	| { kind: "type" }
	| { kind: "refused"; problem: "unknown" | "expired" | "decided" };

/** A user code that can't be approved or denied (any more): see `DeviceCheck`'s problems. */
export class DeviceCodeInvalidError extends Error {
	override name = "DeviceCodeInvalidError";
	readonly problem: "unknown" | "expired" | "decided";
	constructor(problem: "unknown" | "expired" | "decided") {
		super(
			problem === "expired"
				? "This code has expired. Start signing in again to get a new one."
				: problem === "decided"
					? "This code was already used."
					: "There is no such code. Check the code your terminal shows.",
		);
		this.problem = problem;
	}
}

/** The grant isn't one of the person's own. */
export class OAuthGrantNotFoundError extends Error {
	override name = "OAuthGrantNotFoundError";
	constructor() {
		super("There is no such AI client among yours.");
	}
}

export type OAuth = {
	/** The authorization server's identifier (RFC 8414): the admin's origin. */
	readonly issuer: string;
	/** The MCP server's address, the resource an AI client's access tokens are for (RFC 8707). */
	readonly resource: string;
	/** The public Management API's address (`/api/v1`): what device sign-ins are for unless they ask for the MCP server. */
	readonly apiResource: string;
	/** Registers a client (RFC 7591), from `clientAddress`, rate-limited per address. */
	register(metadata: unknown, clientAddress: string | null): Promise<RegisteredClient>;
	/** Checks an authorization request before the person is shown it. */
	check(parameters: AuthorizationParameters): Promise<AuthorizationCheck>;
	/**
	 * Approves an authorization request as the person acting in `workspace` (opened for them):
	 * makes the grant and a one-time code, and answers where to send the person back to, with the
	 * code. Logged as `aiClient.approve`.
	 */
	approve(
		workspace: WorkspaceScope,
		parameters: AuthorizationParameters,
		choice: GrantChoice,
	): Promise<{ redirectTo: string; grantId: string }>;
	/** The person said no: where to send them back to, with `access_denied`. */
	deny(parameters: AuthorizationParameters): Promise<{ redirectTo: string }>;
	/** The token endpoint: an authorization code, a device code or a refresh token for new tokens. */
	token(form: URLSearchParams, authorization: string | null): Promise<TokenAnswer>;
	/**
	 * The device authorization endpoint (RFC 8628 §3.1): a device code and a user code for a client
	 * registered for the device grant, from `clientAddress`, rate-limited per address.
	 */
	deviceAuthorization(
		form: URLSearchParams,
		authorization: string | null,
		clientAddress: string | null,
	): Promise<DeviceAuthorizationAnswer>;
	/**
	 * Looks up a user code the person typed on the approval page, at most `OAUTH_USER_CODE_LIMIT`
	 * times per person (`RateLimitedError` past it).
	 */
	checkDevice(
		userCode: string,
		personId: string,
		from: {
			/** The person typed the code (true), or it came filled in by a link (false). */
			typed: boolean;
			/** The client address of the person's browser. */
			clientAddress: string | null;
		},
	): Promise<DeviceCheck>;
	/**
	 * Approves a user code as the person acting in `workspace`: makes the grant, which the client's
	 * next poll exchanges for tokens. Logged as `aiClient.approve`. Throws `DeviceCodeInvalidError`;
	 * counted as `checkDevice` is.
	 */
	approveDevice(
		workspace: WorkspaceScope,
		userCode: string,
		choice: GrantChoice,
	): Promise<{ grantId: string; client: string }>;
	/**
	 * The person said no: the client's next poll is told `access_denied`. Throws
	 * `DeviceCodeInvalidError`; counted as `checkDevice` is.
	 */
	denyDevice(userCode: string, personId: string): Promise<void>;
	/** The revocation endpoint (RFC 7009): a client ends its grant with one of its tokens. */
	revokeToken(form: URLSearchParams, authorization: string | null): Promise<void>;
	/**
	 * The grant a request's access token stands for, checked: throws `ApiTokenInvalidError` unless it
	 * works now, for `resource` (the MCP server unless given), revoking the grant first when its person
	 * no longer reaches what it was made for.
	 */
	use(secret: string | null, resource?: string): Promise<ApiClientUse>;
	/** Counts one request of a grant against its limits, as API tokens' are counted. */
	count(grantId: string, access: ApiAccess): Promise<{ requests: RateLimitTally; writes: RateLimitTally | null }>;
	/** The person's grants, newest first: active, expired and revoked. */
	list(personId: string): Promise<OAuthGrantView[]>;
	/** Revokes one of the person's own grants, at once. Logged as `aiClient.revoke`. */
	revoke(access: Access, grantId: string): Promise<OAuthGrantView>;
	/** Deletes used and ended codes and tokens, and clients nobody approved within a week (the daily job). */
	purge(): Promise<number>;
};

export function createOAuth({
	database,
	clock,
	people: peopleService,
	rateLimits,
	keyHash,
	issuer,
	toolsets,
}: {
	database: Database;
	clock: Clock;
	people: People;
	rateLimits: RateLimits;
	/** The key codes, tokens and client secrets are hashed under (`oauthKey`). */
	keyHash: CryptoKey;
	/** The admin's origin: `https://admin.example.com`. */
	issuer: string;
	/** The Toolsets this Install offers. */
	toolsets: () => ToolsetKey[];
}): OAuth {
	const { db } = database;
	const resource = `${issuer}${MCP_PATH}`;
	const apiResource = `${issuer}${PUBLIC_API_PATH}`;

	const hashed = async (secret: string) => {
		const signature = await crypto.subtle.sign("HMAC", keyHash, new TextEncoder().encode(secret));
		return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
	};

	const findClient = async (clientId: string | undefined) => {
		if (!clientId || !isUuid(clientId)) return null;
		const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
		return client ?? null;
	};

	/** The client a token or revocation request authenticates as (RFC 6749 §2.3). */
	const authenticate = async (form: URLSearchParams, authorization: string | null) => {
		let clientId = form.get("client_id") ?? undefined;
		let secret = form.get("client_secret") ?? undefined;
		let basic = false;
		const match = /^Basic\s+(\S+)\s*$/i.exec(authorization ?? "");
		if (match?.[1]) {
			const decoded = Buffer.from(match[1], "base64").toString("utf8");
			const colon = decoded.indexOf(":");
			if (colon < 0) throw new OAuthRequestError("invalid_client", "The client credentials can't be read.", 401);
			clientId = safeDecode(decoded.slice(0, colon));
			secret = safeDecode(decoded.slice(colon + 1));
			basic = true;
		}
		const client = await findClient(clientId);
		if (!client) throw new OAuthRequestError("invalid_client", "This client isn't registered here.", 401);
		if (client.authMethod === "none") {
			if (secret !== undefined && secret !== "") {
				throw new OAuthRequestError("invalid_client", "This client registered without a secret.", 401);
			}
			return client;
		}
		const expected = client.authMethod === "client_secret_basic";
		if (secret === undefined || basic !== expected || !client.secretHash) {
			throw new OAuthRequestError("invalid_client", "Authenticate the client as it registered.", 401);
		}
		if ((await hashed(secret)) !== client.secretHash) {
			throw new OAuthRequestError("invalid_client", "The client secret is wrong.", 401);
		}
		return client;
	};

	/** Checks an authorization request's parameters, as both the page and the approval need them. */
	const checked = async (
		parameters: AuthorizationParameters,
	): Promise<
		| { kind: "ok"; client: typeof oauthClients.$inferSelect; redirectUri: string; challenge: string }
		| Exclude<AuthorizationCheck, { kind: "ask" }>
	> => {
		const client = await findClient(parameters.client_id);
		if (!client) return { kind: "refused", problem: "client" };
		const redirectUri = parameters.redirect_uri;
		if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { kind: "refused", problem: "redirectUri" };
		const back = (error: string, description: string) => ({
			kind: "refused" as const,
			problem: "request" as const,
			client: { name: client.name, redirectHost: hostOf(redirectUri) },
			description,
			returnTo: answerUrl(redirectUri, {
				error,
				error_description: description,
				state: parameters.state,
				iss: issuer,
			}),
		});
		if (parameters.response_type !== "code") {
			return back("unsupported_response_type", "Only the authorization code flow (response_type=code) is offered.");
		}
		const challenge = parameters.code_challenge;
		if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
			return back("invalid_request", "Send a PKCE code_challenge (S256).");
		}
		if (parameters.code_challenge_method !== "S256") {
			return back("invalid_request", "Only the S256 code_challenge_method is accepted.");
		}
		if (parameters.resource !== undefined && !isOurResource(parameters.resource, resource)) {
			return back("invalid_target", `Tokens here are for ${resource} only.`);
		}
		return { kind: "ok", client, redirectUri, challenge };
	};

	/** Whether a client registered for a grant type (clients registered before grant types were kept: the code and refresh grants). */
	const allows = (client: typeof oauthClients.$inferSelect, grantType: string) =>
		(client.grantTypes ?? ["authorization_code", "refresh_token"]).includes(grantType);

	/**
	 * Counts a person's look-up of a user code (checking, approving or denying one), refusing past
	 * `OAUTH_USER_CODE_LIMIT`: codes are short, so guessing them must stay hopeless.
	 */
	const countUserCode = async (personId: string) => {
		const tally = await rateLimits.tally(`oauth-user-code:${personId}`, OAUTH_USER_CODE_LIMIT);
		if (!tally.within) {
			throw new RateLimitedError(Math.max(1, Math.ceil((tally.resetsAt.getTime() - clock.now().getTime()) / 1000)));
		}
	};

	/** A user code's letters, upper case, without the dash or spaces people type. */
	const normalUserCode = (typed: string) => typed.toUpperCase().replace(/[^A-Z]/g, "");

	/** The device code a user code stands for, locked for the transaction, or why it can't be decided. */
	const deviceByUserCode = async (executor: Executor, typed: string, now: Date) => {
		const letters = normalUserCode(typed);
		if (letters.length !== USER_CODE_LENGTH) return { ok: false as const, problem: "unknown" as const };
		const [found] = await executor
			.select({ device: oauthDeviceCodes, client: oauthClients })
			.from(oauthDeviceCodes)
			.innerJoin(oauthClients, eq(oauthClients.id, oauthDeviceCodes.clientId))
			.where(eq(oauthDeviceCodes.userCodeHash, await hashed(`user:${letters}`)))
			.for("update");
		if (!found) return { ok: false as const, problem: "unknown" as const };
		if (found.device.status !== "pending") return { ok: false as const, problem: "decided" as const };
		if (found.device.expiresAt.getTime() <= now.getTime()) return { ok: false as const, problem: "expired" as const };
		return { ok: true as const, found, letters };
	};

	const issueTokens = async (executor: Executor, grantId: string, now: Date): Promise<TokenAnswer> => {
		const access = `${OAUTH_PREFIXES.access}${newToken()}`;
		const refresh = `${OAUTH_PREFIXES.refresh}${newToken()}`;
		await executor.insert(oauthTokens).values([
			{
				tokenHash: await hashed(access),
				grantId,
				kind: "access",
				createdAt: now,
				expiresAt: new Date(now.getTime() + OAUTH_LIFETIMES.accessMs),
			},
			{
				tokenHash: await hashed(refresh),
				grantId,
				kind: "refresh",
				createdAt: now,
				expiresAt: new Date(now.getTime() + OAUTH_LIFETIMES.refreshMs),
			},
		]);
		return {
			access_token: access,
			token_type: "Bearer",
			expires_in: Math.floor(OAUTH_LIFETIMES.accessMs / 1000),
			refresh_token: refresh,
		};
	};

	const grantSites = async (executor: Executor, grantIds: readonly string[]) => {
		const byGrant = new Map<string, { id: string; name: string }[]>();
		if (grantIds.length === 0) return byGrant;
		const rows = await executor
			.select({ grantId: oauthGrantSites.grantId, id: sites.id, name: sites.name })
			.from(oauthGrantSites)
			.innerJoin(sites, eq(sites.id, oauthGrantSites.siteId))
			.where(inArray(oauthGrantSites.grantId, [...grantIds]))
			.orderBy(asc(sites.name));
		for (const row of rows)
			byGrant.set(row.grantId, [...(byGrant.get(row.grantId) ?? []), { id: row.id, name: row.name }]);
		return byGrant;
	};

	const views = async (executor: Executor, where: ReturnType<typeof eq>) => {
		const rows = await executor
			.select({ grant: oauthGrants, workspaceName: workspaces.name })
			.from(oauthGrants)
			.innerJoin(workspaces, eq(workspaces.id, oauthGrants.workspaceId))
			.where(where)
			.orderBy(desc(oauthGrants.createdAt), asc(oauthGrants.clientName));
		const listed = await grantSites(
			executor,
			rows.filter((row) => !row.grant.allSites).map((row) => row.grant.id),
		);
		const now = clock.now();
		const live = await liveGrants(
			executor,
			rows.map((row) => row.grant.id),
			now,
		);
		return rows.map(({ grant, workspaceName }): OAuthGrantView => {
			const reason = grant.revokedReason;
			return {
				id: grant.id,
				client: { name: grant.clientName, redirectHost: grant.redirectUri ? hostOf(grant.redirectUri) : null },
				workspace: { id: grant.workspaceId, name: workspaceName },
				sites: grant.allSites ? "all" : (listed.get(grant.id) ?? []),
				readOnly: grant.readOnly,
				mayPublish: grant.mayPublish,
				toolsets: grant.toolsets as ToolsetKey[],
				createdAt: grant.createdAt,
				lastUsedAt: grant.lastUsedAt,
				status: grant.revokedAt ? "revoked" : live.has(grant.id) ? "active" : "expired",
				revokedAt: grant.revokedAt,
				revokedReason:
					reason === "person" || reason === "client" || reason === "access" || reason === "reuse" ? reason : null,
			};
		});
	};

	const viewOf = async (grantId: string) => {
		const [view] = await views(db, eq(oauthGrants.id, grantId));
		if (!view) throw new OAuthGrantNotFoundError();
		return view;
	};

	return {
		issuer,
		resource,
		apiResource,

		async register(metadata, clientAddress) {
			if (!(await rateLimits.count(`oauth-register:${clientAddress ?? "unknown"}`, OAUTH_REGISTRATION_LIMIT))) {
				throw new OAuthRequestError(
					"temporarily_unavailable",
					"Too many clients were registered from this address. Try again later.",
					429,
				);
			}
			const given = isRecord(metadata) ? metadata : null;
			if (!given)
				throw new OAuthRequestError("invalid_client_metadata", "Send the client's metadata as a JSON object.");
			const grantTypes = given.grant_types ?? ["authorization_code"];
			if (
				!Array.isArray(grantTypes) ||
				!grantTypes.every(
					(type) => type === "authorization_code" || type === "refresh_token" || type === DEVICE_CODE_GRANT,
				) ||
				!(grantTypes.includes("authorization_code") || grantTypes.includes(DEVICE_CODE_GRANT))
			) {
				throw new OAuthRequestError(
					"invalid_client_metadata",
					`Only the authorization_code, ${DEVICE_CODE_GRANT} and refresh_token grant types are offered.`,
				);
			}
			// A client using device codes only sends nobody anywhere: it has no redirect addresses.
			const sendsBack = grantTypes.includes("authorization_code");
			const redirectUris = given.redirect_uris ?? (sendsBack ? undefined : []);
			if (
				!Array.isArray(redirectUris) ||
				(sendsBack && redirectUris.length === 0) ||
				(!sendsBack && redirectUris.length > 0) ||
				redirectUris.length > MAX_REDIRECT_URIS ||
				!redirectUris.every((uri) => typeof uri === "string")
			) {
				throw new OAuthRequestError(
					"invalid_redirect_uri",
					sendsBack
						? `List 1 to ${MAX_REDIRECT_URIS} redirect_uris, the exact addresses to send people back to.`
						: "A client using device codes only has no redirect_uris.",
				);
			}
			for (const uri of redirectUris as string[]) {
				const problem = redirectUriProblem(uri);
				if (problem) throw new OAuthRequestError("invalid_redirect_uri", `${uri}: ${problem}`);
			}
			const responseTypes = given.response_types ?? (sendsBack ? ["code"] : []);
			if (
				!Array.isArray(responseTypes) ||
				(sendsBack ? responseTypes.length !== 1 || responseTypes[0] !== "code" : responseTypes.length > 0)
			) {
				throw new OAuthRequestError(
					"invalid_client_metadata",
					sendsBack
						? "Only the code response type is offered."
						: "A client using device codes only has no response_types.",
				);
			}
			const authMethod = given.token_endpoint_auth_method ?? "client_secret_basic";
			if (authMethod !== "none" && authMethod !== "client_secret_basic" && authMethod !== "client_secret_post") {
				throw new OAuthRequestError(
					"invalid_client_metadata",
					"token_endpoint_auth_method is none, client_secret_basic or client_secret_post.",
				);
			}
			const applicationType = given.application_type ?? "web";
			if (applicationType !== "web" && applicationType !== "native") {
				throw new OAuthRequestError("invalid_client_metadata", "application_type is web or native.");
			}
			const rawName = typeof given.client_name === "string" ? given.client_name : "";
			const name = cleanName(rawName) || hostOf((redirectUris as string[])[0] ?? "") || "Device client";
			const secret = authMethod === "none" ? null : `${OAUTH_PREFIXES.clientSecret}${newToken()}`;
			const now = clock.now();
			const [row] = await db
				.insert(oauthClients)
				.values({
					name,
					redirectUris: redirectUris as string[],
					applicationType,
					authMethod,
					secretHash: secret ? await hashed(secret) : null,
					grantTypes: grantTypes as string[],
					createdAt: now,
				})
				.returning();
			if (!row) throw new Error("The client wasn't saved.");
			return {
				client_id: row.id,
				client_id_issued_at: Math.floor(now.getTime() / 1000),
				client_name: row.name,
				redirect_uris: row.redirectUris,
				grant_types: grantTypes as string[],
				response_types: sendsBack ? ["code"] : [],
				token_endpoint_auth_method: authMethod,
				application_type: applicationType,
				...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
			};
		},

		async check(parameters) {
			const found = await checked(parameters);
			if (found.kind !== "ok") return found;
			return {
				kind: "ask",
				request: {
					client: {
						id: found.client.id,
						name: found.client.name,
						redirectHost: hostOf(found.redirectUri),
						onThisDevice: isLoopback(found.redirectUri),
					},
					redirectUri: found.redirectUri,
					state: parameters.state ?? null,
				},
			};
		},

		async approve(scope, parameters, choice) {
			const { actor } = scope.access;
			if (actor.kind !== "person") throw new TypeError("Only a person approves an AI client.");
			const found = await checked(parameters);
			if (found.kind === "refused") {
				throw new OAuthRequestError("invalid_request", "This authorization request can't be approved.");
			}
			const listed = choice.sites === "all" ? null : [...new Set(choice.sites)];
			if (listed !== null) {
				if (listed.length === 0) throw new SiteNotFoundError();
				for (const siteId of listed) {
					const seen =
						isUuid(siteId) &&
						can(actor, "site.view", { level: "site", workspaceId: scope.workspace.id, siteId }) &&
						(await db
							.select({ id: sites.id })
							.from(sites)
							.where(and(eq(sites.id, siteId), eq(sites.workspaceId, scope.workspace.id)))
							.then((rows) => rows.length > 0));
					if (!seen) throw new SiteNotFoundError();
				}
			}
			const chosen = chosenToolsets(choice.toolsets, toolsets());
			const code = `${OAUTH_PREFIXES.code}${newToken()}`;
			const now = scope.now();
			const grantId = await scope.transaction(async (tx) => {
				const grant = await tx.insert(oauthGrants, {
					clientId: found.client.id,
					personId: actor.personId,
					clientName: found.client.name,
					redirectUri: found.redirectUri,
					resource,
					allSites: listed === null,
					readOnly: choice.readOnly,
					mayPublish: choice.readOnly ? false : choice.mayPublish,
					toolsets: chosen,
					createdAt: now,
				});
				for (const siteId of listed ?? []) await tx.insert(oauthGrantSites, { grantId: grant.id, siteId });
				await tx.db.insert(oauthCodes).values({
					codeHash: await hashed(code),
					grantId: grant.id,
					redirectUri: found.redirectUri,
					codeChallenge: found.challenge,
					resource,
					expiresAt: new Date(now.getTime() + OAUTH_LIFETIMES.codeMs),
				});
				await tx.audit("aiClient.approve", {
					grantId: grant.id,
					client: found.client.name,
					redirectHost: hostOf(found.redirectUri),
					sites: listed ?? "all",
					readOnly: choice.readOnly,
					mayPublish: choice.readOnly ? false : choice.mayPublish,
					toolsets: chosen,
				});
				return grant.id;
			});
			return {
				redirectTo: answerUrl(found.redirectUri, { code, state: parameters.state, iss: issuer }),
				grantId,
			};
		},

		async deny(parameters) {
			const found = await checked(parameters);
			if (found.kind === "refused") {
				throw new OAuthRequestError("invalid_request", "This authorization request can't be answered.");
			}
			return {
				redirectTo: answerUrl(found.redirectUri, {
					error: "access_denied",
					error_description: "The person didn't approve this client.",
					state: parameters.state,
					iss: issuer,
				}),
			};
		},

		async token(form, authorization) {
			const client = await authenticate(form, authorization);
			const now = clock.now();
			const grantType = form.get("grant_type");
			const target = form.get("resource");
			if (target !== null && !isOurResource(target, resource)) {
				throw new OAuthRequestError("invalid_target", `Tokens here are for ${resource} only.`);
			}
			if (grantType === "authorization_code") {
				const code = form.get("code") ?? "";
				const verifier = form.get("code_verifier") ?? "";
				const redirectUri = form.get("redirect_uri");
				const outcome = await db.transaction(async (tx) => {
					const [found] = await tx
						.select({ code: oauthCodes, grant: oauthGrants })
						.from(oauthCodes)
						.innerJoin(oauthGrants, eq(oauthGrants.id, oauthCodes.grantId))
						.where(eq(oauthCodes.codeHash, await hashed(code)))
						.for("update");
					if (!found || found.grant.clientId !== client.id) return "This code isn't valid.";
					if (found.code.usedAt) {
						await revokeGrant(tx, found.grant, now, "reuse");
						return "This code was used already: the grant it made is revoked.";
					}
					if (found.code.expiresAt.getTime() <= now.getTime()) return "This code has expired.";
					if (redirectUri !== found.code.redirectUri) {
						return "redirect_uri isn't the one the code was asked for.";
					}
					if (!(await pkceMatches(verifier, found.code.codeChallenge))) {
						return "The code_verifier doesn't match the code_challenge.";
					}
					if (found.grant.revokedAt) return "This grant was revoked.";
					await tx.update(oauthCodes).set({ usedAt: now }).where(eq(oauthCodes.codeHash, found.code.codeHash));
					return issueTokens(tx, found.grant.id, now);
				});
				// A refusal is its reason, in words.
				if (typeof outcome === "string") throw new OAuthRequestError("invalid_grant", outcome);
				return outcome;
			}
			if (grantType === DEVICE_CODE_GRANT) {
				if (!allows(client, DEVICE_CODE_GRANT)) {
					throw new OAuthRequestError("unauthorized_client", "This client didn't register for device codes.");
				}
				const deviceCode = form.get("device_code") ?? "";
				const outcome = await db.transaction(async (tx) => {
					const [found] = await tx
						.select()
						.from(oauthDeviceCodes)
						.where(eq(oauthDeviceCodes.deviceCodeHash, await hashed(deviceCode)))
						.for("update");
					if (!found || found.clientId !== client.id)
						return { error: "invalid_grant", text: "This device code isn't valid." };
					if (found.status === "used") {
						// It gave its tokens once already: someone else may hold it.
						const [grant] = found.grantId
							? await tx.select().from(oauthGrants).where(eq(oauthGrants.id, found.grantId))
							: [];
						if (grant) await revokeGrant(tx, grant, now, "reuse");
						return { error: "invalid_grant", text: "This device code was used already: the grant it made is revoked." };
					}
					if (found.expiresAt.getTime() <= now.getTime()) {
						return { error: "expired_token", text: "This device code has expired: ask for a new one." };
					}
					// RFC 8628 §3.5: a client polling faster than its interval waits 5 seconds longer from now on.
					const tooSoon =
						found.lastPolledAt !== null && now.getTime() - found.lastPolledAt.getTime() < found.intervalSeconds * 1000;
					await tx
						.update(oauthDeviceCodes)
						.set({
							lastPolledAt: now,
							...(tooSoon ? { intervalSeconds: found.intervalSeconds + DEVICE_POLL_INTERVAL_SECONDS } : {}),
						})
						.where(eq(oauthDeviceCodes.deviceCodeHash, found.deviceCodeHash));
					if (tooSoon)
						return {
							error: "slow_down",
							text: `Poll at most every ${found.intervalSeconds + DEVICE_POLL_INTERVAL_SECONDS} seconds.`,
						};
					if (found.status === "denied")
						return { error: "access_denied", text: "The person didn't approve this sign-in." };
					if (found.status !== "approved" || !found.grantId) {
						return { error: "authorization_pending", text: "The person hasn't approved this sign-in yet." };
					}
					const [grant] = await tx.select().from(oauthGrants).where(eq(oauthGrants.id, found.grantId));
					if (!grant || grant.revokedAt) return { error: "access_denied", text: "This grant was revoked." };
					await tx
						.update(oauthDeviceCodes)
						.set({ status: "used" })
						.where(eq(oauthDeviceCodes.deviceCodeHash, found.deviceCodeHash));
					return issueTokens(tx, grant.id, now);
				});
				if ("error" in outcome) throw new OAuthRequestError(outcome.error, outcome.text);
				return outcome;
			}
			if (grantType === "refresh_token") {
				const refresh = form.get("refresh_token") ?? "";
				const outcome = await db.transaction(async (tx) => {
					const [found] = await tx
						.select({ token: oauthTokens, grant: oauthGrants })
						.from(oauthTokens)
						.innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
						.where(and(eq(oauthTokens.tokenHash, await hashed(refresh)), eq(oauthTokens.kind, "refresh")))
						.for("update");
					if (!found || found.grant.clientId !== client.id) {
						return "This refresh token isn't valid.";
					}
					if (found.grant.revokedAt) return "This grant was revoked.";
					if (found.token.usedAt) {
						await revokeGrant(tx, found.grant, now, "reuse");
						return "This refresh token was used already: the grant is revoked.";
					}
					if (found.token.expiresAt.getTime() <= now.getTime()) {
						return "This refresh token has expired.";
					}
					const person = await loadPersonActor(tx, found.grant.personId);
					const listed = await grantSites(tx, found.grant.allSites ? [] : [found.grant.id]);
					const siteIds = (listed.get(found.grant.id) ?? []).map((site) => site.id);
					if (!reaches(person, found.grant, siteIds)) {
						await revokeGrant(tx, found.grant, now, "access");
						return "Its person no longer reaches what this grant was for: it is revoked.";
					}
					await tx.update(oauthTokens).set({ usedAt: now }).where(eq(oauthTokens.tokenHash, found.token.tokenHash));
					return issueTokens(tx, found.grant.id, now);
				});
				// A refusal is its reason, in words.
				if (typeof outcome === "string") throw new OAuthRequestError("invalid_grant", outcome);
				return outcome;
			}
			throw new OAuthRequestError(
				"unsupported_grant_type",
				`grant_type is authorization_code, ${DEVICE_CODE_GRANT} or refresh_token.`,
			);
		},

		async deviceAuthorization(form, authorization, clientAddress) {
			if (!(await rateLimits.count(`oauth-device:${clientAddress ?? "unknown"}`, OAUTH_DEVICE_LIMIT))) {
				throw new OAuthRequestError(
					"slow_down",
					"Too many sign-ins were started from this address. Try again later.",
					429,
				);
			}
			const client = await authenticate(form, authorization);
			if (!allows(client, DEVICE_CODE_GRANT)) {
				throw new OAuthRequestError("unauthorized_client", "This client didn't register for device codes.");
			}
			const asked = form.get("resource");
			const target =
				asked === null || isOurResource(asked, apiResource)
					? apiResource
					: isOurResource(asked, resource)
						? resource
						: null;
			if (!target) throw new OAuthRequestError("invalid_target", `Tokens here are for ${apiResource} or ${resource}.`);
			const now = clock.now();
			const deviceCode = `${OAUTH_PREFIXES.deviceCode}${newToken()}`;
			for (let attempt = 0; ; attempt++) {
				const letters = Array.from(
					crypto.getRandomValues(new Uint32Array(USER_CODE_LENGTH)),
					(value) => USER_CODE_LETTERS[value % USER_CODE_LETTERS.length],
				).join("");
				const inserted = await db
					.insert(oauthDeviceCodes)
					.values({
						deviceCodeHash: await hashed(deviceCode),
						userCodeHash: await hashed(`user:${letters}`),
						clientId: client.id,
						resource: target,
						createdAt: now,
						requestedFrom: clientAddress,
						expiresAt: new Date(now.getTime() + OAUTH_LIFETIMES.deviceMs),
						intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
						status: "pending",
					})
					.onConflictDoNothing()
					.returning({ hash: oauthDeviceCodes.deviceCodeHash });
				if (inserted.length === 0) {
					if (attempt < 5) continue;
					throw new OAuthRequestError("temporarily_unavailable", "No free user code was found. Try again.", 503);
				}
				const userCode = `${letters.slice(0, 4)}-${letters.slice(4)}`;
				const page = `${issuer}/oauth/device`;
				return {
					device_code: deviceCode,
					user_code: userCode,
					verification_uri: page,
					verification_uri_complete: `${page}?user_code=${userCode}`,
					expires_in: Math.floor(OAUTH_LIFETIMES.deviceMs / 1000),
					interval: DEVICE_POLL_INTERVAL_SECONDS,
				};
			}
		},

		async checkDevice(userCode, personId, { typed, clientAddress }) {
			await countUserCode(personId);
			const looked = await deviceByUserCode(db, userCode, clock.now());
			if (!looked.ok) return { kind: "refused", problem: looked.problem };
			const { found, letters } = looked;
			const asked = clientNetwork(found.device.requestedFrom);
			const sameNetwork = asked !== "unknown" && asked === clientNetwork(clientAddress);
			// A link fills the code in for whoever opens it. Only the person at the terminal has the code
			// to type; a link is trusted only on the network the sign-in was started from.
			if (!typed && !sameNetwork) return { kind: "type" };
			return {
				kind: "ask",
				request: {
					client: { id: found.client.id, name: found.client.name },
					userCode: `${letters.slice(0, 4)}-${letters.slice(4)}`,
					requestedAt: found.device.createdAt,
					network: networkOf(found.device.requestedFrom),
					sameNetwork,
				},
			};
		},

		async approveDevice(scope, userCode, choice) {
			const { actor } = scope.access;
			if (actor.kind !== "person") throw new TypeError("Only a person approves an AI client.");
			await countUserCode(actor.personId);
			const listed = choice.sites === "all" ? null : [...new Set(choice.sites)];
			if (listed !== null) {
				if (listed.length === 0) throw new SiteNotFoundError();
				for (const siteId of listed) {
					const seen =
						isUuid(siteId) &&
						can(actor, "site.view", { level: "site", workspaceId: scope.workspace.id, siteId }) &&
						(await db
							.select({ id: sites.id })
							.from(sites)
							.where(and(eq(sites.id, siteId), eq(sites.workspaceId, scope.workspace.id)))
							.then((rows) => rows.length > 0));
					if (!seen) throw new SiteNotFoundError();
				}
			}
			const chosen = chosenToolsets(choice.toolsets, toolsets());
			const now = scope.now();
			return scope.transaction(async (tx) => {
				const looked = await deviceByUserCode(tx.db, userCode, now);
				if (!looked.ok) throw new DeviceCodeInvalidError(looked.problem);
				const { found } = looked;
				const grant = await tx.insert(oauthGrants, {
					clientId: found.client.id,
					personId: actor.personId,
					clientName: found.client.name,
					redirectUri: "",
					resource: found.device.resource,
					allSites: listed === null,
					readOnly: choice.readOnly,
					mayPublish: choice.readOnly ? false : choice.mayPublish,
					toolsets: chosen,
					createdAt: now,
				});
				for (const siteId of listed ?? []) await tx.insert(oauthGrantSites, { grantId: grant.id, siteId });
				await tx.db
					.update(oauthDeviceCodes)
					.set({ status: "approved", grantId: grant.id })
					.where(eq(oauthDeviceCodes.deviceCodeHash, found.device.deviceCodeHash));
				await tx.audit("aiClient.approve", {
					grantId: grant.id,
					client: found.client.name,
					device: true,
					sites: listed ?? "all",
					readOnly: choice.readOnly,
					mayPublish: choice.readOnly ? false : choice.mayPublish,
					toolsets: chosen,
				});
				return { grantId: grant.id, client: found.client.name };
			});
		},

		async denyDevice(userCode, personId) {
			await countUserCode(personId);
			await db.transaction(async (tx) => {
				const looked = await deviceByUserCode(tx, userCode, clock.now());
				if (!looked.ok) throw new DeviceCodeInvalidError(looked.problem);
				await tx
					.update(oauthDeviceCodes)
					.set({ status: "denied" })
					.where(eq(oauthDeviceCodes.deviceCodeHash, looked.found.device.deviceCodeHash));
			});
		},

		async revokeToken(form, authorization) {
			const client = await authenticate(form, authorization);
			const token = form.get("token");
			if (!token) throw new OAuthRequestError("invalid_request", "Send the token to revoke.");
			const now = clock.now();
			await db.transaction(async (tx) => {
				const [found] = await tx
					.select({ grant: oauthGrants })
					.from(oauthTokens)
					.innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
					.where(eq(oauthTokens.tokenHash, await hashed(token)))
					.for("update");
				// RFC 7009: an unknown token, or another client's, is answered as if revoked.
				if (!found || found.grant.clientId !== client.id || found.grant.revokedAt) return;
				await revokeGrant(tx, found.grant, now, "client");
			});
		},

		async use(secret, wanted = resource) {
			if (!secret) throw new ApiTokenInvalidError("missing");
			if (!secret.startsWith(OAUTH_PREFIXES.access) || secret.length > 200) throw new ApiTokenInvalidError("unknown");
			const [found] = await db
				.select({ token: oauthTokens, grant: oauthGrants })
				.from(oauthTokens)
				.innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
				.where(and(eq(oauthTokens.tokenHash, await hashed(secret)), eq(oauthTokens.kind, "access")));
			if (!found) throw new ApiTokenInvalidError("unknown");
			const { token, grant } = found;
			// A grant's tokens are for one resource: the CLI's for the API, an AI client's for the MCP server.
			if ((grant.resource ?? resource) !== wanted) throw new ApiTokenInvalidError("unknown");
			const now = clock.now();
			if (grant.revokedAt || token.usedAt) throw new ApiTokenInvalidError("revoked");
			if (token.expiresAt.getTime() <= now.getTime()) throw new ApiTokenInvalidError("expired");
			const [person, personActor, listed] = await Promise.all([
				peopleService.get(grant.personId),
				loadPersonActor(db, grant.personId),
				grant.allSites
					? Promise.resolve<string[]>([])
					: db
							.select({ siteId: oauthGrantSites.siteId })
							.from(oauthGrantSites)
							.where(eq(oauthGrantSites.grantId, grant.id))
							.then((rows) => rows.map((row) => row.siteId)),
			]);
			if (!person) throw new ApiTokenInvalidError("unknown");
			if (!reaches(personActor, grant, listed)) {
				await db.transaction((tx) => revokeGrant(tx, grant, now, "access"));
				throw new ApiTokenInvalidError("revoked");
			}
			if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
				await db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, grant.id));
			}
			const actor: GrantActor = {
				kind: "grant",
				grantId: grant.id,
				person: personActor,
				workspaceId: grant.workspaceId,
				sites: grant.allSites ? "all" : (listed satisfies Reach),
			};
			const via: AuditVia = { kind: "aiClient", name: grant.clientName };
			const client: ApiClientLimits = {
				kind: "grant",
				id: grant.id,
				name: grant.clientName,
				readOnly: grant.readOnly,
				toolsets: grant.toolsets as ToolsetKey[],
				mayPublish: grant.mayPublish && !grant.readOnly,
			};
			return { client, person, access: { actor, via } };
		},

		count(grantId, access) {
			return countClient(rateLimits, `oauth-grant:${grantId}`, access);
		},

		async list(personId) {
			if (!isUuid(personId)) return [];
			return views(db, eq(oauthGrants.personId, personId));
		},

		async revoke(access, grantId) {
			const personId = access.actor.kind === "person" ? access.actor.personId : null;
			if (personId === null) throw new TypeError("Only a person revokes their AI clients.");
			if (!isUuid(grantId)) throw new OAuthGrantNotFoundError();
			await db.transaction(async (tx) => {
				const [grant] = await tx
					.select()
					.from(oauthGrants)
					.where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.personId, personId)))
					.for("update");
				if (!grant) throw new OAuthGrantNotFoundError();
				if (grant.revokedAt) return;
				await revokeGrant(tx, grant, clock.now(), "person", { personId, via: access.via });
			});
			return viewOf(grantId);
		},

		async purge() {
			const now = clock.now();
			let removed = 0;
			removed += (await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now)).returning()).length;
			removed += (await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now)).returning()).length;
			removed += (await db.delete(oauthDeviceCodes).where(lt(oauthDeviceCodes.expiresAt, now)).returning()).length;
			const unapproved = await db
				.delete(oauthClients)
				.where(
					and(
						lt(oauthClients.createdAt, new Date(now.getTime() - UNAPPROVED_CLIENT_MS)),
						sql`not exists (select 1 from ${oauthGrants} where ${oauthGrants.clientId} = ${oauthClients.id})`,
					),
				)
				.returning();
			return removed + unapproved.length;
		},
	};

	/** The grants among `grantIds` that a token can still be used or refreshed for. */
	async function liveGrants(executor: Executor, grantIds: readonly string[], now: Date): Promise<Set<string>> {
		if (grantIds.length === 0) return new Set();
		const rows = await executor
			.selectDistinct({ grantId: oauthTokens.grantId })
			.from(oauthTokens)
			.where(
				and(inArray(oauthTokens.grantId, [...grantIds]), isNull(oauthTokens.usedAt), gt(oauthTokens.expiresAt, now)),
			);
		return new Set(rows.map((row) => row.grantId));
	}
}

type GrantRow = typeof oauthGrants.$inferSelect;

/**
 * Ends a grant at once, with every token of it, and logs `aiClient.revoke` in its Workspace with
 * why. `by` is who did it: nobody (WebCraft) unless given.
 */
async function revokeGrant(
	executor: Executor,
	grant: Pick<GrantRow, "id" | "clientName" | "personId" | "workspaceId">,
	now: Date,
	reason: "person" | "client" | "access" | "reuse",
	by: { personId: string | null; via: AuditVia } = {
		personId: null,
		via: { kind: "aiClient", name: grant.clientName },
	},
): Promise<boolean> {
	const revoked = await executor
		.update(oauthGrants)
		.set({ revokedAt: now, revokedReason: reason })
		.where(and(eq(oauthGrants.id, grant.id), isNull(oauthGrants.revokedAt)))
		.returning({ id: oauthGrants.id });
	if (revoked.length === 0) return false;
	await executor
		.update(oauthTokens)
		.set({ usedAt: now })
		.where(and(eq(oauthTokens.grantId, grant.id), isNull(oauthTokens.usedAt)));
	await recordAudit(executor, now, {
		personId: by.personId,
		via: by.via,
		workspaceId: grant.workspaceId,
		siteId: null,
		action: "aiClient.revoke",
		details: { grantId: grant.id, client: grant.clientName, owner: grant.personId, reason },
	});
	return true;
}

/**
 * Revokes the person's working grants whose Workspace (or every listed Site) they no longer reach,
 * logging `aiClient.revoke` with `reason: "access"` as `by` did it. Call it inside the transaction
 * of the change that took their access, beside `revokeTokensOutOfReach`.
 */
export async function revokeGrantsOutOfReach(
	executor: Executor,
	personId: string,
	now: Date,
	by: { personId: string | null; via: AuditVia },
): Promise<number> {
	const active = await executor
		.select()
		.from(oauthGrants)
		.where(and(eq(oauthGrants.personId, personId), isNull(oauthGrants.revokedAt)));
	if (active.length === 0) return 0;
	const actor = await loadPersonActor(executor, personId);
	const listed = await executor
		.select({ grantId: oauthGrantSites.grantId, siteId: oauthGrantSites.siteId })
		.from(oauthGrantSites)
		.where(
			inArray(
				oauthGrantSites.grantId,
				active.map((grant) => grant.id),
			),
		);
	let revoked = 0;
	for (const grant of active) {
		const siteIds = listed.filter((row) => row.grantId === grant.id).map((row) => row.siteId);
		if (reaches(actor, grant, siteIds)) continue;
		if (await revokeGrant(executor, grant, now, "access", by)) revoked++;
	}
	return revoked;
}

/** Why a redirect URI can't be registered, or null when it can: https, or http on the loopback interface. */
function redirectUriProblem(uri: string): string | null {
	if (uri.length > MAX_URI_LENGTH) return "it is too long.";
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return "it isn't an absolute address.";
	}
	if (url.hash !== "" || uri.includes("#")) return "it may not have a fragment (#).";
	if (url.username !== "" || url.password !== "") return "it may not carry a user name or password.";
	if (url.protocol === "https:") return null;
	if (url.protocol === "http:" && isLoopback(uri)) return null;
	return "use https, or http on this device's loopback address (127.0.0.1, [::1] or localhost).";
}

/** Whether an address is on the person's own device: the loopback interface. */
function isLoopback(uri: string): boolean {
	try {
		const host = new URL(uri).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
	} catch {
		return false;
	}
}

/** Whether `given` names the MCP server (RFC 8707), allowing upper-case scheme and host and a trailing slash. */
function isOurResource(given: string, resource: string): boolean {
	try {
		const url = new URL(given);
		const ours = new URL(resource);
		return (
			url.origin === ours.origin &&
			url.pathname.replace(/\/+$/, "") === ours.pathname &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

/** Whether a PKCE verifier matches its S256 challenge (RFC 7636 §4.6). */
async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return Buffer.from(digest).toString("base64url") === challenge;
}

/** `redirectUri` with the answer's parameters added, keeping its own. */
function answerUrl(redirectUri: string, parameters: Record<string, string | undefined>): string {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(parameters)) {
		if (value !== undefined) url.searchParams.set(name, value);
	}
	return url.toString();
}

function hostOf(uri: string): string {
	try {
		return new URL(uri).host;
	} catch {
		return uri;
	}
}

/** A client's name as it is shown: one line, without control characters, at most 100 characters. */
function cleanName(name: string): string {
	return name
		.replace(/\p{Cc}|\p{Cf}/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_CLIENT_NAME)
		.trim();
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value.replaceAll("+", " "));
	} catch {
		return value;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
