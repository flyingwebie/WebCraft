/**
 * Every id a Site export holds is replaced on import, so the new Site shares none with the Site it
 * came from (which may live on the same Install) and nothing else of the Install's is named by
 * accident. Ids are UUIDs, and they are named everywhere: in columns, in element trees, in Template
 * markup (`media:<id>`), in Relationships, Loop and Filter definitions, Module data, storage keys
 * (`<workspace id>/<site id>/media/…`) and secret names (`webhook:<id>:signing`).
 *
 * So the import replaces every UUID written anywhere in the archive's text, with one rule: the same
 * old id always becomes the same new one. A new id is the old one XOR a random mask made for the
 * import (keeping the version and variant bits), which needs no table of ids however large the Site
 * (analytics events alone can be millions), is one-to-one, and can't fall on an id the Install
 * already has but by the chance two random UUIDs share. A few ids are mapped by name instead: the
 * Workspace's (the one imported into) and people's (to the accounts matched by email).
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export type IdMap = {
	/** The new id of one old id. */
	id(old: string): string;
	/** `text` with every UUID in it replaced. */
	text(text: string): string;
	/** The mask, as hexadecimal, so a job that stops can go on with the same ids (it isn't secret). */
	readonly mask: string;
};

/** A random mask with the version and variant bits clear, so a new id keeps its version (4) and variant. */
export function newMask(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] ?? 0) & 0x0f;
	bytes[8] = (bytes[8] ?? 0) & 0x3f;
	// A mask of zeroes would keep every id.
	if (bytes.every((byte) => byte === 0)) bytes[15] = 1;
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function idMap(mask: string, fixed: ReadonlyMap<string, string>): IdMap {
	const maskBytes = Array.from({ length: 16 }, (_, index) => Number.parseInt(mask.slice(index * 2, index * 2 + 2), 16));
	const named = new Map([...fixed].map(([from, to]) => [from.toLowerCase(), to.toLowerCase()]));
	const id = (old: string): string => {
		const lower = old.toLowerCase();
		const known = named.get(lower);
		if (known) return known;
		const hex = lower.replaceAll("-", "");
		let out = "";
		for (let index = 0; index < 16; index++) {
			const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) ^ (maskBytes[index] ?? 0);
			out += byte.toString(16).padStart(2, "0");
		}
		return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
	};
	return { id, text: (text) => text.replace(UUID, id), mask };
}

/** Every UUID written in `text`, in lower case. */
export function uuidsWritten(text: string): string[] {
	return [...text.matchAll(UUID)].map((match) => match[0].toLowerCase());
}
