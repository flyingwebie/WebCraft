/**
 * A number of bytes as people read it in an email, in binary units: `840 B`, `850 KB`, `1 MB`,
 * `4.2 GB`, with one decimal at most and `decimal` as the decimal mark.
 */
export function formatSize(bytes: number, decimal: "." | ","): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const rounded = Math.round(value * 10) / 10;
	return `${String(rounded).replace(".", decimal)} ${units[unit]}`;
}
