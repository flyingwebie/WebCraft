// A Site's outside scripts (ADR 0022): tags, pixels and widgets, given as an https address or pasted
// as a third-party snippet. Visitors' pages load them where Staff put them; code a snippet holds is a
// file the Site serves under its hash, never inline (ADR 0023); the hosts they load from are allowed
// by themselves. They never run in Edit mode, which shows a labelled placeholder for each instead.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ALLOWED_HOSTS_PER_SITE } from "@webcraft/core";

import { headOf } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders, policyOf } from "../harness/site-safety.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with a published home page. */
async function newSite() {
	const slug = `outside-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: (await editor.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page")
			?.id as string,
		title: "Home",
		slug: "home",
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	return { siteId, url: (path: string) => `https://${slug}.sites.test${path}` };
}

/** The script tags of some HTML, in order. */
function scriptTags(html: string): string[] {
	return [...html.matchAll(/<script\b[^>]*><\/script>/g)].map((match) => match[0]);
}

/** What comes before `</body>`, after the Site template. */
function bodyEnd(html: string): string {
	return /<\/main>\n([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
}

const SNIPPET = `<!-- Visitor counter -->
<script async src="https://tags.example.com/tag.js?id=T-1&amp;l=en"></script>
<script>
  window.queue = window.queue || [];
  function track() { queue.push(arguments); }
  track("start", "T-1");
</script>
<script>
  (function () {
    var s = document.createElement("script");
    s.src = "https://cdn.example.net/loader.js";
    document.head.appendChild(s);
  })();
</script>
<noscript><img src="https://tags.example.com/pixel?id=T-1" alt=""></noscript>
`;

describe("outside scripts on visitors' pages", () => {
	test("one given by address loads where Staff put it, and its host is allowed by itself", async () => {
		const site = await newSite();
		const { outsideScript } = await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Chat widget",
			placement: "bodyEnd",
			consentCategory: "marketing",
			source: { kind: "url", url: "https://widgets.example.com/chat.js" },
		});
		expect(outsideScript).toMatchObject({
			name: "Chat widget",
			kind: "url",
			url: "https://widgets.example.com/chat.js",
			placement: "bodyEnd",
			consentCategory: "marketing",
			hosts: ["widgets.example.com"],
			blockedHosts: [],
		});

		const page = await install.request(site.url("/"));
		const html = await expectSafePage(page.clone());
		expect(scriptTags(bodyEnd(html))).toEqual(['<script src="https://widgets.example.com/chat.js" async></script>']);
		expect(scriptTags(headOf(html))).toEqual([]);
		expect(policyOf(page).get("script-src")).toEqual(["'self'", "https://widgets.example.com"]);
		expect((await staff.api.csp.get({ siteId: site.siteId })).policy.hosts).toEqual([
			{ host: "widgets.example.com", source: "auto", usedBy: [{ id: outsideScript.id, name: "Chat widget" }] },
		]);
	});

	test("a pasted snippet: its code is served from the Site as files, in order, its addresses kept and its hosts allowed", async () => {
		const site = await newSite();
		const { outsideScript } = await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Visitor counter",
			placement: "head",
			consentCategory: "analytics",
			source: { kind: "snippet", snippet: SNIPPET },
		});
		expect(outsideScript.hosts).toEqual(["cdn.example.net", "tags.example.com"]);
		expect(outsideScript.loads.map((load) => load.kind)).toEqual(["src", "code", "code"]);

		const page = await install.request(site.url("/"));
		const html = await expectSafePage(page.clone());
		const [first, second, third] = outsideScript.loads.map((load) => load.src);
		expect(scriptTags(headOf(html))).toEqual([
			`<script src="https://tags.example.com/tag.js?id=T-1&amp;l=en" async></script>`,
			`<script src="${second}"></script>`,
			`<script src="${third}"></script>`,
		]);
		expect(first).toBe("https://tags.example.com/tag.js?id=T-1&l=en");
		// The pixel for browsers without JavaScript is left out, like the snippet's scripts would be.
		expect(html).not.toContain("pixel");
		expect(policyOf(page).get("script-src")).toEqual(["'self'", "https://cdn.example.net", "https://tags.example.com"]);

		const file = await install.request(site.url(second ?? ""));
		expect(file.status).toBe(200);
		expectSiteHeaders(file);
		expect(file.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(await file.text()).toBe(
			'window.queue = window.queue || [];\n  function track() { queue.push(arguments); }\n  track("start", "T-1");',
		);
		expect(second).toMatch(/^\/_wc\/js\/[0-9a-f]{16}\.js$/);
	});

	test("under Relaxed too, nothing is ever written into the page", async () => {
		const site = await newSite();
		await staff.api.csp.setMode({ siteId: site.siteId, mode: "relaxed" });
		await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Tag manager",
			placement: "head",
			consentCategory: "analytics",
			source: { kind: "snippet", snippet: SNIPPET },
		});
		await expectSafePage(await install.request(site.url("/")), "relaxed");
	});

	test("a snippet that isn't only scripts, or loads from somewhere that isn't https on another host, is refused by line", async () => {
		const site = await newSite();
		const refused = async (snippet: string) => {
			try {
				await staff.api.outsideScripts.add({
					siteId: site.siteId,
					name: "Bad",
					placement: "head",
					consentCategory: "necessary",
					source: { kind: "snippet", snippet },
				});
			} catch (error) {
				expect(error).toMatchObject({ code: "OUTSIDE_SCRIPT_INVALID" });
				return ((error as { data: { problems: { line: number }[] } }).data.problems ?? []).map(
					(problem) => problem.line,
				);
			}
			throw new Error(`Not refused: ${snippet}`);
		};

		expect(await refused('<script src="https://ok.example.com/a.js"></script>\n<div id="chat"></div>')).toEqual([2]);
		expect(await refused('<script src="https://ok.example.com/a.js" onload="go()"></script>')).toEqual([1]);
		expect(await refused('<script type="text/template"><p>Hi</p></script>')).toEqual([1]);
		expect(await refused('\n<script src="http://insecure.example.com/a.js"></script>')).toEqual([2]);
		expect(await refused('<script src="/local.js"></script>')).toEqual([1]);
		expect(await refused('<script src="javascript:alert(1)"></script>')).toEqual([1]);
		expect(await refused("<!-- nothing here -->")).toEqual([1]);
		expect(await refused("<script>go()")).toEqual([1]);
		await expect(
			staff.api.outsideScripts.add({
				siteId: site.siteId,
				name: "Bad",
				placement: "head",
				consentCategory: "necessary",
				source: { kind: "url", url: "http://insecure.example.com/a.js" },
			}),
		).rejects.toMatchObject({ code: "OUTSIDE_SCRIPT_INVALID" });
		expect((await staff.api.outsideScripts.list({ siteId: site.siteId })).outsideScripts).toEqual([]);
	});
});

