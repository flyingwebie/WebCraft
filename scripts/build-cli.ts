// Builds the single-file `webcraft` CLI with `bun build --compile` for macOS (x64, arm64), Linux
// (x64, arm64) and Windows (x64), and, with --npm, the npm packages that install it: `@webcraft/cli`
// (a small Node launcher) and one package per platform holding its binary, which npm picks by `os`
// and `cpu`. The compiled CLI runs the Install's remote commands, signing in and `structure`; the
// server commands (`webcraft admin …`) run from the web image or a checkout. Nothing is published
// here: CI publishes on a release (.github/workflows/cli.yml).
//
//   bun scripts/build-cli.ts                     every platform, into dist/cli
//   bun scripts/build-cli.ts --target host       this computer's only (quick, no download)
//   bun scripts/build-cli.ts --npm               also the npm packages, into dist/cli/npm
//   bun scripts/build-cli.ts --out <folder>      somewhere else
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const ENTRY = join(ROOT, "apps/cli/src/main.ts");
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/** Each platform: Bun's compile target, and how npm names its system and processor. */
export const PLATFORMS = [
	{ target: "bun-darwin-x64", os: "darwin", cpu: "x64" },
	{ target: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
	// The baseline builds run on x64 processors without AVX2 too.
	{ target: "bun-linux-x64-baseline", os: "linux", cpu: "x64" },
	{ target: "bun-linux-arm64", os: "linux", cpu: "arm64" },
	{ target: "bun-windows-x64-baseline", os: "win32", cpu: "x64" },
] as const;

type Platform = (typeof PLATFORMS)[number];

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

/** A binary's file name: `webcraft-linux-arm64`, `webcraft-win32-x64.exe`. */
export function binaryName(platform: Pick<Platform, "os" | "cpu">): string {
	return `webcraft-${platform.os}-${platform.cpu}${platform.os === "win32" ? ".exe" : ""}`;
}

/** Compiles `webcraft` for one platform (or this computer's) into `outfile`. */
export async function compile(outfile: string, target?: string): Promise<void> {
	const command = [
		"bun",
		"build",
		"--compile",
		"--minify",
		// The server commands stay out (see apps/cli/src/cli.ts).
		"--define",
		'process.env.WEBCRAFT_BUILD="standalone"',
		...(target ? [`--target=${target}`] : []),
		ENTRY,
		"--outfile",
		outfile,
	];
	const child = Bun.spawn(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
	if ((await child.exited) !== 0) throw new Error(`Compiling for ${target ?? "this computer"} failed.`);
}

async function main(): Promise<void> {
	const out = resolve(ROOT, argument("--out") ?? "dist/cli");
	const host = argument("--target") === "host";
	const platforms: Platform[] = host
		? PLATFORMS.filter((platform) => platform.os === process.platform && platform.cpu === process.arch)
		: [...PLATFORMS];
	if (platforms.length === 0) throw new Error(`webcraft isn't built for ${process.platform} ${process.arch}.`);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });

	const sums: string[] = [];
	for (const platform of platforms) {
		const file = join(out, binaryName(platform));
		await compile(file, host ? undefined : platform.target);
		sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${binaryName(platform)}`);
	}
	writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
	if (process.argv.includes("--npm")) npmPackages(out, platforms);
	console.log(
		`Built webcraft ${VERSION} for ${platforms.map((each) => `${each.os}-${each.cpu}`).join(", ")} in ${out}.`,
	);
}

const LICENSE = "AGPL-3.0-or-later";
const REPOSITORY = { type: "git", url: "git+https://github.com/flyingwebie/WebCraft.git", directory: "apps/cli" };

/**
 * The npm packages: `@webcraft/cli`, whose `webcraft` runs the binary of the package matching this
 * computer, and `@webcraft/cli-<os>-<cpu>` for each platform, which npm installs only where it fits.
 */
function npmPackages(out: string, platforms: Platform[]): void {
	const root = join(out, "npm");
	const main = join(root, "cli");
	mkdirSync(join(main, "bin"), { recursive: true });
	for (const platform of platforms) {
		const folder = join(root, `cli-${platform.os}-${platform.cpu}`);
		mkdirSync(join(folder, "bin"), { recursive: true });
		const binary = join(folder, "bin", platform.os === "win32" ? "webcraft.exe" : "webcraft");
		writeFileSync(binary, readFileSync(join(out, binaryName(platform))));
		chmodSync(binary, 0o755);
		writeJson(join(folder, "package.json"), {
			name: `@webcraft/cli-${platform.os}-${platform.cpu}`,
			version: VERSION,
			description: `The webcraft command line, compiled for ${platform.os} ${platform.cpu}.`,
			license: LICENSE,
			repository: REPOSITORY,
			os: [platform.os],
			cpu: [platform.cpu],
			files: ["bin"],
			preferUnplugged: true,
		});
	}
	writeJson(join(main, "package.json"), {
		name: "@webcraft/cli",
		version: VERSION,
		description: "webcraft: the command line of WebCraft, the self-hosted CMS for agencies.",
		license: LICENSE,
		repository: REPOSITORY,
		bin: { webcraft: "bin/webcraft.js" },
		files: ["bin", "README.md"],
		engines: { node: ">=18" },
		optionalDependencies: Object.fromEntries(
			PLATFORMS.map((platform) => [`@webcraft/cli-${platform.os}-${platform.cpu}`, VERSION]),
		),
	});
	writeFileSync(join(main, "bin", "webcraft.js"), LAUNCHER);
	chmodSync(join(main, "bin", "webcraft.js"), 0o755);
	writeFileSync(
		join(main, "README.md"),
		"# webcraft\n\nThe command line of WebCraft: the Install's remote commands (one for each public procedure of its Management API), `webcraft login`, and `webcraft structure pull/push`.\n\n```sh\nnpm install --global @webcraft/cli\nwebcraft login --install https://cms.agency.example\nwebcraft help commands\n```\n\nSee https://github.com/flyingwebie/WebCraft/blob/main/docs/cli.md. Licensed AGPL-3.0-or-later.\n",
	);
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

/** The npm package's `webcraft`: finds this computer's binary and runs it with the same arguments. */
const LAUNCHER = `#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const name = "@webcraft/cli-" + process.platform + "-" + process.arch;
let binary;
try {
	binary = require.resolve(name + "/bin/webcraft" + (process.platform === "win32" ? ".exe" : ""));
} catch {
	console.error("webcraft: there is no webcraft for " + process.platform + " " + process.arch + " (" + name + " isn't installed). It runs on macOS (x64, arm64), Linux (x64, arm64) and Windows (x64).");
	process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
	console.error("webcraft: " + result.error.message);
	process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
`;

if (import.meta.main) await main();
