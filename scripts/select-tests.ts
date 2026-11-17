// Which test files a pull request's changes can reach, so CI runs only those on the pull request.
// The merge queue and main always run every test, so a test this misses still runs before anything
// reaches main. It fails safe: anything it can't trace sends back "all".
//
//   bun scripts/select-tests.ts <base commit>   prints the test files to run, one per line, or "all"
//
// 1. Bun's bundler traces every test file's imports through the workspace packages (third-party
//    packages excluded: bun.lock changing sends back "all"). A changed file selects the tests that
//    import it, directly or not.
//    Tests whose code (or a harness module they use) names a changed file run too: they read it.
// 2. A changed file no test imports sends back "all" when its path or name appears anywhere in the
//    tests' code (a file a test reads, such as docs/development.md, or a script it runs) or when it
//    isn't prose: a migration, a JSON document, a Dockerfile, a workflow, the lockfile, a process a
//    test starts. Only Markdown and agent notes that no test names are left out.
// 3. A test that starts a process (itself or through a harness module) runs whenever anything it
//    imports changes, and also whenever any non-test code changes: the process runs code the test
//    never imports.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const base = process.argv[2];
if (!base) {
	console.error("Usage: bun scripts/select-tests.ts <base commit>");
	process.exit(2);
}

const git = (...args: string[]) => {
	const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
};
const changed = git("diff", "--name-only", "--no-renames", `${base}...HEAD`).split("\n").filter(Boolean);

function all(why: string): never {
	console.error(`select-tests: all tests (${why}).`);
	console.log("all");
	process.exit(0);
}
if (changed.length === 0) all("nothing changed against the base");

const tests = [...new Bun.Glob("tests/**/*.test.{ts,tsx}").scanSync({ cwd: root })].filter(
	(file) => !file.includes("node_modules"),
);
const build = await Bun.build({
	entrypoints: tests.map((file) => `./${file}`),
	root,
	target: "bun",
	metafile: true,
	throw: false,
	outdir: join(root, "node_modules/.cache/select-tests"),
	plugins: [
		{
			// Only WebCraft's own code: third-party packages are fixed by bun.lock.
			name: "workspace-only",
			setup(builder) {
				builder.onResolve({ filter: /^(?![./]|@webcraft\/)/ }, (args) => ({ path: args.path, external: true }));
			},
		},
	],
});
if (!build.success || !build.metafile) all(`the import graph didn't build: ${build.logs.map(String).join("; ")}`);

// Each test file's inputs: the outputs are named after their entry points, in the same order.
const graphs = new Map<string, Set<string>>();
for (const output of Object.values(build.metafile.outputs)) {
	const entry = output.entryPoint;
	if (entry) graphs.set(entry.replace(/^\.\//, ""), new Set(Object.keys(output.inputs)));
}
if (graphs.size !== tests.length) all(`traced ${graphs.size} of ${tests.length} test files`);

const reached = new Set([...graphs.values()].flatMap((inputs) => [...inputs]));
const startsProcess = /\b(?:Bun\.spawn(?:Sync)?|spawn(?:Sync)?|execFile(?:Sync)?|exec(?:Sync)?|fork)\(|new Worker\(/;
const testCode = [...reached].filter((file) => file.startsWith("tests/"));
const spawners = new Set(testCode.filter((file) => startsProcess.test(readFileSync(join(root, file), "utf8"))));
const sources = new Map(testCode.map((file) => [file, readFileSync(join(root, file), "utf8")]));
// The test code that names `file`: a file a test reads, or a script it starts, by path or by name.
const namers = (file: string) =>
	[...sources].filter(([, text]) => text.includes(file) || text.includes(basename(file))).map(([name]) => name);
const prose = (file: string) => file.endsWith(".md") || file.startsWith(".agents/") || file.startsWith(".claude/");

const selected = new Set<string>();
for (const file of changed) {
	const named = namers(file);
	if (reached.has(file)) {
		// The tests that import it, and the tests whose code (or harness) reads it without importing it.
		for (const [test, inputs] of graphs) {
			if (inputs.has(file) || named.some((namer) => inputs.has(namer))) selected.add(test);
		}
		continue;
	}
	if (named.length > 0) all(`${file} is named in the tests' code`);
	if (!prose(file)) all(`${file} is imported by no test`);
}
const codeChanged = changed.some((file) => !prose(file) && !file.startsWith("tests/"));
for (const [test, inputs] of graphs) {
	if ([...inputs].some((input) => spawners.has(input)) && (codeChanged || selected.has(test))) selected.add(test);
}

console.error(
	`select-tests: ${selected.size} of ${tests.length} test files reach the ${changed.length} changed files.`,
);
for (const test of [...selected].sort()) console.log(test);
