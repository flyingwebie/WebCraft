// Type-checks every workspace with a tsconfig.json, and the repo's own scripts, with `bun check`:
// the same errors as tsc, on every core. One project after another; each one already uses them all.
// `bun run typecheck`; pass directories to check only those (the pre-push hook does).
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const { workspaces } = (await Bun.file(join(root, "package.json")).json()) as { workspaces: { packages: string[] } };

const all = [
	".",
	...workspaces.packages.flatMap((pattern) =>
		pattern.endsWith("/*")
			? [...new Bun.Glob(`${pattern}/tsconfig.json`).scanSync({ cwd: root })].map((file) => file.slice(0, -"/tsconfig.json".length))
			: existsSync(join(root, pattern, "tsconfig.json"))
				? [pattern]
				: [],
	),
].sort();
const projects = process.argv.length > 2 ? process.argv.slice(2) : all;

let failed = 0;
for (const project of projects) {
	const check = Bun.spawnSync([process.execPath, "check", "--project", project, "--no-pretty"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (check.exitCode !== 0) failed++;
}
if (failed > 0) {
	console.error(`Type errors in ${failed} of ${projects.length} projects.`);
	process.exit(1);
}
console.log(`No type errors in ${projects.length} projects.`);
