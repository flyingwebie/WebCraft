import { expect, test } from "bun:test";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import wordpress from "@webcraft/module-wordpress-import";
import { createTestInstall } from "../harness/index.ts";

test("adding source HTTP requires fresh consent, and a live source cannot run without declaring it", async () => {
	const old: ModuleDefinition = {
		...wordpress,
		manifest: { ...wordpress.manifest, version: "1.0.0", uses: [] },
		importSources: wordpress.importSources?.filter((source) => !source.live),
	};
	const install = await createTestInstall({ modules: [old] });
	try {
		let admin = await install.superadmin();
		await admin.api.modules.approve({ moduleId: "wordpress-import", version: "1.0.0" });
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		await install.restart({ modules: [wordpress] });
		admin = await install.superadmin();
		expect((await admin.api.modules.list()).modules[0]).toMatchObject({
			status: "update-waiting",
			asks: { uses: [{ use: "importSourceHttp", isNew: true }] },
		});
		expect((await admin.api.imports.sources({ siteId: site.id })).sources).toEqual([]);
		await admin.api.modules.approve({ moduleId: "wordpress-import", version: "1.1.0" });
		expect((await admin.api.imports.sources({ siteId: site.id })).sources.map((source) => source.kind)).toContain(
			"live",
		);
		await install.restart({ modules: [{ ...wordpress, manifest: { ...wordpress.manifest, uses: [] } }] });
		expect((await (await install.superadmin()).api.modules.list()).modules[0]).toMatchObject({
			status: "cannot-run",
			problem: expect.stringContaining("requires importSourceHttp"),
		});
	} finally {
		await install.close();
	}
});

test("the live SDK port confines a Module to the chosen REST root and never exposes its login", async () => {
	let route = "wp/v2/users/me";
	const specimen: ModuleDefinition = {
		...wordpress,
		importSources: [
			{
				key: "probe",
				label: { en: "Probe", it: "Prova" },
				description: { en: "Probe", it: "Prova" },
				permission: "structure.edit",
				live: {
					async test(connection) {
						const reply = await connection.http(route);
						return { roles: [await reply.text(), ...Object.keys(connection)], types: [] };
					},
					async *read() {},
				},
			},
		],
	};
	const install = await createTestInstall({ modules: [specimen] });
	try {
		const admin = await install.superadmin();
		await admin.api.modules.approve({ moduleId: "wordpress-import", version: "1.1.0" });
		const site = await install.createSite((await install.createWorkspace()).id);
		const input = {
			siteId: site.id,
			source: "wordpress-import.probe",
			name: "Bound source",
			address: "https://source.example/blog",
			username: "login",
			applicationPassword: "application-password",
		};
		install.dns.answer("source.example", ["93.184.216.34"]);
		install.http.respond("GET", /^https:\/\/source.example\//, (request) => ({
			body: `${request.headers.get("authorization")} login:application-password application-password`,
		}));
		const before = install.http.requests.length;
		for (const path of [
			"https://other.example/wp-json/wp/v2/users/me",
			"//other.example/wp-json/",
			"../wp-admin/",
			"/wp-json/wp/v2/users/me",
			"wp/v2/%2fescape",
			"wp/v2/users?x={{wc-secret:other}}",
			"wp\\v2\\users",
			"https://login:password@source.example/blog/wp-json/wp/v2/users/me",
		]) {
			route = path;
			await expect(admin.api.imports.connect(input)).rejects.toMatchObject({ code: "IMPORT_INVALID" });
		}
		expect(install.http.requests).toHaveLength(before);
		route = "wp/v2/users/me";
		const connected = await admin.api.imports.connect(input);
		expect(connected.connection.roles).toEqual(["[redacted] [redacted] [redacted]", "includeHidden", "http"]);
		expect(install.http.requests.at(-1)?.url).toBe("https://source.example/blog/wp-json/wp/v2/users/me");
	} finally {
		await install.close();
	}
});
