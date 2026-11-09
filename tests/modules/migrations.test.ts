// Module migrations join the `migrate` step: after WebCraft's own, each Module's SQL runs once, in its
// own schema; web and worker refuse to start (and /readyz answers 503) while one is pending.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type ModuleDefinition,
	type ModuleMigration,
	moduleSchema,
	siteColumns,
	text,
	timestamp,
	uuid,
} from "@webcraft/module-sdk";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { sample } from "./sample/index.ts";

/** The sample Module with more migrations, and other tables when given. */
function sampleWith(migrations: readonly ModuleMigration[], tables?: ModuleDefinition["tables"]): ModuleDefinition {
	return {
		...sample,
		manifest: { ...sample.manifest, version: "1.1.0" },
		migrations: [...(sample.migrations ?? []), ...migrations],
		tables: tables ?? sample.tables,
	};
}

const schema = moduleSchema("sample");

async function readiness(install: TestInstall) {
	const response = await install.request(install.adminUrl("/readyz"));
	return { status: response.status, schema: ((await response.json()) as { checks: { schema: string } }).checks.schema };
}

describe("a Module's pending migrations", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ modules: [sample] });
	});

	afterAll(async () => {
		await install.close();
	});

	test("an Install whose Modules' migrations all ran is ready", async () => {
		expect(await readiness(install)).toEqual({ status: 200, schema: "current" });
		expect((await install.migrate()).appliedMigrations).toEqual([]);
	});

	test("hold the Install back until the migrate step runs them, once", async () => {
		const pins = schema.table("tags", {
			...siteColumns(),
			id: uuid("id").primaryKey().defaultRandom(),
			label: text("label").notNull(),
		});
		const updated = sampleWith(
			[
				{
					name: "0002-tags",
					sql: `CREATE TABLE tags (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	label text NOT NULL,
	FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);`,
				},
			],
			[...(sample.tables ?? []), pins],
		);
		await install.restart({ modules: [updated] });

		expect(await readiness(install)).toEqual({ status: 503, schema: "behind" });

		expect((await install.migrate()).appliedMigrations).toEqual(["sample/0002-tags"]);
		expect(await readiness(install)).toEqual({ status: 200, schema: "current" });
		expect((await install.migrate()).appliedMigrations).toEqual([]);
	});
});

describe("refused Module migrations", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ modules: [sample] });
	});

	afterAll(async () => {
		await install.close();
	});

	/**
	 * Runs the migrate step with the sample at a new version; answers why it was refused. Nothing was
	 * applied, so a new migration is still pending afterwards.
	 */
	async function refusal(module: ModuleDefinition): Promise<string> {
		const pending = (module.migrations?.length ?? 0) > (sample.migrations?.length ?? 0);
		const error = await install.migrate({ modules: [module] }).then(
			() => null,
			(failure: unknown) => failure as Error,
		);
		if (!error) throw new Error("The migrate step applied the migration.");
		expect(error.name).toBe("ModuleMigrationError");
		await install.restart({ modules: [module] });
		expect((await readiness(install)).schema).toBe(pending ? "behind" : "current");
		await install.restart({ modules: [sample] });
		return error.message;
	}

	const changed: ModuleDefinition = {
		...sample,
		migrations: (sample.migrations ?? []).map((migration) => ({ ...migration, sql: `${migration.sql}\n-- changed` })),
	};

	test("one that changes a table of WebCraft's", async () => {
		const message = await refusal(
			sampleWith([{ name: "0002-entries", sql: "ALTER TABLE public.entries ADD COLUMN sample_flag text;" }]),
		);
		expect(message).toContain("outside its own schema, m_sample");
	});

	test("one that changes rows of WebCraft's", async () => {
		const message = await refusal(
			sampleWith([{ name: "0002-rename", sql: "UPDATE public.workspaces SET name = 'Taken over';" }]),
		);
		expect(message).toContain("changed public.workspaces, outside its own schema");
	});

	test("one that empties a table of WebCraft's", async () => {
		const message = await refusal(sampleWith([{ name: "0002-forget", sql: "TRUNCATE public.module_log;" }]));
		expect(message).toContain("changed public.module_log, outside its own schema");
	});

	test("one that reads a table of WebCraft's", async () => {
		const message = await refusal(
			sampleWith([{ name: "0002-peek", sql: "SELECT count(*) FROM public.people WHERE email LIKE '%@%';" }]),
		);
		expect(message).toContain("read public.people, outside its own schema");
	});

	test("one that makes a table outside its schema", async () => {
		const message = await refusal(
			sampleWith([{ name: "0002-outside", sql: "CREATE TABLE public.sample_things (id uuid PRIMARY KEY);" }]),
		);
		expect(message).toContain("outside its own schema");
	});

	test("one that makes a table the Module doesn't declare", async () => {
		const message = await refusal(
			sampleWith([
				{
					name: "0002-stray",
					sql: "CREATE TABLE stray (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE);",
				},
			]),
		);
		expect(message).toContain("m_sample.stray, which it doesn't declare");
	});

	test("one whose table isn't tied to its Site", async () => {
		const loose = schema.table("loose", { ...siteColumns(), id: uuid("id").primaryKey() });
		const message = await refusal(
			sampleWith(
				[
					{
						name: "0002-loose",
						sql: "CREATE TABLE loose (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, site_id uuid NOT NULL);",
					},
				],
				[...(sample.tables ?? []), loose],
			),
		);
		expect(message).toContain("needs FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id)");
	});

	test("a Module that declares a column its migrations never made", async () => {
		const notes = schema.table("notes", {
			...siteColumns(),
			id: uuid("id").primaryKey(),
			body: text("body").notNull(),
			source: text("source").notNull(),
			colour: text("colour"),
			createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		});
		const message = await refusal(sampleWith([], [notes]));
		expect(message).toContain("m_sample.notes.colour, which its migrations don't make");
	});

	test("a migration that changed after it was applied", async () => {
		const message = await refusal(changed);
		expect(message).toContain("0001-notes changed after it was applied");
	});

	test("a migration that fails", async () => {
		const message = await refusal(sampleWith([{ name: "0002-broken", sql: "CREATE TABLE notes (id uuid);" }]));
		expect(message).toContain("0002-broken failed");
	});
});
