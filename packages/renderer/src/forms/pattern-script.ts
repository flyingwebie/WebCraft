import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { SCRIPT_PATH } from "../design-system/theme-toggle.ts";

/**
 * RE2's own browser build, served from the Site as an ES module. Forms load it only when a field
 * has a pattern. The server uses the same package: neither side backtracks, and both give character
 * classes and Unicode the same meaning. Its licence notice remains in the served file.
 *
 * Resolve from this package's entry, rather than this file: the web bundle lives in dist/server,
 * while the renderer and its installed dependencies remain in their workspace directories.
 */
export const FORM_PATTERN_SCRIPT = (() => {
	const require = createRequire(import.meta.resolve("@webcraft/renderer/forms"));
	const source = readFileSync(join(dirname(require.resolve("re2js")), "index.umd.js"), "utf8");
	// Keep the UMD build's exports local, so loading it doesn't change any Site-script globals.
	const text = `const exports = {}; const module = { exports };\n${source}\nexport const RE2JS = exports.RE2JS;\n`;
	const name = `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text };
})();
