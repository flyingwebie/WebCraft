/**
 * The Content API's cursors: where a list stopped, for the next page. A cursor is opaque to
 * frontends and can't be changed by them: it is the position and a fingerprint of the query it
 * belongs to (its Post Type, filters, sort, search and languages), signed with HMAC-SHA256 under a key
 * derived from the Master key. One sent with another query, changed or made up is refused.
 */

/** Where a list stopped: after the item with this sort value (as text, null for none) and id; or, for search, how many came before. */
export type CursorPosition = { after: { value: string | null; id: string } } | { offset: number };

type Signed = { q: string; p: CursorPosition };

export type Cursors = {
	/** A cursor for the page after `position` of the query whose fingerprint is `query`. */
	make(query: string, position: CursorPosition): Promise<string>;
	/** The position a cursor holds, when it is one this Install made for this same query; else undefined. */
	read(query: string, cursor: string): Promise<CursorPosition | undefined>;
};

export function createCursors(key: CryptoKey): Cursors {
	const encoder = new TextEncoder();
	const sign = async (payload: string) =>
		Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)))
			.subarray(0, 18)
			.toString("base64url");
	return {
		async make(query, position) {
			const payload = Buffer.from(JSON.stringify({ q: query, p: position } satisfies Signed)).toString("base64url");
			return `${payload}.${await sign(payload)}`;
		},
		async read(query, cursor) {
			if (cursor.length > 2_000) return undefined;
			const [payload, signature, ...rest] = cursor.split(".");
			if (!payload || !signature || rest.length > 0) return undefined;
			const expected = await sign(payload);
			if (!timingSafeEqual(expected, signature)) return undefined;
			let signed: Signed;
			try {
				signed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Signed;
			} catch {
				return undefined;
			}
			if (signed.q !== query) return undefined;
			const position = signed.p as Record<string, unknown> | undefined;
			if (
				position &&
				typeof position.offset === "number" &&
				Number.isInteger(position.offset) &&
				position.offset >= 0
			) {
				return { offset: position.offset };
			}
			const after = position?.after as Record<string, unknown> | undefined;
			if (after && typeof after.id === "string" && (typeof after.value === "string" || after.value === null)) {
				return { after: { value: after.value, id: after.id } };
			}
			return undefined;
		},
	};
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** A query's fingerprint: what its cursors are bound to (the parts that decide which items, and in what order). */
export async function fingerprint(parts: unknown): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
	return Buffer.from(digest).subarray(0, 12).toString("base64url");
}
