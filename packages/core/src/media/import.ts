import { type GuardedFetch, GuardedFetchError, type GuardedFetchProblem } from "../guarded-fetch.ts";

/** How long Import from URL waits for a whole file: the most the guarded fetcher allows. */
export const MEDIA_IMPORT_TIMEOUT_MS = 30_000;

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

/** A file fetched for Import from URL: its bytes, the name it goes by, and the host it came from. */
export type ImportedFile = { data: Uint8Array; fileName: string; host: string };

/**
 * Fetches a file a person named by its address, through the guarded fetcher: any host on the public
 * internet, each connection pinned to the address checked, at most 3 redirects (each checked again),
 * within `timeoutMs` and at most `maxBytes`. Its name comes from the server's `Content-Disposition`,
 * else the last part of the address it finally came from.
 */
export async function fetchForImport(
	fetch: GuardedFetch,
	address: string,
	limits: { maxBytes: number; timeoutMs: number },
): Promise<ImportedFile> {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new MediaImportRefusedError("scheme", "That isn't an http or https address.");
	}
	let response: Response;
	try {
		response = await fetch(new Request(url.toString(), { headers: { accept: "*/*" } }), {
			allowedHosts: "any",
			maxBytes: limits.maxBytes,
			timeoutMs: limits.timeoutMs,
		});
	} catch (error) {
		if (error instanceof GuardedFetchError) throw new MediaImportRefusedError(error.problem, error.message);
		throw error;
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
