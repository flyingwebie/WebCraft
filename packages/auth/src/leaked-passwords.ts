import type { PasswordCheck } from "./passwords.ts";

/**
 * The range service the check asks: given the first 5 characters of a password's SHA-1 hash, it
 * answers every leaked hash starting with them (the rest of each hash and how often it was seen).
 * The password, and the rest of its hash, never leave the server.
 */
export const LEAKED_PASSWORD_RANGE_URL = "https://api.pwnedpasswords.com/range/";

/** How long the check waits for the range service before accepting the password without it. */
const LOOKUP_TIMEOUT_MS = 5000;

export type LeakedPasswordCheckOptions = {
	/** Outgoing HTTP (`services.http`): tests answer it with a fake. */
	http: (request: Request) => Promise<Response>;
	log: { warn(msg: string, fields?: Record<string, unknown>): void };
	/** Whether the check is on: the Superadmin can switch it off (Install settings › Security). */
	enabled(): Promise<boolean>;
};

/**
 * The leaked-password check on new passwords, by partial-hash (k-anonymity) lookup: it sends only
 * the first 5 characters of the password's SHA-1 hash, asks for padded answers so their size says
 * nothing either, and refuses the password (`leaked`) when the answer lists the rest of its hash.
 *
 * It fails open: when the service can't be reached or answers with an error, the password is
 * accepted and a warning is logged, so an offline Install or an outage never stops people from
 * choosing a password. The Superadmin can switch it off for Installs that are always offline.
 */
export function leakedPasswordCheck({ http, log, enabled }: LeakedPasswordCheckOptions): PasswordCheck {
	return async (password) => {
		if (!(await enabled())) return null;
		const hash = await sha1Hex(password);
		const prefix = hash.slice(0, 5);
		const suffix = hash.slice(5);
		let listing: string;
		try {
			const response = await http(
				new Request(`${LEAKED_PASSWORD_RANGE_URL}${prefix}`, {
					headers: { "add-padding": "true", "user-agent": "WebCraft" },
					signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
				}),
			);
			if (!response.ok) {
				log.warn("The leaked-password lookup failed, so the password was accepted without it", {
					status: response.status,
				});
				return null;
			}
			listing = await response.text();
		} catch (error) {
			log.warn("The leaked-password lookup failed, so the password was accepted without it", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		return isListed(listing, suffix) ? "leaked" : null;
	};
}

/** Whether the range answer lists `suffix` as seen at least once (padding lines say 0). */
function isListed(listing: string, suffix: string): boolean {
	for (const line of listing.split("\n")) {
		const [candidate = "", count = "0"] = line.trim().split(":");
		if (candidate.toUpperCase() === suffix && Number.parseInt(count, 10) > 0) return true;
	}
	return false;
}

async function sha1Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}
