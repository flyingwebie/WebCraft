/** The same scoped identity is accepted in declarations, retained values and binding metadata. */
export function isPropDeclarationId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/.test(value);
}
