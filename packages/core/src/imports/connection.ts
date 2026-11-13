import { z } from "zod";

export const CONNECTION_LIFETIME = 30 * 86400_000;
const schema = z.object({
	revision: z.uuid(),
	address: z.url({ protocol: /^https$/ }).max(2000),
	includeHidden: z.boolean(),
	expiresAt: z.iso.datetime(),
});
export type ImportConnection = z.infer<typeof schema>;

/** Stored metadata (including from Site transfers) is projected before use or readback. */
export function connectionOf(value: unknown): ImportConnection | null {
	const result = schema.safeParse(value);
	if (!result.success) return null;
	const url = new URL(result.data.address);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname.includes("%") ||
		!url.pathname.endsWith("/")
	)
		return null;
	return result.data;
}
