/** Scoped data preserving a whole-Group/Repeater binding across declaration renames. */
import { type AttributePart, isValuePath } from "./tree.ts";

export type PropBinding = { root: string; paths: Record<string, string> };
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
	if (!object(input) || Object.keys(input).some((key) => key !== "root" && key !== "paths"))
		return { problem: "Binding metadata is an object with root and paths." };
	if (!path(input.root, 512, 16))
		return { problem: "The binding root is a path of at most 512 characters and 16 names." };
	if (input.root !== root)
		return { problem: `Binding metadata belongs to ${input.root}, not ${root}. Remove it when replacing the binding.` };
	if (!object(input.paths) || Object.keys(input.paths).length === 0 || Object.keys(input.paths).length > 256)
		return { problem: "Binding paths are an object with 1 to 256 relative paths." };
	const paths: Record<string, string> = {};
	for (const [target, source] of Object.entries(input.paths).sort(([a], [b]) => a.localeCompare(b))) {
		if (!path(target, 256, 8) || !path(source, 256, 8))
			return { problem: "Binding paths are relative names joined by dots, at most 256 characters and 8 names." };
		if (!allowed.includes(target)) return { problem: `This Prop has no nested Field ${target}.` };
		Object.defineProperty(paths, target, { value: source, enumerable: true, configurable: true, writable: true });
	}
	return { binding: { root, paths } };
}

/** JSON.parse alone would silently keep the last duplicate key. Metadata must never do that. */
export function readBindingsJson(text: string): Record<string, unknown> {
	if (text.length > 131_072) throw new Error("Binding metadata is at most 128 KiB.");
	const value: unknown = JSON.parse(text);
	if (!object(value)) throw new Error("Binding metadata is an object keyed by Prop name.");
	const stack: Set<string>[] = [];
	for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
		if (token[0] === "{") stack.push(new Set());
		else if (token[0] === "}") stack.pop();
		else if (/^\s*:/.test(text.slice((token.index ?? 0) + token[0].length))) {
			const key = JSON.parse(token[0]) as string;
			const keys = stack.at(-1);
			if (keys?.has(key)) throw new Error(`Binding metadata gives ${key} twice.`);
			keys?.add(key);
		}
	}
	if (Object.keys(value).length > 256) throw new Error("Binding metadata names at most 256 Props.");
	return value;
}
