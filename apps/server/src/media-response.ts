import type { ByteRange, StoredMediaFile } from "@webcraft/core";

/**
 * Answers a request for a stored Media file: its type, a strong ETag (its content hash, so `304`
 * while it holds), one byte range (`206`, which video players need), and `nosniff` so browsers never
 * read it as anything else. `headers` adds the caller's own, such as caching.
 */
export async function mediaFileResponse(
	request: Request,
	file: StoredMediaFile,
	headers: Record<string, string>,
): Promise<Response | null> {
	const common: Record<string, string> = {
		"content-type": file.contentType,
		etag: file.etag,
		"accept-ranges": "bytes",
		"x-content-type-options": "nosniff",
		...headers,
	};
	if (matchesETag(request.headers.get("if-none-match"), file.etag)) {
		return new Response(null, { status: 304, headers: common });
	}
	const ifRange = request.headers.get("if-range");
	const range = ifRange && ifRange !== file.etag ? undefined : readRange(request.headers.get("range"), file.size);
	if (range === "unsatisfiable") {
		return new Response(null, { status: 416, headers: { ...common, "content-range": `bytes */${file.size}` } });
	}
	const body = await file.open(range);
	if (!body) return null;
	if (range) {
		return new Response(body, {
			status: 206,
			headers: {
				...common,
				"content-length": String(range.end - range.start + 1),
				"content-range": `bytes ${range.start}-${range.end}/${file.size}`,
			},
		});
	}
	return new Response(body, { status: 200, headers: { ...common, "content-length": String(file.size) } });
}

/**
 * One byte range from a `Range` header: `bytes=0-99`, `bytes=100-` or `bytes=-100` (the last 100).
 * Undefined to send the whole file (no header, several ranges, or one that isn't understood);
 * `unsatisfiable` for a range that starts past the end.
 */
function readRange(header: string | null, size: number): ByteRange | "unsatisfiable" | undefined {
	const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
	if (!match) return undefined;
	const [, first = "", last = ""] = match;
	if (first === "" && last === "") return undefined;
	if (first === "") {
		const length = Number(last);
		if (length === 0) return "unsatisfiable";
		return { start: Math.max(size - length, 0), end: size - 1 };
	}
	const start = Number(first);
	if (start >= size) return "unsatisfiable";
	const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
	return end < start ? undefined : { start, end };
}

/** Whether an `If-None-Match` header names the ETag (weak comparison, as for GET and HEAD). */
export function matchesETag(header: string | null, etag: string): boolean {
	if (!header) return false;
	const plain = (tag: string) => tag.trim().replace(/^W\//, "");
	return header.split(",").some((tag) => tag.trim() === "*" || plain(tag) === plain(etag));
}
