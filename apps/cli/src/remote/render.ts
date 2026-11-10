/**
 * An answer as people read it: nested keys and lists, one value per line, indented, without JSON's
 * punctuation. `--json` prints the answer as it came instead.
 *
 *     sites:
 *       - id: 0b6c…
 *         name: Bakery
 *         languages: en, fr
 */
export function renderHuman(value: unknown): string {
	const lines: string[] = [];
	write(value, 0, lines);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const INDENT = "  ";

function write(value: unknown, depth: number, lines: string[]): void {
	const pad = INDENT.repeat(depth);
	if (Array.isArray(value)) {
		if (value.length === 0) {
			lines.push(`${pad}(none)`);
			return;
		}
		if (value.every(isScalar)) {
			lines.push(`${pad}${value.map(scalar).join(", ")}`);
			return;
		}
		for (const item of value) {
			if (isScalar(item)) {
				lines.push(`${pad}- ${scalar(item)}`);
				continue;
			}
			const nested: string[] = [];
			write(item, depth + 1, nested);
			const [first = "", ...rest] = nested;
			lines.push(`${pad}- ${first.slice(pad.length + INDENT.length)}`, ...rest);
		}
		return;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value).filter(([, each]) => each !== undefined);
		if (entries.length === 0) {
			lines.push(`${pad}(empty)`);
			return;
		}
		for (const [key, each] of entries) {
			if (isScalar(each)) lines.push(`${pad}${key}: ${scalar(each)}`);
			else if (Array.isArray(each) && (each.length === 0 || each.every(isScalar))) {
				lines.push(`${pad}${key}: ${each.length === 0 ? "(none)" : each.map(scalar).join(", ")}`);
			} else if (isRecord(each) && Object.keys(each).length === 0) lines.push(`${pad}${key}: (empty)`);
			else {
				lines.push(`${pad}${key}:`);
				write(each, depth + 1, lines);
			}
		}
		return;
	}
	lines.push(`${pad}${scalar(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
	return value === null || typeof value !== "object";
}

function scalar(value: unknown): string {
	if (value === null) return "—";
	if (typeof value === "string") {
		if (value === "") return '""';
		// Several lines (markup, CSS) start on their own line, indented the same as the rest.
		return value.includes("\n") ? `|\n${value}` : value;
	}
	return String(value);
}
