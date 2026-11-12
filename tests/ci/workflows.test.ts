// The workflows that build and publish WebCraft (the `webcraft` CLI on npm, the web and worker images)
// run other people's actions while holding what publishes them. A tag such as `v7` can be moved to
// other code by whoever holds the action's repository; a commit can't. So every action is named by its
// commit, with the version it is in a comment, and a job gets the right to publish only where it does.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");

const workflows = readdirSync(WORKFLOWS)
	.filter((name) => name.endsWith(".yml"))
	.map((name) => ({ name, lines: readFileSync(join(WORKFLOWS, name), "utf8").split("\n") }));

test("every action a workflow uses is named by its commit, with its version beside it", () => {
	const used = workflows.flatMap(({ name, lines }) =>
		lines.filter((line) => /^\s*(?:-\s+)?uses:/.test(line)).map((line) => ({ workflow: name, uses: line.trim() })),
	);

	expect(used.length).toBeGreaterThan(10);
	const movable = used.filter(({ uses }) => !/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(uses));
	expect(movable).toEqual([]);
});

test("no workflow may publish packages as a whole: only the jobs that push ask for it", () => {
	for (const { name, lines } of workflows) {
		// The workflow's own permissions: the block before its jobs.
		const top = lines.slice(0, lines.indexOf("jobs:")).join("\n");
		expect({ name, top: /^permissions:\n {2}contents: read\n(?! {2})/m.test(top) }).toEqual({ name, top: true });
	}
});
