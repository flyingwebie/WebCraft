import { type GuardedFetch, GuardedFetchError, type GuardedFetchProblem } from "../guarded-fetch.ts";
import type { Logger } from "../log.ts";
import type { RateLimitRule } from "../rate-limits.ts";

/** How long Import from URL waits for a whole file: the most the guarded fetcher allows. */
export const MEDIA_IMPORT_TIMEOUT_MS = 30_000;

/**
 * How many Imports from URL a person, and a Site, may start within the time one import can take.
 * Each holds its whole file in the web process's memory while it is fetched, so these bound how many
 * files are held at once: at most twice the limit, for imports started either side of a window's end.
 */
export const MEDIA_IMPORT_LIMITS = {
	person: { limit: 5, windowMs: MEDIA_IMPORT_TIMEOUT_MS },
	site: { limit: 15, windowMs: MEDIA_IMPORT_TIMEOUT_MS },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Import from URL refused the address or what it answered: one of the guarded fetcher's problems
 * (`scheme`, `host`, `address`, `redirects`, `timeout`, `size`, `unreachable`), or `status` (the
 * server answered with an error, `status`).
 */
export class MediaImportRefusedError extends Error {
	override name = "MediaImportRefusedError";
	readonly problem: GuardedFetchProblem | "status";
	readonly status: number | undefined;
	constructor(problem: GuardedFetchProblem | "status", message: string, status?: number) {
		super(message);
		this.problem = problem;
		this.status = status;
	}
}

/**
 * What Import from URL answers for each of the guarded fetcher's problems: one fixed sentence, naming
 * no host, address or limit. The fetcher's own words say which address a host resolves to, which
 * would map the server's network for whoever asks; they go to the log only.
 */
const REFUSALS: Record<GuardedFetchProblem, string> = {
	scheme: "Only http and https addresses without credentials can be imported.",
	host: "Files can't be fetched from that host.",
	address: "Files are only fetched from addresses on the public internet.",
	redirects: "The address redirected too many times.",
	timeout: "The server took too long to send the file.",
	size: "The file is larger than the largest file this Install takes.",
	unreachable: "The server didn't answer.",
};

/** A file fetched for Import from URL: its bytes, the name it goes by, and the host it came from. */
export type ImportedFile = { data: Uint8Array; fileName: string; host: string };

/**
 * Fetches a file a person named by its address, through the guarded fetcher: any host on the public
 * internet, each connection pinned to the address checked, at most 3 redirects (each checked again),
 * within `timeoutMs` and at most `maxBytes`. Its name comes from the server's `Content-Disposition`,
 * else the last part of the address it finally came from. A refusal is logged with the fetcher's
 * reason and answered with `REFUSALS`' sentence for its problem.
 */
export async function fetchForImport(
	fetch: GuardedFetch,
	address: string,
	limits: { maxBytes: number; timeoutMs: number },
	log: Logger,
): Promise<ImportedFile> {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new MediaImportRefusedError("scheme", REFUSALS.scheme);
	}
	let response: Response;
	try {
		response = await fetch(new Request(url.toString(), { headers: { accept: "*/*" } }), {
			allowedHosts: "any",
			maxBytes: limits.maxBytes,
			timeoutMs: limits.timeoutMs,
		});
	} catch (error) {
		if (!(error instanceof GuardedFetchError)) throw error;
		log.warn("Import from URL was refused", { host: url.hostname, problem: error.problem, reason: error.message });
		throw new MediaImportRefusedError(error.problem, REFUSALS[error.problem]);
	}
	if (!response.ok) {
		throw new MediaImportRefusedError("status", `The server answered ${response.status}.`, response.status);
	}
	const finalUrl = new URL(response.url || url.toString());
	return {
		data: new Uint8Array(await response.arrayBuffer()),
		fileName: dispositionName(response.headers.get("content-disposition")) ?? lastPart(finalUrl) ?? "download",
		host: url.hostname.toLowerCase(),
	};
}

/** The file name a `Content-Disposition` header gives (`filename*=UTF-8''…` first), if any. */
function dispositionName(header: string | null): string | null {
	if (!header) return null;
	const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
	if (extended) {
		try {
			return decodeURIComponent(extended.trim());
		} catch {
			// Read the plain one instead.
		}
	}
	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(header);
	return (plain?.[1] ?? plain?.[2] ?? "").trim() || null;
}

/** The last part of an address's path, decoded (`Sourdough%20Loaf.jpg` gives `Sourdough Loaf.jpg`). */
function lastPart(url: URL): string | null {
	const part = url.pathname.split("/").filter(Boolean).at(-1);
	if (!part) return null;
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}
