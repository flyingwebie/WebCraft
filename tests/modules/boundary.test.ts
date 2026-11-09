// The Module boundary (ADR 0024): a Module imports nothing from WebCraft but @webcraft/module-sdk,
// and nothing that reaches the database, the server or the network around it. Biome refuses such
// imports as they are typed; this checks every Module in the repo, whatever the editor did.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SDK_VERSION } from "@webcraft/module-sdk";

const ROOT = resolve(import.meta.dir, "../..");

/** Every Module in the repo: the first-party ones under modules/, and the test suite's sample. */
function moduleFolders(): string[] {
	const firstParty = existsSync(join(ROOT, "modules"))
		? readdirSync(join(ROOT, "modules"), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(ROOT, "modules", entry.name))
		: [];
	return [...firstParty, join(ROOT, "tests/modules/sample")];
}

function sourceFiles(folder: string): string[] {
	return readdirSync(folder, { recursive: true, encoding: "utf8" })
		.filter((name) => !name.split(/[\\/]/).includes("node_modules") && /\.(?:[cm]?[jt]sx?)$/.test(name))
		.map((name) => join(folder, name))
		.filter((path) => statSync(path).isFile());
}

/** Every module specifier a file imports, exports from or requires. */
function specifiersIn(source: string): string[] {
	const found = [
		...source.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g),
		...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
		...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
	];
	return found.map((match) => match[1] ?? "");
}

/** Packages that would let a Module go around the SDK. */
const FORBIDDEN =
	/^(?:@webcraft\/(?!module-sdk(?:$|\/))|drizzle-orm(?:$|\/)|zod(?:$|\/)|pg(?:$|\/)|pg-boss(?:$|\/)|node:|bun(?:$|:)|(?:fs|net|http|https|child_process|dns|os|worker_threads|vm)(?:$|\/))/;

/** Globals that would let a Module go around its context: the network, the environment, the runtime. */
const FORBIDDEN_GLOBALS =
	/(?<![\w.$])(?:(?:globalThis|global|process|Bun)\s*[.[]|(?:fetch|require)\s*\(|new\s+(?:XMLHttpRequest|WebSocket)\b)/;

/** Source without its comments, so a comment naming `fetch(` isn't a use of it. */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("every Module", () => {
	const folders = moduleFolders();

	test("imports nothing from WebCraft but the Module SDK, and nothing around it", () => {
		const problems: string[] = [];
		for (const folder of folders) {
			for (const file of sourceFiles(folder)) {
				for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
					const where = relative(ROOT, file);
					if (specifier.startsWith(".")) {
						const target = resolve(dirname(file), specifier);
						if (!target.startsWith(`${folder}/`)) problems.push(`${where} reaches outside its Module: ${specifier}`);
					} else if (FORBIDDEN.test(specifier)) {
						problems.push(`${where} imports ${specifier}`);
					}
				}
			}
		}
		expect(problems).toEqual([]);
	});

	test("uses no global that reaches around its context", () => {
		const problems: string[] = [];
		for (const folder of folders) {
			for (const file of sourceFiles(folder)) {
				const lines = withoutComments(readFileSync(file, "utf8")).split("\n");
				for (const [index, line] of lines.entries()) {
					if (FORBIDDEN_GLOBALS.test(line)) problems.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	test("depends on nothing of WebCraft's but the Module SDK", () => {
		const problems: string[] = [];
		for (const folder of folders) {
			const manifest = join(folder, "package.json");
			if (!existsSync(manifest)) continue;
			const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
			for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
				for (const name of Object.keys(pkg[field] ?? {})) {
					if (FORBIDDEN.test(name)) problems.push(`${relative(ROOT, manifest)} ${field}: ${name}`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	test("finds the sample Module, so a broken scan can't pass by finding nothing", () => {
		expect(folders.some((folder) => sourceFiles(folder).length > 0)).toBe(true);
	});
});

describe("the Module SDK package", () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, "packages/module-sdk/package.json"), "utf8")) as {
		version: string;
		exports: Record<string, string>;
		dependencies: Record<string, string>;
	};

	test("offers one entry point, so Modules can't reach its files", () => {
		expect(Object.keys(pkg.exports)).toEqual(["."]);
	});

	test("depends on nothing else of WebCraft's", () => {
		expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@webcraft/"))).toEqual([]);
	});

	test("says the version it is, so Modules' SDK ranges are checked against it", () => {
		expect(SDK_VERSION).toBe(pkg.version);
	});
});
