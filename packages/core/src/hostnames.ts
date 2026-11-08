/**
 * Puts a hostname in the one form WebCraft compares hostnames in: lower case and without the
 * trailing dot of a fully qualified name, so `Admin.Example.com.` and `admin.example.com` match.
 */
export function normaliseHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.$/, "");
}
