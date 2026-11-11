/**
 * The slug the New Site dialog and the setup wizard's first client step suggest from a Site's name,
 * until the person changes it: "Acme Bakery" → "acme-bakery". The server checks it (`checkSlug`).
 */
export function slugFrom(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, "");
}
