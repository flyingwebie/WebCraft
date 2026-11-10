import { expect, test } from "bun:test";
import { type ModuleDefinition, ModuleError } from "@webcraft/module-sdk";
import wordpress from "@webcraft/module-wordpress-import";

import { createTestInstall } from "../harness/index.ts";

for (const phase of ["test", "read"] as const) {
	for (const expected of [false, true]) {
		test(`live source ${phase}: ${expected ? "a refusal is shown without an error line" : "an unexpected failure reaches the Module log"}`, async () => {
			const fail = () => {
				if (expected) throw new ModuleError("source-refused", "The source refused this request.");
				throw new Error("The live source unexpectedly failed.");
			};
			const specimen: ModuleDefinition = {
				...wordpress,
				importSources: [
					{
						key: "probe",
						label: { en: "Probe", it: "Prova" },
						description: { en: "Probe", it: "Prova" },
						permission: "structure.edit",
						live: {
							async test() {
								if (phase === "test") fail();
								return { roles: ["editor"], types: [] };
							},
							async *read() {
								yield { kind: "type", key: "notes", label: "Notes", holds: "entries" };
								fail();
							},
						},
					},
				],
			};
			const install = await createTestInstall({ modules: [specimen] });
			try {
				const admin = await install.superadmin();
				await admin.api.modules.approve({ moduleId: "wordpress-import", version: "1.1.0" });
				const workspace = await install.createWorkspace();
				const site = await install.createSite(workspace.id);
				const connecting = admin.api.imports.connect({
					siteId: site.id,
					source: "wordpress-import.probe",
					name: "Failure reporting",
					address: "https://source.example",
					username: "writer",
					applicationPassword: "never-log-this-password",
				});
				if (phase === "test") {
					await expect(connecting).rejects.toMatchObject({ code: "IMPORT_INVALID" });
				} else {
					const connected = await connecting;
					await install.drainJobs();
					const { file } = await admin.api.imports.file({ siteId: site.id, fileId: connected.file.id });
					expect(file.status).toBe("refused");
				}
				const { lines } = await admin.api.modules.log({ moduleId: "wordpress-import" });
				const failures = lines.filter((line) => line.level === "error");
				expect(failures).toHaveLength(expected ? 0 : 1);
				if (!expected) {
					expect(failures[0]).toMatchObject({
						workspaceId: workspace.id,
						siteId: site.id,
						details: { error: { name: "Error", message: "The live source unexpectedly failed." } },
					});
				}
				expect(JSON.stringify(lines)).not.toContain("never-log-this-password");
				expect(JSON.stringify(lines)).not.toContain('"stack"');
			} finally {
				await install.close();
			}
		});
	}
}
