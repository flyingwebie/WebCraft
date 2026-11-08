/** Whether `error` is Postgres refusing a duplicate in the unique constraint `constraint`. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
	const cause = (error as { cause?: unknown })?.cause ?? error;
	const { code, constraint: name } = (cause ?? {}) as { code?: unknown; constraint?: unknown };
	return code === "23505" && name === constraint;
}
