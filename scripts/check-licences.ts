// `bun run check:licences`: every installed dependency must carry a licence that is compatible with
// AGPL-3.0-or-later (ADR 0012), and every WebCraft workspace must itself be AGPL-3.0-or-later.
//
// Allow-list approach: a licence that isn't in ALLOWED fails the check until someone has reviewed
// it and added it here with a reason. Run `bun install` first; the check reads node_modules.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = realpathSync(new URL("..", import.meta.url).pathname);
const OUR_LICENCE = "AGPL-3.0-or-later";

/** SPDX ids whose terms let the code be combined into an AGPL-3.0-or-later work. */
const ALLOWED = new Set([
	// Permissive licences.
	"MIT",
	"MIT-0",
	"ISC",
	"0BSD",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"Apache-2.0",
	"Zlib",
	"BSL-1.0",
	"BlueOak-1.0.0",
	"Python-2.0",
	"Unicode-3.0",
	"Unicode-DFS-2016",
	"Artistic-2.0",
	// Public domain dedications.
	"Unlicense",
	"CC0-1.0",
	// Data packages (browser support tables and the like).
	"CC-BY-3.0",
	"CC-BY-4.0",
	// Fonts (ADR 0012: bundled fonts are OFL or similar).
	"OFL-1.1",
	// Weak copyleft.
	"MPL-2.0",
	"LGPL-2.1-only",
	"LGPL-2.1-or-later",
	"LGPL-3.0-only",
	"LGPL-3.0-or-later",
	// Copyleft that AGPL-3.0 can include. (GPL-2.0-only is not one of them.)
	"GPL-2.0-or-later",
	"GPL-3.0-only",
	"GPL-3.0-or-later",
	"AGPL-3.0-only",
	"AGPL-3.0-or-later",
]);

/**
 * Packages whose package.json gives no usable licence, checked by hand. Key: `name@version`;
 * value: the licence found and where. Keep it short: prefer a dependency that declares its licence.
 */
const REVIEWED: Record<string, string> = {};

/** Old SPDX ids that mean one of the current ones. */
const DEPRECATED_IDS: Record<string, string> = {
	"GPL-2.0": "GPL-2.0-only",
	"GPL-3.0": "GPL-3.0-only",
	"LGPL-2.1": "LGPL-2.1-only",
	"LGPL-3.0": "LGPL-3.0-only",
	"AGPL-3.0": "AGPL-3.0-only",
};

type Package = { name: string; version: string; licence: string | undefined; path: string };

const problems: string[] = [];

for (const workspace of ourWorkspaces()) {
	if (workspace.licence !== OUR_LICENCE) {
		problems.push(
			`${workspace.path}: our own package ${workspace.name} must be "${OUR_LICENCE}" (found ${workspace.licence ?? "none"})`,
		);
	}
}

const dependencies = installedPackages();
if (dependencies.length === 0) {
	problems.push("No installed dependencies found. Run `bun install` first.");
}
for (const dependency of dependencies) {
	const id = `${dependency.name}@${dependency.version}`;
	if (REVIEWED[id]) continue;
	if (!dependency.licence) {
		problems.push(`${id} (${dependency.path}): declares no licence`);
		continue;
	}
	let allowed: boolean;
	try {
		allowed = isAllowed(dependency.licence);
	} catch (error) {
		problems.push(`${id}: can't read its licence "${dependency.licence}": ${(error as Error).message}`);
		continue;
	}
	if (!allowed) {
		problems.push(`${id}: "${dependency.licence}" isn't on the allow-list of AGPL-compatible licences`);
	}
}

