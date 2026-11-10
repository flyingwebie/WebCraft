// Kept-aside data is a durable part of a Site, even across repeated transfers and a Module's return.
import { expect, test } from "bun:test";
import { defineModule, procedure, z } from "@webcraft/module-sdk";
import { createTestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { exportedArchive, importArchive, manifestIn, rewritten, rowsIn } from "../harness/site-transfer.ts";
import { sample } from "../modules/sample/index.ts";
import { notes } from "../modules/sample/tables.ts";

// A Module may restore its own data. Exercise live/retained key collisions through its real API.
const restoringSample = defineModule({
	...sample,
	procedures: {
		...sample.procedures,
		literal: procedure({
			permission: "notes.edit",
			input: z.object({ text: z.string() }),
			async run(input, context) {
				await context.audit("note.literal", { entryId: input.text, personId: input.text, item: { id: input.text } });
				return { recorded: true };
			},
		}),
		restore: procedure({
			permission: "notes.edit",
			input: z.object({ id: z.uuid(), body: z.string() }),
			async run(input, context) {
				return context.data.insert(notes, { ...input, source: "module", createdAt: context.now() });
			},
		}),
	},
});

test("generic Module data and literal UUID text survive repeated missing-Module transfers and merge with live rows", async () => {
	const source = await createTestInstall({ modules: [restoringSample] });
	const target = await createTestInstall({ modules: [] });
	try {
		const admin = await source.superadmin();
		await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
		const workspaceId = (await source.createWorkspace("Source notes")).id;
		const siteId = (await source.createSite(workspaceId, { slug: "notes" })).id;
		const literal = "123e4567-e89b-42d3-a456-426614174000";
		await moduleApi<typeof sample>(admin, "sample").notes.add({ siteId, body: literal });
		await moduleApi<typeof restoringSample>(admin, "sample").literal({ siteId, text: literal });
		const oldArchive = await exportedArchive(source, admin, siteId);
		const oldId = rowsIn(oldArchive, "m_sample.notes")[0]?.id;
		let receiver = await target.superadmin();
		const workspace = (await target.createWorkspace("Retained notes")).id;
		const first = await importArchive(target, receiver, workspace, oldArchive, { name: "First", slug: "first" });
		expect(first.status).toBe("done");
		const once = await exportedArchive(target, receiver, first.site?.id ?? "");
		const second = await importArchive(target, receiver, workspace, once, { name: "Second", slug: "second" });
		expect(second.status).toBe("done");
		const secondId = second.site?.id ?? "";
		const twice = await exportedArchive(target, receiver, secondId);
		expect(manifestIn(twice).modules).toContainEqual({ id: "sample", version: "1.0.0", tables: ["notes"] });
		const held = rowsIn(twice, "m_sample.notes");
		expect(held).toHaveLength(1);
		expect(held[0]).toMatchObject({ body: literal, workspace_id: workspace, site_id: secondId });
		expect(held[0]?.id).not.toBe(oldId);
		expect(rowsIn(twice, "public.audit_log").find((row) => row.action === "sample.note.literal")?.details).toEqual({
			entryId: literal,
			personId: literal,
			item: { id: literal },
		});
		await target.restart({ modules: [restoringSample] });
		receiver = await target.superadmin();
		await receiver.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
		const api = moduleApi<typeof restoringSample>(receiver, "sample");
		await api.restore({ siteId: secondId, id: String(held[0]?.id), body: `Updated ${literal}` });
		await api.notes.add({ siteId: secondId, body: `New https://external.example/${literal}` });
		const merged = await exportedArchive(target, receiver, secondId);
		expect(rowsIn(merged, "m_sample.notes")).toHaveLength(2);
		const returned = await importArchive(source, admin, workspaceId, merged, { name: "Returned", slug: "returned" });
		expect(returned.status).toBe("done");
		const result = await moduleApi<typeof sample>(admin, "sample").notes.list({ siteId: returned.site?.id ?? "" });
		expect(result.notes.map((note) => note.body).sort()).toEqual([
			`New https://external.example/${literal}`,
			`Updated ${literal}`,
		]);
		expect(new Set(result.notes.map((note) => note.id)).size).toBe(2);
		expect(
			(await moduleApi<typeof sample>(admin, "sample").notes.list({ siteId })).notes.map((note) => note.body),
		).toEqual([literal]);
	} finally {
		await target.close();
		await source.close();
	}
});

test("retained tables preserve their foreign-key load order and typed references without interpreting text", async () => {
	const install = await createTestInstall({ modules: [] });
	try {
		const admin = await install.superadmin();
		const workspaceId = (await install.createWorkspace("Order")).id;
		const siteId = (await install.createSite(workspaceId, { slug: "order" })).id;
		const parent = crypto.randomUUID();
		const archive = rewritten(await exportedArchive(install, admin, siteId), {
			manifest: (m) => m.modules.push({ id: "absent", version: "1.0.0", tables: ["z_parent", "a_child"] }),
			extraTables: [
				{ name: "m_absent.z_parent", module: "absent", rows: [{ id: parent, title: parent }] },
				{
					name: "m_absent.a_child",
					module: "absent",
					rows: [{ id: crypto.randomUUID(), parent_id: parent, title: parent }],
					uuidColumns: [
						{ name: "id", array: false },
						{ name: "parent_id", array: false },
					],
				},
			],
		});
		const imported = await importArchive(install, admin, workspaceId, archive, {
			name: "Order copy",
			slug: "order-copy",
		});
		expect(imported.status).toBe("done");
		const copy = await exportedArchive(install, admin, imported.site?.id ?? "");
		expect(
			manifestIn(copy)
				.tables.filter((table: { module: string }) => table.module === "absent")
				.map((table: { name: string }) => table.name),
		).toEqual(["m_absent.z_parent", "m_absent.a_child"]);
		const parents = rowsIn(copy, "m_absent.z_parent");
		expect(parents[0]?.title).toBe(parent);
		expect(parents[0]?.id).not.toBe(parent);
		expect(rowsIn(copy, "m_absent.a_child")[0]).toMatchObject({ parent_id: parents[0]?.id, title: parent });
	} finally {
		await install.close();
	}
});
