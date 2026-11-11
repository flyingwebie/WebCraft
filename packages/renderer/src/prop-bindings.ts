/** Scoped data preserving a whole-Group/Repeater binding across declaration renames. */
import { type AttributePart, isValuePath } from "./tree.ts";

export type PropBinding = {
	root: string;
	paths: Record<string, string>;
	/** Deleted target Field identity -> original relative source path. */
	retained?: Record<string, string>;
	/** Target path -> source declaration identity when a source name is reused. */
	sources?: Record<string, string>;
	/** Target paths whose source declaration is absent, never aliases of a reused name. */
	missing?: string[];
};
export const BINDINGS_ATTRIBUTE = "data-wc-bindings";

/** Replace only a complete path prefix; the longest prefix wins. Never interpret expressions. */
export function mappedBindingPath(path: string, paths: Readonly<Record<string, string>>): string {
	const from = Object.keys(paths)
		.filter((key) => path === key || path.startsWith(`${key}.`))
		.sort((a, b) => b.length - a.length)[0];
	return from === undefined ? path : paths[from] + path.slice(from.length);
}

export function boundRoot(parts: readonly AttributePart[]): string | undefined {
	const [only] = parts;
	return parts.length === 1 && only?.type === "value" && !only.format ? only.path : undefined;
}

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const path = (value: unknown, length: number, depth: number): value is string =>
	typeof value === "string" && value.length <= length && value.split(".").length <= depth && isValuePath(value);

/** Shared by markup and stored-tree validation. An unchanged binding retains exactly these paths. */
export function readPropBinding(
	input: unknown,
	parts: readonly AttributePart[],
	allowed: readonly string[] | undefined,
): { binding?: PropBinding } | { problem: string } {
	if (input === undefined) return {};
	if (!allowed) return { problem: "Binding metadata is only for a Group or Repeater Prop." };
	const root = boundRoot(parts);
	if (!root) return { problem: "Binding metadata needs one unformatted bound value, not literal or joined text." };
	if (
		!object(input) ||
		Object.keys(input).some((key) => !["root", "paths", "retained", "sources", "missing"].includes(key))
	)
		return { problem: "Binding metadata is an object with root and paths." };
	if (!path(input.root, 512, 16))
		return { problem: "The binding root is a path of at most 512 characters and 16 names." };
	if (input.root !== root)
		return { problem: `Binding metadata belongs to ${input.root}, not ${root}. Remove it when replacing the binding.` };
	if (!object(input.paths) || Object.keys(input.paths).length > 256)
		return { problem: "Binding paths are an object with 1 to 256 relative paths." };
	const paths: Record<string, string> = {};
	for (const [target, source] of Object.entries(input.paths).sort(([a], [b]) => a.localeCompare(b))) {
		if (!path(target, 256, 8) || !path(source, 256, 8))
			return { problem: "Binding paths are relative names joined by dots, at most 256 characters and 8 names." };
		if (!allowed.includes(target)) return { problem: `This Prop has no nested Field ${target}.` };
		Object.defineProperty(paths, target, { value: source, enumerable: true, configurable: true, writable: true });
	}
	const metadata: Pick<PropBinding, "retained" | "sources" | "missing"> = {};
	for (const key of ["retained", "sources"] as const) {
		const values = input[key];
		if (values === undefined) continue;
		if (!object(values) || Object.keys(values).length > 256)
			return { problem: "Binding identities are maps of at most 256 Fields." };
		const checked: Record<string, string> = {};
		for (const [name, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
			const id = key === "retained" ? name : value;
			const relative = key === "retained" ? value : name;
			if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !path(relative, 256, 8))
				return { problem: "Binding identities need a declaration id and relative Field path." };
			if (key === "sources" && !allowed.includes(name)) return { problem: `This Prop has no nested Field ${name}.` };
			Object.defineProperty(checked, name, { value, enumerable: true, configurable: true, writable: true });
		}
		if (Object.keys(checked).length) metadata[key] = checked;
	}
	if (input.missing !== undefined) {
		if (
			!Array.isArray(input.missing) ||
			input.missing.length > 256 ||
			input.missing.some((p) => !path(p, 256, 8) || !allowed.includes(p)) ||
			new Set(input.missing).size !== input.missing.length
		)
			return { problem: "Missing binding sources are distinct target Field paths, at most 256." };
		if (input.missing.length) metadata.missing = [...input.missing].sort();
	}
	if (!Object.keys(paths).length && !Object.keys(metadata).length)
		return { problem: "Binding metadata needs paths or retained identities." };
	return { binding: { root, paths, ...metadata } };
}

/** JSON.parse alone would silently keep the last duplicate key. Metadata must never do that. */
export function readMetadataJson(text: string, maxLength = 131_072): unknown {
	if (text.length > maxLength) throw new Error(`Prop metadata is at most ${maxLength} characters.`);
	const value: unknown = JSON.parse(text);
	const stack: Set<string>[] = [];
	for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
		if (token[0] === "{") stack.push(new Set());
		else if (token[0] === "}") stack.pop();
		else if (/^\s*:/.test(text.slice((token.index ?? 0) + token[0].length))) {
			const key = JSON.parse(token[0]) as string;
			const keys = stack.at(-1);
			if (keys?.has(key)) throw new Error(`Prop metadata gives ${key} twice.`);
			keys?.add(key);
		}
	}
	return value;
}

export function readBindingsJson(text: string): Record<string, unknown> {
	const value = readMetadataJson(text);
	if (!object(value)) throw new Error("Binding metadata is an object keyed by Prop name.");
	if (Object.keys(value).length > 256) throw new Error("Binding metadata names at most 256 Props.");
	return value;
}
