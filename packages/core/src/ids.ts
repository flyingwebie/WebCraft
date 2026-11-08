const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` has the shape of a UUID. Ids that can't be one are treated as not found, rather
 * than reaching the database as a type error.
 */
export function isUuid(value: string): boolean {
	return UUID.test(value);
}
