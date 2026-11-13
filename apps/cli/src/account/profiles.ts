import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError, EXIT } from "../exit-codes.ts";
import type { CredentialPlace } from "./credentials.ts";
import { readKeptObject } from "./files.ts";

/**
 * A profile: one Install the CLI signs in to, named (its host unless chosen: `cms.agency.example`).
 * Profiles hold no secret: a sign-in's tokens are in the credential store (`credentials.ts`).
 */
export type Profile = {
	name: string;
	/** The Install's admin address: `https://cms.agency.example`. */
	url: string;
	/** The CLI's OAuth client on that Install (registered by `login`). */
	clientId?: string;
	/** Where its sign-in is kept, once signed in. */
	place?: CredentialPlace;
	/** Who signed in, and where, as `login` last saw it. */
	signedIn?: { person: string; workspace: string; at: string };
};

export type ProfilesFile = {
	/** The profile commands use unless told otherwise: the one signed in last. */
	default: string | null;
	profiles: Record<string, Profile>;
};

const FILE = "config.json";

export async function readProfiles(configDir: string): Promise<ProfilesFile> {
	const parsed: Partial<ProfilesFile> = (await readKeptObject(join(configDir, FILE))) ?? {};
	return {
		default: typeof parsed.default === "string" ? parsed.default : null,
		profiles: typeof parsed.profiles === "object" && parsed.profiles !== null ? parsed.profiles : {},
	};
}

export async function writeProfiles(configDir: string, file: ProfilesFile): Promise<void> {
	const path = join(configDir, FILE);
	const partial = `${path}.${crypto.randomUUID()}.partial`;
	await writeFile(partial, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
	await rename(partial, path);
}

/**
 * An Install's admin address as the CLI keeps it: its origin (`https://cms.agency.example`), from
 * what was typed (`cms.agency.example` means https).
 */
export function installUrl(given: string): string {
	const text = given.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new CliError(
			EXIT.usage,
			`${given} isn't an Install's address. Give its admin address, such as https://cms.agency.example.`,
		);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new CliError(EXIT.usage, `${given} isn't an Install's address: use https.`);
	}
	if (url.protocol === "http:" && !isLocal(url.hostname)) {
		throw new CliError(
			EXIT.usage,
			`${given} uses http, which would send your sign-in unencrypted. Use the Install's https address.`,
		);
	}
	return url.origin;
}

/** Hosts plain http is allowed for: this computer, for development. */
function isLocal(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"
	);
}

/** The profile `--install` (or `WEBCRAFT_INSTALL`) names, by name or by address, else the default one. */
export function chooseProfile(file: ProfilesFile, install: string | undefined): Profile | null {
	if (install) {
		const byName = file.profiles[install];
		if (byName) return byName;
		let url: string | null = null;
		try {
			url = installUrl(install);
		} catch {
			return null;
		}
		return Object.values(file.profiles).find((profile) => profile.url === url) ?? null;
	}
	return file.default ? (file.profiles[file.default] ?? null) : null;
}

/** A new profile's name: the Install's host, unless taken by another Install. */
export function profileNameFor(file: ProfilesFile, url: string): string {
	const host = new URL(url).host;
	const taken = file.profiles[host];
	return !taken || taken.url === url ? host : `${host}-${Object.keys(file.profiles).length + 1}`;
}