describe("the Site's allowed hosts", () => {
	test("a snippet whose code reaches more hosts than a Site may allow is refused, and nothing is kept", async () => {
		const site = await newSite();
		const loads = Array.from(
			{ length: ALLOWED_HOSTS_PER_SITE + 1 },
			(_, index) => `load("https://cdn-${index}.example.com/a.js");`,
		);

		await expect(
			staff.api.outsideScripts.add({
				siteId: site.siteId,
				name: "Many hosts",
				placement: "head",
				consentCategory: "marketing",
				source: { kind: "snippet", snippet: `<script>${loads.join("\n")}</script>` },
			}),
		).rejects.toMatchObject({ code: "TOO_MANY_HOSTS" });
		expect((await staff.api.outsideScripts.list({ siteId: site.siteId })).outsideScripts).toEqual([]);
		expect(JSON.stringify([...policyOf(await install.request(site.url("/")))])).not.toContain("cdn-0.example.com");
	});
});

describe("outside scripts in Edit mode", () => {
	test("never run there: each shows as a labelled placeholder, in the page's language", async () => {
		const site = await newSite();
		const { outsideScript: chat } = await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Chat widget",
			placement: "bodyEnd",
			consentCategory: "marketing",
			source: { kind: "url", url: "https://widgets.example.com/chat.js" },
		});
		const { outsideScript: counter } = await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Visitor counter",
			placement: "head",
			consentCategory: "analytics",
			source: { kind: "snippet", snippet: SNIPPET },
		});
		const editing = await openEditMode(install, editor, site.siteId, "/");

		const html = await expectSafePage(await editing.page("/"), "editMode");
		expect(html).not.toContain("widgets.example.com");
		expect(html).not.toContain("tags.example.com");
		for (const load of counter.loads) expect(html).not.toContain(load.src);
		expect(bodyEnd(html)).toBe(
			[
				'<aside class="wc-outside-scripts" aria-label="Outside scripts"><ul>',
				`<li class="wc-outside-script" data-wc-outside-script="${chat.id}"><span class="wc-outside-script-name">Chat widget</span> <span class="wc-outside-script-note">doesn't run while editing</span></li>`,
				`<li class="wc-outside-script" data-wc-outside-script="${counter.id}"><span class="wc-outside-script-name">Visitor counter</span> <span class="wc-outside-script-note">doesn't run while editing</span></li>`,
				"</ul></aside>\n",
			].join(""),
		);
		// Visitors' pages carry no placeholder.
		expect(await (await install.request(site.url("/"))).text()).not.toContain("wc-outside-script");
	});
});

