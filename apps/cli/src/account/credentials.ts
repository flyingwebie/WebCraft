import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What a device sign-in keeps: the grant's tokens. Never shown, never in the profiles file. */
export type StoredSignIn = {
	accessToken: string;
	/** When the access token stops working (ISO). */
	accessExpiresAt: string;
	refreshToken: string;
};

/** Where a sign-in is kept: the system's keychain, or a file only its owner can read. */
export type CredentialPlace = "keychain" | "file";

/**
 * Keeps sign-ins safe: in the system's own credential store where there is one (the macOS
 * Keychain, the Secret Service on Linux, the Windows Credential Manager), else in
 * `credentials.json` in the config folder, readable only by its owner (mode 600).
 */
export type CredentialStore = {
	get(profile: string): Promise<StoredSignIn | null>;
	/** Keeps a sign-in, answering where it went. */
	set(profile: string, signIn: StoredSignIn): Promise<CredentialPlace>;
	delete(profile: string): Promise<void>;
	/** The file used without a keychain. */
	readonly file: string;
};

const SERVICE = "webcraft";

/**
 * The credential store for a config folder. `keychain` tries the system's store first and falls back
 * to the file when it can't be used (a server without a Secret Service, for one); `file` uses the
 * file only (`WEBCRAFT_CREDENTIALS=file`).
 */
export function credentialStore(configDir: string, prefer: CredentialPlace): CredentialStore {
	const file = join(configDir, "credentials.json");

	const readFileStore = async (): Promise<Record<string, StoredSignIn>> => {
		try {
			const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
			return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, StoredSignIn>) : {};
		} catch {
			return {};
		}
	};
	const writeFileStore = async (entries: Record<string, StoredSignIn>) => {
		if (Object.keys(entries).length === 0) {
			await rm(file, { force: true });
			return;
		}
		// Written beside it with owner-only permissions, then renamed: never readable by others, never half written.
		const partial = `${file}.${crypto.randomUUID()}.partial`;
		await writeFile(partial, `${JSON.stringify(entries, null, "\t")}\n`, { mode: 0o600 });
		await chmod(partial, 0o600);
		await rename(partial, file);
	};

	const keychain = prefer === "keychain" ? systemKeychain() : null;

	return {
		file,
		async get(profile) {
			if (keychain) {
				const stored = await keychain.get(profile).catch(() => null);
				if (stored) return parseSignIn(stored);
			}
			return (await readFileStore())[profile] ?? null;
		},
		async set(profile, signIn) {
			if (
				keychain &&
				(await keychain.set(profile, JSON.stringify(signIn)).then(
					() => true,
					() => false,
				))
			) {
				// A sign-in kept in the file before is not left behind.
				const entries = await readFileStore();
				if (profile in entries) {
					delete entries[profile];
					await writeFileStore(entries);
				}
				return "keychain";
			}
			const entries = await readFileStore();
			entries[profile] = signIn;
			await writeFileStore(entries);
			return "file";
		},
		async delete(profile) {
			if (keychain) await keychain.delete(profile).catch(() => undefined);
			const entries = await readFileStore();
			if (profile in entries) {
				delete entries[profile];
				await writeFileStore(entries);
			}
		},
	};
}

function parseSignIn(text: string): StoredSignIn | null {
	try {
		const value = JSON.parse(text) as Partial<StoredSignIn>;
		if (typeof value.accessToken !== "string" || typeof value.refreshToken !== "string") return null;
		return {
			accessToken: value.accessToken,
			refreshToken: value.refreshToken,
			accessExpiresAt: typeof value.accessExpiresAt === "string" ? value.accessExpiresAt : new Date(0).toISOString(),
		};
	} catch {
		return null;
	}
}

/** The system's credential store, through Bun's `secrets`. */
function systemKeychain() {
	const secrets = (globalThis as { Bun?: { secrets?: typeof Bun.secrets } }).Bun?.secrets;
	if (!secrets) return null;
	return {
		get: (name: string) => secrets.get({ service: SERVICE, name }),
		set: (name: string, value: string) => secrets.set({ service: SERVICE, name, value }),
		delete: (name: string) => secrets.delete({ service: SERVICE, name }),
	};
}
