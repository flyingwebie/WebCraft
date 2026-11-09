// Site analytics' collection (ADRs 0019, 0020, 0023): a script under 2 KB, served as a file from the
// Site's own domain on pages where the Module runs, posts events to a path on that domain. It runs
// before visitors answer the Consent banner, and pages carrying it ask for Analytics.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, COLLECT_PATH, dayOf, liveSite } from "../harness/analytics.ts";
import { headOf } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const newSite = () => liveSite(install, staff, workspaceId, `collect-${++domains}.example`);

/** The collection script's tag in a page's head: its address, and whether a <template> holds it back. */
function collectionScriptIn(html: string): { src: string; held: boolean } | undefined {
	const tag = /<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer data-wc-module="site-analytics"><\/script>/.exec(html);
	if (!tag) return undefined;
	const held = [...html.matchAll(/<template data-wc-consent="[a-z]+">([\s\S]*?)<\/template>/g)].some((match) =>
		(match[1] ?? "").includes(tag[0]),
	);
	return { src: tag[1] ?? "", held };
}

describe("the collection script", () => {
	test("loads on the Site's pages before consent, as a file under 2 KB from the Site's domain, and the page asks for Analytics", async () => {
		const site = await newSite();

		const html = await expectSafePage(await install.request(`${site.origin}/`));

		const script = collectionScriptIn(headOf(html));
		expect(script?.held).toBe(false);
		expect(html).toContain('<meta name="webcraft-consent-mode" content="optIn">');
		expect(html).toContain('id="wc-consent"');
		const file = await install.request(`${site.origin}${script?.src}`);
		expect(file.status).toBe(200);
		expectSiteHeaders(file);
		const code = await file.text();
		expect(new TextEncoder().encode(code).byteLength).toBeLessThan(2048);
		expect(code).toContain(COLLECT_PATH);
	});

	test("isn't on pages where Site analytics is off, nor in Edit mode", async () => {
		const site = await newSite();
		const editing = await openEditMode(install, staff, site.siteId, "/");
		expect(collectionScriptIn(await expectSafePage(await editing.page("/"), "editMode"))).toBeUndefined();

		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "site-analytics", on: false });

		const html = await expectSafePage(await install.request(`${site.origin}/`));
		expect(collectionScriptIn(html)).toBeUndefined();
	});
});

describe("collecting", () => {
	test("a page view is counted, with no cookie set and no visitor before consent", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin);

		const sent = await visitor.view("/");

		expect(sent.status).toBe(204);
		expect(sent.headers.get("set-cookie")).toBeNull();
		expect(sent.headers.get("cache-control")).toBe("no-store");
		const { totals } = await analyticsApi(staff).stats.totals({ siteId: site.siteId, ...dayOf(install.clock.now()) });
		expect(totals).toEqual({ pageviews: 1, visitors: 0, visits: 0, events: 0 });
	});
});
