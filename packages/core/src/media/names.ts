import { slugify } from "../content/slugs.ts";

/** Where a Site serves its Media, on its own domain (ADR 0026). */
export const MEDIA_PATH = "/_media/";

/** A served name: 16 hexadecimal characters of the content hash, then a readable name. */
export const SERVED_NAME = /^[0-9a-f]{16}-[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]{2,5}$/;

/**
 * The name a file is served under, `<hash>-<name>[-<width>].<extension>`: the start of its content
 * hash, so the name changes whenever the file does and caches can keep it forever, then the uploaded
 * name made readable (`Sourdough Loaf.JPG` gives `sourdough-loaf`).
 */
export function servedName(hash: string, fileName: string, extension: string, width?: number): string {
	const stem = fileName.replace(/\.[^.]*$/, "");
	const readable = slugify(stem).slice(0, 60).replace(/-+$/, "") || "file";
	return `${hash.slice(0, 16)}-${readable}${width ? `-${width}` : ""}.${extension}`;
}

/** The SHA-256 of a file, in hexadecimal. */
export async function contentHash(data: Uint8Array): Promise<string> {
	// Web Crypto reads bytes in a buffer of their own as they are; only shared memory is copied first,
	// so a large file isn't held twice while it is hashed.
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", inOwnBuffer(data) ? data : new Uint8Array(data)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inOwnBuffer(data: Uint8Array): data is Uint8Array<ArrayBuffer> {
	return data.buffer instanceof ArrayBuffer;
}
