// Redirect rules name paths as the Site's Staging address writes them: every language but the
// Default language under its prefix (`/fr/ancien`). On a language's own domain the same rule answers
// without the prefix, and a rule's target goes where its language lives, in one hop.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
const STAGING = "https://village.sites.test";
const PRIMARY = "https://village-bakery.example";
const FRENCH = "https://village-bakery.fr";

const rules = () => moduleApi<typeof redirects>(editor, "redirects").rules;

/** Points domains (already on the Site) at the Install, and runs the checks that come due. */
async function verify(names: string[]): Promise<void> {
	for (const name of names) install.connectDomain(name);
	await install.clock.advance(60_000);
	expect((await install.drainJobs()).failed).toEqual([]);
}

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "redirects", version: "1.1.0" });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Village Bakery", slug: "village" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	await staff.api.languages.add({ siteId, code: "fr" });
	await staff.api.languages.add({ siteId, code: "de" });
	await staff.api.domains.add({ siteId, name: "village-bakery.example" });
	await verify(["village-bakery.example"]);
	await staff.api.languages.update({ siteId, code: "fr", domain: "village-bakery.fr" });
	await verify(["village-bakery.fr"]);
});

afterAll(async () => {
	await install.close();
});

test("a rule on a language's prefix answers on its Staging address, on its own domain, and from the Primary domain", async () => {
	await rules().add({ siteId, from: "/fr/ancien", to: "/fr/blog/pain-frais", status: 301 });

	const staging = await install.request(`${STAGING}/fr/ancien`);
	expect([staging.status, staging.headers.get("location")]).toEqual([301, "/fr/blog/pain-frais"]);
	const own = await install.request(`${FRENCH}/ancien`);
	expect([own.status, own.headers.get("location")]).toEqual([301, "/blog/pain-frais"]);
	// On the Primary domain the prefix belongs to the French domain: one hop goes there.
	const primary = await install.request(`${PRIMARY}/fr/ancien?x=1`);
	expect([primary.status, primary.headers.get("location")]).toEqual([301, `${FRENCH}/blog/pain-frais?x=1`]);
	// The Default language's path of the same name is another path.
	expect((await install.request(`${PRIMARY}/ancien`)).status).toBe(404);
});

test("a rule's target goes where its language lives, seen from each hostname", async () => {
	await rules().add({ siteId, from: "/old-french", to: "/fr/accueil", status: 302 });
	await rules().add({ siteId, from: "/de/alt", to: "/de/neu", status: 301 });
	await rules().add({ siteId, from: "/fr/vers-anglais", to: "/english", status: 301 });

	expect((await install.request(`${PRIMARY}/old-french`)).headers.get("location")).toBe(`${FRENCH}/accueil`);
	expect((await install.request(`${STAGING}/old-french`)).headers.get("location")).toBe("/fr/accueil");
	expect((await install.request(`${PRIMARY}/de/alt`)).headers.get("location")).toBe("/de/neu");
	expect((await install.request(`${FRENCH}/vers-anglais`)).headers.get("location")).toBe(`${PRIMARY}/english`);
});
