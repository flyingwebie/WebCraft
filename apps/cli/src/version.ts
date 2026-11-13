import { VERSION_HEADER } from "@webcraft/core/version";

import webcraftPackage from "../../../package.json" with { type: "json" };

/**
 * This `webcraft`'s version: WebCraft's own (the root `package.json`, which a release sets), so the
 * CLI and the Install it talks to compare the same numbers.
 */
export const CLI_VERSION: string = webcraftPackage.version;

/** The version of the `webcraft` running with `io`. */
export function cliVersion(io: { version?: string }): string {
	return io.version ?? CLI_VERSION;
}

/**
 * The header every answer of `/api/v1` to a signed-in client carries: the Install's WebCraft
 * version. From `@webcraft/core`'s own tiny, dependency-free entry point, so the compiled CLI's
 * remote side reads it without pulling in the rest of `@webcraft/core` (the server commands'
 * code stays out: see `compiled.test.ts`).
 */
export { VERSION_HEADER };

/**
 * Whether semantic version `a` is older than `b` (`0.1.0` < `0.2.0` < `1.0.0`; a pre-release sorts
 * before its release). A version that isn't semver is never older.
 */
export function olderThan(a: string, b: string): boolean {
	const parse = (version: string) => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
		if (!match) return null;
		return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
	};
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return false;
	for (let index = 0; index < 3; index++) {
		const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
		if (difference !== 0) return difference < 0;
	}
	if (left.pre === right.pre) return false;
	if (left.pre === null) return false;
	if (right.pre === null) return true;
	const leftParts = left.pre.split(".");
	const rightParts = right.pre.split(".");
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const x = leftParts[index];
		const y = rightParts[index];
		if (x === undefined) return true;
		if (y === undefined) return false;
		if (x === y) continue;
		const numbers = /^\d+$/.test(x) && /^\d+$/.test(y);
		if (numbers) return Number(x) < Number(y);
		if (/^\d+$/.test(x)) return true;
		if (/^\d+$/.test(y)) return false;
		return x < y;
	}
	return false;
}
