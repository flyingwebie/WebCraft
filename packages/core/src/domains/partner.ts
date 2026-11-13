/**
 * The domain offered with another, apex and `www` together: `www.bakery.ie` for `bakery.ie`, and
 * back; null for `www.` followed by a single label. It imports nothing, so the admin's browser code
 * offers the same pair the server adds (`@webcraft/core/domain-partner`).
 */
export function wwwPartnerOf(name: string): string | null {
	if (name.startsWith("www.")) {
		const apex = name.slice("www.".length);
		return apex.includes(".") ? apex : null;
	}
	return `www.${name}`;
}
