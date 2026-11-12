// The reference-material denylist check (`scripts/check-denylist.sh`, ADR 0013) is what keeps certain
// names out of everything tracked. A check like that must fail when it couldn't look, never pass:
// these tests run the real script in a small repository of their own, with a made-up list.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-denylist.sh");
/** A made-up name standing for one the list forbids. */
const FORBIDDEN = "zebrafinch";

let repo: string;
let outside: string;

async function run(cwd: string, command: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn(command, {
		cwd,
		env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { code: await child.exited, output: stdout + stderr };
}

const check = (cwd: string, ...options: string[]) =>
	run(cwd, ["sh", SCRIPT, ...options], { WEBCRAFT_DENYLIST: FORBIDDEN });

async function git(...args: string[]) {
	const done = await run(repo, ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
	if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.output}`);
	return done.output.trim();
}

beforeAll(async () => {
	repo = mkdtempSync(join(tmpdir(), "webcraft-denylist-repo-"));
	outside = mkdtempSync(join(tmpdir(), "webcraft-denylist-outside-"));
	await git("init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "notes.md"), "Nothing to see here.\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "A first commit");
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

test("a clean repository passes", async () => {
	const head = await git("rev-parse", "HEAD");

	const checked = await check(repo, "--range", `${head}..HEAD`, "--branch", "main");

	expect(checked).toEqual({ code: 0, output: "check-denylist: no denylisted names found.\n" });
});

test("a commit range that can't be read fails the check: no message was looked at", async () => {
	// The base of a branch that was pushed over: a commit this repository doesn't have.
	const unknown = "1234567890123456789012345678901234567890";

	const checked = await check(repo, "--range", `${unknown}..HEAD`);

	expect(checked.code).not.toBe(0);
	expect(checked.output).not.toContain("no denylisted names found");
	expect(checked.output).not.toContain(FORBIDDEN);
});

test("files that can't be searched fail the check: outside a repository nothing was looked at", async () => {
	writeFileSync(join(outside, "notes.md"), `All about ${FORBIDDEN}.\n`);

	const checked = await check(outside);

	expect(checked.code).not.toBe(0);
	expect(checked.output).not.toContain("no denylisted names found");
});

test("a name in a file git takes for binary is found too, without showing the text", async () => {
	writeFileSync(
		join(repo, "export.dat"),
		Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`made with ${FORBIDDEN}\n`)]),
	);
	await git("add", "export.dat");
	try {
		const checked = await check(repo);

		expect(checked.code).toBe(1);
		expect(checked.output).toContain("export.dat");
		expect(checked.output).not.toContain(FORBIDDEN);
	} finally {
		await git("rm", "--quiet", "--cached", "export.dat");
		rmSync(join(repo, "export.dat"));
	}
});

test("a name in a commit's message is found by its commit, without showing the text", async () => {
	writeFileSync(join(repo, "more.md"), "More notes.\n");
	const base = await git("rev-parse", "HEAD");
	await git("add", "more.md");
	await git("commit", "--quiet", "-m", `Notes, as ${FORBIDDEN} does them`);

	const checked = await check(repo, "--range", `${base}..HEAD`);

	expect(checked.code).toBe(1);
	expect(checked.output).toContain("the message of commit");
	expect(checked.output).not.toContain(FORBIDDEN);
});
