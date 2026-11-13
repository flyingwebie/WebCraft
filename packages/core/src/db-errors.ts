/** Whether `error` is Postgres refusing a duplicate in the unique constraint `constraint`. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
	const cause = (error as { cause?: unknown })?.cause ?? error;
	const { code, constraint: name } = (cause ?? {}) as { code?: unknown; constraint?: unknown };
	return code === "23505" && name === constraint;
}

/**
 * Whether `error` is Postgres cancelling a transaction over a deadlock (`40P01`) or a serialization
 * failure (`40001`): never a sign the change itself was wrong, only that it ran into another
 * transaction and both can't go on. Safe to run again.
 */
export function isSerializationFailure(error: unknown): boolean {
	const cause = (error as { cause?: unknown })?.cause ?? error;
	const { code } = (cause ?? {}) as { code?: unknown };
	return code === "40P01" || code === "40001";
}
