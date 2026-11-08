/**
 * A date and time for the admin, in UTC, such as `2026-03-02 09:00 UTC`. The server renders pages
 * first, and its date formatting can differ from the browser's in small ways (spaces, AM/PM), which
 * would break the page; this form reads the same everywhere. Until people choose a time zone, the
 * admin shows UTC.
 */
export function formatUtc(value: Date | string): string {
	const date = new Date(value);
	const pad = (part: number) => String(part).padStart(2, "0");
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