if (problems.length > 0) {
	console.error(`Licence check failed (${problems.length}):\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
	console.error(
		"\nReplace the dependency, or, after checking the licence is AGPL-compatible, add it to scripts/check-licences.ts.",
	);
	process.exit(1);
}
console.log(`Licence check passed: ${dependencies.length} dependencies, all AGPL-compatible.`);

/** The root package and every workspace: they are WebCraft's own code. */
function ourWorkspaces(): Package[] {
	const manifests = ["package.json"];
	for (const folder of ["apps", "packages"]) {
		for (const entry of readdirSync(join(ROOT, folder), { withFileTypes: true })) {
			if (entry.isDirectory()) manifests.push(join(folder, entry.name, "package.json"));
		}
	}
	manifests.push(join("tests", "package.json"));
	return manifests
		.filter((manifest) => existsSync(join(ROOT, manifest)))
		.map((manifest) => readPackage(join(ROOT, manifest)));
}

/** Every third-party package under node_modules, once each, in both the isolated and hoisted layouts. */
function installedPackages(): Package[] {
	const found = new Map<string, Package>();
	const visit = (nodeModules: string) => {
		if (!existsSync(nodeModules)) return;
		for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
			if (entry.name === ".bun") {
				// Bun's isolated store: node_modules/.bun/<name@version>/node_modules/<name>
				for (const store of readdirSync(join(nodeModules, ".bun")))
					visit(join(nodeModules, ".bun", store, "node_modules"));
				continue;
			}
			if (entry.name.startsWith(".")) continue;
			const folders = entry.name.startsWith("@")
				? readdirSync(join(nodeModules, entry.name)).map((name) => join(nodeModules, entry.name, name))
				: [join(nodeModules, entry.name)];
			for (const folder of folders) {
				let real: string;
				try {
					real = realpathSync(folder);
				} catch {
					continue;
				}
				// Links to our own workspaces resolve outside node_modules; those are checked above.
				if (found.has(real) || !real.includes(`${sep}node_modules${sep}`)) continue;
				const manifest = join(real, "package.json");
				if (!existsSync(manifest)) continue;
				found.set(real, readPackage(manifest));
				visit(join(real, "node_modules"));
			}
		}
	};
	visit(join(ROOT, "node_modules"));
	return [...found.values()];
}

function readPackage(manifest: string): Package {
	const data = JSON.parse(readFileSync(manifest, "utf8"));
	let licence: string | undefined;
	if (typeof data.license === "string") licence = data.license;
	else if (typeof data.license?.type === "string") licence = data.license.type;
	else if (Array.isArray(data.licenses)) {
		licence = data.licenses
			.map((entry: { type?: string } | string) => (typeof entry === "string" ? entry : entry.type))
			.join(" OR ");
	}
	return { name: data.name, version: data.version, licence, path: relative(ROOT, manifest) };
}

/** Evaluates an SPDX licence expression: `OR` needs one allowed side, `AND` needs both. */
function isAllowed(expression: string): boolean {
	const tokens = expression.replace(/[()]/g, " $& ").trim().split(/\s+/);
	let position = 0;
	const peek = () => tokens[position];
	const take = () => {
		const token = tokens[position++];
		if (token === undefined) throw new Error("the expression ends too early");
		return token;
	};
	const anyOf = (): boolean => {
		let result = allOf();
		while (peek()?.toUpperCase() === "OR") {
			take();
			result = allOf() || result;
		}
		return result;
	};
	const allOf = (): boolean => {
		let result = single();
		while (peek()?.toUpperCase() === "AND") {
			take();
			result = single() && result;
		}
		return result;
	};
	const single = (): boolean => {
		const token = take();
		if (token === "(") {
			const result = anyOf();
			if (take() !== ")") throw new Error("a bracket is not closed");
			return result;
		}
		// An exception (`WITH ...`) only adds permissions, so the licence it modifies decides.
		if (peek()?.toUpperCase() === "WITH") {
			take();
			take();
		}
		const id = token.endsWith("+") ? `${token.slice(0, -1)}-or-later` : token;
		return ALLOWED.has(DEPRECATED_IDS[id] ?? id);
	};
	const result = anyOf();
	if (position !== tokens.length) throw new Error(`unexpected "${peek()}"`);
	return result;
}
