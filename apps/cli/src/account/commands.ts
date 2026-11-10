import { CliError, EXIT } from "../exit-codes.ts";
import type { CliIo } from "../io.ts";
import { connect, type RunContext, request } from "../remote/connection.ts";
import { call } from "../remote/run.ts";
import type { CredentialPlace, StoredSignIn } from "./credentials.ts";
import {
	chooseProfile,
	installUrl,
	type Profile,
	type ProfilesFile,
	profileNameFor,
	readProfiles,
	writeProfiles,
} from "./profiles.ts";

/** The device authorization grant (RFC 8628). */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const LOGIN_HELP = `Usage: webcraft login --install <address> [--name <profile name>] [--no-browser]

Signs in to an Install with a device code: webcraft shows a short code and an address; open it in a
browser where you are signed in to the admin, check the code and choose what webcraft may do (the
Workspace, its Sites, the Toolsets, read-only, May publish). webcraft waits until you approve.

The sign-in is kept in the system's keychain where there is one, else in a file in the config folder
only you can read (WEBCRAFT_CREDENTIALS=file always uses the file). Each Install is a profile, named
after its address unless --name says otherwise; the one signed in to last is used by default.
It shows under Your account › AI clients in the admin, where you can revoke it.
`;

const LOGOUT_HELP = `Usage: webcraft logout [--install <profile>]

Ends the sign-in on the Install (its grant is revoked) and forgets it here.
`;

const WHOAMI_HELP = `Usage: webcraft whoami [--install <profile>] [--json]

Who webcraft acts as: the person, the Install and its version, how it signed in, and what it reaches:
the Workspace, its Sites, the Toolsets, and whether it only reads or may publish.
`;

const PROFILES_HELP = `Usage: webcraft profiles [use <name>]

Lists the Installs webcraft signed in to (its profiles), marking the one commands use by default;
"use <name>" makes another the default. --install <name or address> picks one for a single command.
`;

/** `webcraft login`, `logout`, `whoami` and `profiles`. */
export async function runAccount(context: RunContext, command: string, args: string[], help: boolean): Promise<number> {
	const { io } = context;
	if (help) {
		io.stdout(
			command === "login"
				? LOGIN_HELP
				: command === "logout"
					? LOGOUT_HELP
					: command === "whoami"
						? WHOAMI_HELP
						: PROFILES_HELP,
		);
		return EXIT.ok;
	}
	switch (command) {
		case "login":
			return login(context, args);
		case "logout":
			return logout(context, args);
		case "whoami":
			return whoami(context, args);
		default:
			return profiles(context, args);
	}
}

function options(args: string[], known: Record<string, "value" | "switch">): Record<string, string | true> {
	const found: Record<string, string | true> = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const equals = arg.indexOf("=");
		const name = arg.startsWith("--") ? (equals === -1 ? arg.slice(2) : arg.slice(2, equals)) : "";
		const kind = known[name];
		if (!kind) throw new CliError(EXIT.usage, `Unexpected ${arg.startsWith("--") ? "option" : "argument"} "${arg}".`);
		if (kind === "switch") found[name] = true;
		else {
			const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
			if (!value) throw new CliError(EXIT.usage, `--${name} needs a value.`);
			found[name] = value;
		}
	}
	return found;
}

async function postForm(io: CliIo, url: string, form: Record<string, string>) {
	const response = await request(
		io,
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams(form),
		}),
	);
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: response.status, ok: response.ok, body };
}

