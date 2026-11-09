const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`, "i");

/**
 * Whether `value` has the shape of a UUID. Ids that can't be one are treated as not found, rather
 * than reaching the database as a type error.
 */
export function isUuid(value: string): boolean {
	return UUID.test(value);
}

/** Every UUID written in a piece of text, in order. */
export function uuidsIn(text: string): string[] {
	return [...text.matchAll(new RegExp(UUID_SOURCE, "gi"))].map((match) => match[0]);
}
