import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { StoredSignIn } from "../account/credentials.ts";
import { chooseProfile, installUrl, type Profile, readProfiles } from "../account/profiles.ts";
import { CliError, EXIT } from "../exit-codes.ts";
import type { CliIo } from "../io.ts";
import { cliVersion, olderThan, VERSION_HEADER } from "../version.ts";
import { type Catalogue, catalogueOf } from "./catalogue.ts";

/** Options every command takes. */
export type GlobalOptions = {
	/** A profile's name or an Install's address (`--install`, else `WEBCRAFT_INSTALL`). */
	install?: string;
	json: boolean;
	yes: boolean;
	/** `--help`: the command's help instead of running it. */
	help?: boolean;
};

/** What one run of `webcraft` shares between its calls. */
export type RunContext = {
	io: CliIo;
	options: GlobalOptions;
	/** Whether this run already said the CLI is older than the Install. */
	warnedAboutVersion: boolean;
	/** The Install's version, once an answer said it. */
	installVersion: string | null;
};

/**
 * How the CLI reaches an Install: its address, and the credential every call carries.
 *
 * - With `WEBCRAFT_TOKEN`, an API token (for CI): the Install is `--install`/`WEBCRAFT_INSTALL` (an
 *   address or a profile), else the default profile's.
 * - Otherwise a profile's device sign-in (`webcraft login`): an OAuth grant's access token, refreshed
 *   when it runs out.
 */
export type Connection = {
	url: string;
	profile: Profile | null;
	kind: "apiToken" | "signIn";
	/** Sends a request to the Install with the credential, refreshing a sign-in once when it ran out. */
	send(path: string, init?: RequestInit): Promise<Response>;
	/** The Install's commands: its OpenAPI document, read once per run (and kept between runs by its ETag). */
	catalogue(): Promise<Catalogue>;
};

/** How long before its end an access token is refreshed instead of used. */
const REFRESH_MARGIN_MS = 30_000;

export async function connect(context: RunContext): Promise<Connection> {
	const { io, options } = context;
	const install = options.install ?? (io.env.WEBCRAFT_INSTALL?.trim() || undefined);
	const profiles = await readProfiles(io.configDir);
	const profile = chooseProfile(profiles, install);
	const token = io.env.WEBCRAFT_TOKEN?.trim();

	if (token) {
		const url = profile?.url ?? (install ? installUrl(install) : null);
		if (!url) {
			throw new CliError(
				EXIT.signIn,
				"WEBCRAFT_TOKEN is set, but not which Install it is for: set WEBCRAFT_INSTALL to the Install's admin address.",
			);
		}
		return connection(context, url, profile, "apiToken", async () => token, null);
	}

	if (!profile) {
		throw new CliError(
			EXIT.signIn,
			install
				? `You aren't signed in to ${install}. Run: webcraft login --install ${install}`
				: "You aren't signed in to an Install. Run: webcraft login --install <the Install's admin address>",
		);
	}
	const stored = await io.credentials.get(profile.name);
	if (!stored || !profile.clientId) {
		throw new CliError(
			EXIT.signIn,
			`You aren't signed in to ${profile.name}. Run: webcraft login --install ${profile.name}`,
		);
	}
	let current: StoredSignIn = stored;
	const fresh = async () => {
		if (new Date(current.accessExpiresAt).getTime() - REFRESH_MARGIN_MS <= io.now().getTime()) {
			current = await refreshSignIn(io, profile, current);
		}
		return current.accessToken;
	};
	const renew = async () => {
		current = await refreshSignIn(io, profile, current);
		return current.accessToken;
	};
	return connection(context, profile.url, profile, "signIn", fresh, renew);
}

function connection(
	context: RunContext,
	url: string,
	profile: Profile | null,
	kind: Connection["kind"],
	credential: () => Promise<string>,
	renew: (() => Promise<string>) | null,
): Connection {
	const { io } = context;
	let catalogue: Promise<Catalogue> | null = null;

	const send = async (path: string, init: RequestInit = {}) => {
		const attempt = async (secret: string) => {
			const headers = new Headers(init.headers);
			headers.set("authorization", `Bearer ${secret}`);
			headers.set("user-agent", `webcraft-cli/${cliVersion(io)}`);
			return request(io, new Request(`${url}${path}`, { method: "POST", ...init, headers }));
		};
		let response = await attempt(await credential());
		if (response.status === 401 && renew && (await problemOf(response.clone() as Response)) === "expired") {
			response = await attempt(await renew());
		}
		noteVersion(context, response);
		return response;
	};

	return {
		url,
		profile,
		kind,
		send,
		catalogue() {
			catalogue ??= readCatalogue(io, url);
			return catalogue;
		},
	};
}