/** Registers the CLI as a public OAuth client of the Install that signs in with device codes only. */
async function registerClient(io: CliIo, url: string): Promise<string> {
	const response = await request(
		io,
		new Request(`${url}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				client_name: `webcraft CLI on ${io.hostname}`.slice(0, 100),
				grant_types: [DEVICE_CODE_GRANT, "refresh_token"],
				token_endpoint_auth_method: "none",
				application_type: "native",
			}),
		}),
	);
	const body = (await response.json().catch(() => ({}))) as { client_id?: string; error_description?: string };
	if (!response.ok || !body.client_id) {
		throw new CliError(
			response.status === 404 ? EXIT.unreachable : EXIT.failed,
			response.status === 404
				? `${url} doesn't look like a WebCraft Install's admin address.`
				: `${url} refused to register webcraft: ${body.error_description ?? response.status}.`,
		);
	}
	return body.client_id;
}

async function login(context: RunContext, args: string[]): Promise<number> {
	const { io } = context;
	const given = options(args, { name: "value", "no-browser": "switch" });
	const file = await readProfiles(io.configDir);
	const install = context.options.install ?? (io.env.WEBCRAFT_INSTALL?.trim() || undefined);
	const existing = chooseProfile(file, install);
	if (!install && !existing) {
		throw new CliError(EXIT.usage, "Which Install? Run: webcraft login --install <the Install's admin address>");
	}
	const url = existing?.url ?? installUrl(install ?? "");
	const name = typeof given.name === "string" ? given.name : (existing?.name ?? profileNameFor(file, url));
	const profile: Profile = { ...(file.profiles[name] ?? existing ?? {}), name, url };

	// The CLI's client on this Install: registered once, again when the Install forgot it.
	let clientId = profile.clientId ?? (await registerClient(io, url));
	let started = await postForm(io, `${url}/oauth/device_authorization`, { client_id: clientId });
	if (started.body.error === "invalid_client" || started.body.error === "unauthorized_client") {
		clientId = await registerClient(io, url);
		started = await postForm(io, `${url}/oauth/device_authorization`, { client_id: clientId });
	}
	const device = started.body as {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		verification_uri_complete?: string;
		expires_in?: number;
		interval?: number;
		error_description?: string;
	};
	if (!started.ok || !device.device_code || !device.user_code || !device.verification_uri) {
		throw new CliError(EXIT.failed, `${url} didn't start a sign-in: ${device.error_description ?? started.status}.`);
	}
	await saveProfile(io, file, { ...profile, clientId }, false);

	const minutes = Math.round((device.expires_in ?? 600) / 60);
	io.stderr(
		`To sign in, open ${device.verification_uri} in a browser where you are signed in to the admin,\n` +
			`and enter this code: ${device.user_code}\n` +
			`(or open ${device.verification_uri_complete ?? device.verification_uri}). The code works for ${minutes} minutes, once.\n` +
			"Only approve it if you started this sign-in yourself, just now.\n",
	);
	if (io.interactive && given["no-browser"] !== true && device.verification_uri_complete) {
		await io.openBrowser(device.verification_uri_complete);
	}
	io.stderr("Waiting for you to approve it…\n");

	let interval = Math.max(1, device.interval ?? 5);
	const deadline = io.now().getTime() + (device.expires_in ?? 600) * 1000;
	for (;;) {
		await io.sleep(interval * 1000);
		const polled = await postForm(io, `${url}/oauth/token`, {
			grant_type: DEVICE_CODE_GRANT,
			device_code: device.device_code,
			client_id: clientId,
		});
		const error = polled.body.error;
		if (polled.ok) {
			const tokens = polled.body as { access_token?: string; refresh_token?: string; expires_in?: number };
			if (!tokens.access_token || !tokens.refresh_token)
				throw new CliError(EXIT.failed, `${url} answered without tokens.`);
			const signIn: StoredSignIn = {
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				accessExpiresAt: new Date(io.now().getTime() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
			};
			const place = await io.credentials.set(name, signIn);
			return signedIn(context, { ...profile, clientId, place }, place);
		}
		if (error === "authorization_pending") {
			if (io.now().getTime() >= deadline) break;
			continue;
		}
		if (error === "slow_down") {
			interval += 5;
			continue;
		}
		if (error === "access_denied") {
			throw new CliError(EXIT.notConfirmed, "The sign-in was denied in the browser. Nothing was signed in.");
		}
		if (error === "expired_token") break;
		throw new CliError(
			EXIT.failed,
			`${url} refused the sign-in: ${String(polled.body.error_description ?? error ?? polled.status)}.`,
		);
	}
	throw new CliError(EXIT.signIn, "The code expired before it was approved. Run webcraft login again for a new one.");
}

async function saveProfile(io: CliIo, file: ProfilesFile, profile: Profile, makeDefault: boolean): Promise<void> {
	const latest = await readProfiles(io.configDir);
	latest.profiles[profile.name] = profile;
	if (makeDefault || !latest.default || !latest.profiles[latest.default]) latest.default = profile.name;
	file.profiles = latest.profiles;
	file.default = latest.default;
	await writeProfiles(io.configDir, latest);
}

type Current = {
	person: { id: string; name: string; email: string };
	install: { address: string; version: string };
	client: {
		kind: "apiToken" | "oauthGrant";
		name: string;
		workspace: { id: string; name: string | null };
		sites: "all" | { id: string; name: string }[];
		readOnly: boolean;
		mayPublish: boolean;
		toolsets: string[];
	} | null;
};

const ACCESS_CURRENT = { path: "access/current", files: [] };

async function signedIn(context: RunContext, profile: Profile, place: CredentialPlace): Promise<number> {
	const { io } = context;
	const connection = await connect({ ...context, options: { ...context.options, install: profile.name } });
	const current = (await call(connection, ACCESS_CURRENT, {})) as Current;
	const file = await readProfiles(io.configDir);
	await saveProfile(
		io,
		file,
		{
			...profile,
			signedIn: {
				person: current.person.email,
				workspace: current.client?.workspace.name ?? "",
				at: io.now().toISOString(),
			},
		},
		true,
	);
	if (context.options.json) {
		io.stdout(`${JSON.stringify({ profile: profile.name, keptIn: place, ...current }, null, 2)}\n`);
		return EXIT.ok;
	}
	io.stdout(
		`Signed in to ${profile.url} as ${current.person.name} <${current.person.email}>` +
			`${current.client?.workspace.name ? ` in ${current.client.workspace.name}` : ""} (profile ${profile.name}).\n` +
			(place === "keychain"
				? "The sign-in is kept in the system keychain.\n"
				: `The sign-in is kept in ${io.credentials.file}, readable only by you (no system keychain was available).\n`),
	);
	return EXIT.ok;
}

async function whoami(context: RunContext, args: string[]): Promise<number> {
	const { io } = context;
	options(args, {});
	const connection = await connect(context);
	const current = (await call(connection, ACCESS_CURRENT, {})) as Current;
	const how =
		connection.kind === "apiToken"
			? `the API token in WEBCRAFT_TOKEN${current.client ? ` ("${current.client.name}")` : ""}`
			: `webcraft login (profile ${connection.profile?.name ?? ""}, kept ${connection.profile?.place === "file" ? `in ${io.credentials.file}` : "in the system keychain"})`;
	if (context.options.json) {
		io.stdout(
			`${JSON.stringify({ profile: connection.profile?.name ?? null, credential: connection.kind, ...current }, null, 2)}\n`,
		);
		return EXIT.ok;
	}
	const client = current.client;
	const lines = [
		`Person:     ${current.person.name} <${current.person.email}>`,
		`Install:    ${current.install.address} (WebCraft ${current.install.version})`,
		`Signed in:  with ${how}`,
	];
	if (client) {
		lines.push(
			`Workspace:  ${client.workspace.name ?? client.workspace.id}`,
			`Sites:      ${client.sites === "all" ? "every Site, later ones too" : client.sites.map((site) => site.name).join(", ") || "none"}`,
			`Toolsets:   ${client.toolsets.join(", ") || "none"}`,
			`Access:     ${client.readOnly ? "reads only" : "reads and changes"}${client.mayPublish ? "; may publish" : "; doesn't publish"}`,
		);
	}
	io.stdout(`${lines.join("\n")}\n`);
	return EXIT.ok;
}

async function logout(context: RunContext, args: string[]): Promise<number> {
	const { io } = context;
	options(args, {});
	const file = await readProfiles(io.configDir);
	const install = context.options.install ?? (io.env.WEBCRAFT_INSTALL?.trim() || undefined);
	const profile = chooseProfile(file, install);
	if (!profile) {
		io.stderr(`You aren't signed in to ${install ?? "an Install"}.\n`);
		return EXIT.ok;
	}
	const stored = await io.credentials.get(profile.name);
	const { signedIn: _, place: __, ...rest } = profile;
	await saveProfile(io, file, rest, false);
	if (!stored) {
		io.stdout(`You weren't signed in to ${profile.name}.\n`);
		return EXIT.ok;
	}
	await io.credentials.delete(profile.name);
	try {
		const revoked = await postForm(io, `${profile.url}/oauth/revoke`, {
			token: stored.refreshToken,
			token_type_hint: "refresh_token",
			client_id: profile.clientId ?? "",
		});
		if (!revoked.ok) throw new CliError(EXIT.failed, String(revoked.body.error_description ?? revoked.status));
	} catch (error) {
		throw new CliError(
			error instanceof CliError ? error.code : EXIT.failed,
			`Forgot the sign-in to ${profile.name} here, but the Install couldn't revoke it (${error instanceof Error ? error.message : String(error)}). Revoke it in the admin: Your account › AI clients.`,
		);
	}
	io.stdout(`Signed out of ${profile.name}: the sign-in was revoked on the Install and forgotten here.\n`);
	return EXIT.ok;
}

async function profiles(context: RunContext, args: string[]): Promise<number> {
	const { io } = context;
	const file = await readProfiles(io.configDir);
	if (args[0] === "use") {
		const name = args[1];
		if (!name || args.length > 2) throw new CliError(EXIT.usage, "Usage: webcraft profiles use <name>");
		const chosen = chooseProfile(file, name);
		if (!chosen) throw new CliError(EXIT.usage, `There is no profile ${name}. See webcraft profiles.`);
		file.default = chosen.name;
		await writeProfiles(io.configDir, file);
		io.stdout(`Commands now use ${chosen.name} (${chosen.url}) unless --install says otherwise.\n`);
		return EXIT.ok;
	}
	if (args.length > 0) throw new CliError(EXIT.usage, PROFILES_HELP);
	const all = Object.values(file.profiles);
	if (context.options.json) {
		io.stdout(`${JSON.stringify({ default: file.default, profiles: all }, null, 2)}\n`);
		return EXIT.ok;
	}
	if (all.length === 0) {
		io.stdout("No profiles yet. Sign in with: webcraft login --install <the Install's admin address>\n");
		return EXIT.ok;
	}
	for (const profile of all) {
		const signed = (await io.credentials.get(profile.name))
			? `signed in as ${profile.signedIn?.person ?? "someone"}${profile.signedIn?.workspace ? ` (${profile.signedIn.workspace})` : ""}`
			: "signed out";
		io.stdout(`${profile.name === file.default ? "*" : " "} ${profile.name}  ${profile.url}  ${signed}\n`);
	}
	return EXIT.ok;
}