describe("changing outside scripts", () => {
	test("removing one takes the hosts only it needed with it; hosts Staff added stay", async () => {
		const site = await newSite();
		await staff.api.csp.addHost({ siteId: site.siteId, host: "tags.example.com" });
		const { outsideScript } = await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Visitor counter",
			placement: "head",
			consentCategory: "analytics",
			source: { kind: "snippet", snippet: SNIPPET },
		});
		expect(
			(await staff.api.csp.get({ siteId: site.siteId })).policy.hosts.map((host) => [host.host, host.source]),
		).toEqual([
			["cdn.example.net", "auto"],
			["tags.example.com", "hand"],
		]);

		await staff.api.outsideScripts.remove({ siteId: site.siteId, outsideScriptId: outsideScript.id });

		expect((await staff.api.csp.get({ siteId: site.siteId })).policy.hosts).toEqual([
			{ host: "tags.example.com", source: "hand", usedBy: [] },
		]);
		const page = await install.request(site.url("/"));
		expect(scriptTags(await page.clone().text())).toEqual([]);
		expect(policyOf(page).get("script-src")).toEqual(["'self'", "https://tags.example.com"]);
		await expect(
			staff.api.outsideScripts.remove({ siteId: site.siteId, outsideScriptId: outsideScript.id }),
		).rejects.toMatchObject({ code: "OUTSIDE_SCRIPT_NOT_FOUND" });
	});

	test("when Staff remove a host an outside script needs, the script shows as blocked there", async () => {
		const site = await newSite();
		await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Chat widget",
			placement: "bodyEnd",
			consentCategory: "marketing",
			source: { kind: "url", url: "https://widgets.example.com/chat.js" },
		});
		await staff.api.csp.removeHost({ siteId: site.siteId, host: "widgets.example.com" });

		const [script] = (await staff.api.outsideScripts.list({ siteId: site.siteId })).outsideScripts;
		expect(script?.blockedHosts).toEqual(["widgets.example.com"]);
		expect(policyOf(await install.request(site.url("/"))).get("script-src")).toEqual(["'self'"]);
	});

	test("only Staff manage them; each change is in the Audit log", async () => {
		const site = await newSite();
		const input = {
			siteId: site.siteId,
			name: "Chat widget",
			placement: "bodyEnd" as const,
			consentCategory: "marketing" as const,
			source: { kind: "url" as const, url: "https://widgets.example.com/chat.js" },
		};
		const { outsideScript } = await staff.api.outsideScripts.add(input);
		for (const call of [
			() => editor.api.outsideScripts.list({ siteId: site.siteId }),
			() => editor.api.outsideScripts.add(input),
			() => editor.api.outsideScripts.update({ ...input, outsideScriptId: outsideScript.id }),
			() => editor.api.outsideScripts.remove({ siteId: site.siteId, outsideScriptId: outsideScript.id }),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}

		await staff.api.outsideScripts.update({
			...input,
			outsideScriptId: outsideScript.id,
			consentCategory: "necessary",
		});
		await staff.api.outsideScripts.remove({ siteId: site.siteId, outsideScriptId: outsideScript.id });
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 10 });
		expect(
			entries
				.filter((entry) => entry.siteId === site.siteId)
				.map((entry) => entry.action)
				.slice(0, 3),
		).toEqual(["outsideScript.remove", "outsideScript.update", "outsideScript.add"]);
	});
});

// Last in the file: it moves the clock past every session.
describe("replaced code", () => {
	test("a changed snippet's old code is still served for 30 days, for pages loaded before", async () => {
		const site = await newSite();
		const { outsideScript } = await staff.api.outsideScripts.add({
			siteId: site.siteId,
			name: "Visitor counter",
			placement: "head",
			consentCategory: "analytics",
			source: { kind: "snippet", snippet: SNIPPET },
		});
		const old = outsideScript.loads[1]?.src ?? "";

		const { outsideScript: changed } = await staff.api.outsideScripts.update({
			siteId: site.siteId,
			outsideScriptId: outsideScript.id,
			name: "Visitor counter",
			placement: "bodyEnd",
			consentCategory: "analytics",
			source: { kind: "snippet", snippet: '<script>track("start", "T-2");</script>' },
		});
		expect(changed.hosts).toEqual([]);
		const html = await (await install.request(site.url("/"))).text();
		expect(scriptTags(bodyEnd(html))).toEqual([`<script src="${changed.loads[0]?.src}"></script>`]);
		expect(html).not.toContain(old);
		// The hosts only the old snippet needed are no longer allowed.
		expect((await staff.api.csp.get({ siteId: site.siteId })).policy.hosts).toEqual([]);

		expect((await install.request(site.url(old))).status).toBe(200);
		await install.clock.advance(31 * 24 * 60 * 60 * 1000);
		expect((await install.drainJobs()).failed).toEqual([]);
		expect((await install.request(site.url(old))).status).toBe(404);
		expect((await install.request(site.url(changed.loads[0]?.src ?? ""))).status).toBe(200);
	});
});