/** Sends a request, turning a network failure into "couldn't be reached". */
export async function request(io: CliIo, outgoing: Request): Promise<Response> {
	try {
		return await io.fetch(outgoing);
	} catch (error) {
		throw new CliError(
			EXIT.unreachable,
			`Couldn't reach ${new URL(outgoing.url).origin} (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
}

async function problemOf(response: Response): Promise<string | null> {
	try {
		const body = (await response.json()) as { data?: { problem?: unknown } };
		return typeof body.data?.problem === "string" ? body.data.problem : null;
	} catch {
		return null;
	}
}

/**
 * Says once per run, on standard error, when this `webcraft` is older than the Install it talks to:
 * the Install's answers carry its version (`WebCraft-Version`).
 */
function noteVersion(context: RunContext, response: Response): void {
	const version = response.headers.get(VERSION_HEADER);
	if (!version) return;
	context.installVersion = version;
	const running = cliVersion(context.io);
	if (context.warnedAboutVersion || !olderThan(running, version)) return;
	context.warnedAboutVersion = true;
	context.io.stderr(
		`webcraft: this webcraft is ${running}, older than the Install (WebCraft ${version}). Update it to get every command the Install offers.\n`,
	);
}

/** Where a fetched OpenAPI document is kept between runs, by the Install's address. */
function cachePath(io: CliIo, url: string): string {
	const name = new URL(url).host.replace(/[^A-Za-z0-9.-]/g, "_");
	return join(io.configDir, "cache", `${name}.openapi.json`);
}

/**
 * The Install's OpenAPI document (open to anyone, so it is fetched without a credential), asked with
 * the ETag of the copy kept from an earlier run: unchanged, the Install answers 304 and the copy is used.
 */
async function readCatalogue(io: CliIo, url: string): Promise<Catalogue> {
	const path = cachePath(io, url);
	let cached: { etag: string; document: unknown } | null = null;
	try {
		cached = JSON.parse(await readFile(path, "utf8")) as { etag: string; document: unknown };
	} catch {
		cached = null;
	}
	const headers = new Headers({ accept: "application/json", "user-agent": `webcraft-cli/${cliVersion(io)}` });
	if (cached?.etag) headers.set("if-none-match", cached.etag);
	const response = await request(io, new Request(`${url}/api/v1/openapi.json`, { headers }));
	if (response.status === 304 && cached) return catalogueOf(cached.document);
	if (!response.ok) {
		throw new CliError(
			EXIT.unreachable,
			`${url} didn't answer with its API's commands (${response.status}). Is it a WebCraft Install's admin address?`,
		);
	}
	const document: unknown = await response.json().catch(() => null);
	if (!document || typeof document !== "object" || !("paths" in document)) {
		throw new CliError(
			EXIT.unreachable,
			`${url} didn't answer with its API's commands. Is it a WebCraft Install's admin address?`,
		);
	}
	const etag = response.headers.get("etag");
	if (etag) {
		await mkdir(join(io.configDir, "cache"), { recursive: true });
		await writeFile(path, JSON.stringify({ etag, document }));
	}
	return catalogueOf(document);
}

/** A refresh another process holds: waited for at most this long. */
const LOCK_WAIT_MS = 15_000;
/** A lock older than this was left by a process that died. */
const STALE_LOCK_MS = 60_000;

/**
 * Exchanges a sign-in's refresh token for new tokens, kept at once. A refresh token works once (a
 * second use ends the grant), so processes sharing a profile take turns through a lock file, and one
 * that finds the sign-in already refreshed by another uses that.
 */
export async function refreshSignIn(io: CliIo, profile: Profile, known: StoredSignIn): Promise<StoredSignIn> {
	const lock = join(io.configDir, `${profile.name.replace(/[^A-Za-z0-9.-]/g, "_")}.refresh.lock`);
	const release = await acquireLock(lock);
	try {
		const stored = await io.credentials.get(profile.name);
		if (!stored) throw signedOut(profile);
		if (
			stored.refreshToken !== known.refreshToken &&
			new Date(stored.accessExpiresAt).getTime() > io.now().getTime() + REFRESH_MARGIN_MS
		) {
			return stored;
		}
		const response = await request(
			io,
			new Request(`${profile.url}/oauth/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: stored.refreshToken,
					client_id: profile.clientId ?? "",
				}),
			}),
		);
		const body = (await response.json().catch(() => ({}))) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			error?: string;
		};
		if (!response.ok || !body.access_token || !body.refresh_token) {
			if (body.error === "invalid_grant" || body.error === "invalid_client") {
				await io.credentials.delete(profile.name);
				throw signedOut(profile);
			}
			throw new CliError(
				EXIT.failed,
				`${profile.url} refused to renew your sign-in (${body.error ?? response.status}).`,
			);
		}
		const renewed: StoredSignIn = {
			accessToken: body.access_token,
			refreshToken: body.refresh_token,
			accessExpiresAt: new Date(io.now().getTime() + (body.expires_in ?? 3600) * 1000).toISOString(),
		};
		await io.credentials.set(profile.name, renewed);
		return renewed;
	} finally {
		await release();
	}
}

function signedOut(profile: Profile): CliError {
	return new CliError(
		EXIT.signIn,
		`Your sign-in to ${profile.name} has ended (it was revoked, or unused for too long). Run: webcraft login --install ${profile.name}`,
	);
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
	const started = Date.now();
	for (;;) {
		try {
			const handle = await open(path, "wx");
			await handle.close();
			return () => rm(path, { force: true });
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			const age = await stat(path).then(
				(info) => Date.now() - info.mtimeMs,
				() => 0,
			);
			if (age > STALE_LOCK_MS) await rm(path, { force: true });
			else if (Date.now() - started > LOCK_WAIT_MS) {
				throw new CliError(EXIT.failed, `Another webcraft is renewing this sign-in (${path}). Try again.`);
			} else await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}
