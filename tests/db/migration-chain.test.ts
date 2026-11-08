// Migrations made on two branches at once can each be generated from the same parent. Git merges
// them without a conflict, but the newer snapshot then misses the other branch's tables, and the
// next `bun run db:generate` writes those tables again. This keeps the chain one straight line.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FOLDER = new URL("../../packages/db/src/migrations/", import.meta.url).pathname;

type Snapshot = { id: string; prevIds: string[] };

test("each migration's snapshot follows the one before it", () => {
	const migrations = readdirSync(FOLDER, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	expect(migrations.length).toBeGreaterThan(0);

	const problems: string[] = [];
	let previous: { name: string; id: string } | undefined;
	for (const name of migrations) {
		const snapshot = JSON.parse(readFileSync(join(FOLDER, name, "snapshot.json"), "utf8")) as Snapshot;
		if (previous && (snapshot.prevIds.length !== 1 || snapshot.prevIds[0] !== previous.id)) {
			problems.push(
				`${name} was generated on top of another parent than ${previous.name}: delete its folder and run \`bun run db:generate -- --name <its name>\` again (custom SQL: recreate it with --custom).`,
			);
		}
		previous = { name, id: snapshot.id };
	}
	expect(problems).toEqual([]);
});
