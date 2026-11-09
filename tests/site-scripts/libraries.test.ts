// A Site's Libraries (ADR 0023): script packages Staff add at a fixed version, by package and version
// from the npm registry or by an https address. WebCraft downloads each once (through the guarded
// fetcher), checks it, keeps it in the Install's storage and serves it from the Site's domain as a
// hashed file, so pages need no outside host. Nothing updates on its own: checking says what could.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { LIBRARIES_PER_SITE, LIBRARY_ARCHIVE_UNPACKED_MAX_BYTES } from "@webcraft/core";

import { headOf } from "../harness/code-mode.ts";
import { fakeNpmPackage, integrityOf, NPM_HOST } from "../harness/fake-npm.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders, policyOf } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let editor: TestBrowser;

const CORE = "/* motion kit 3.13.0 */ window.motionKit = { version: '3.13.0' };";
const SCROLL = "/* motion kit scroll plugin */ window.motionKit.scroll = true;";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	fakeNpmPackage(install, "motion-kit", {
		"3.12.0": { files: { "dist/motion-kit.min.js": "/* 3.12.0 */" }, license: "MIT", main: "dist/motion-kit.min.js" },
		"3.13.0": {
			files: {
				"index.cjs": "module.exports = {}",
				"dist/motion-kit.min.js": CORE,
				"dist/plugins/scroll.min.js": SCROLL,
			},
			license: "MIT",
			main: "index.cjs",
			jsdelivr: "./dist/motion-kit.min.js",
		},
	});
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with a published home page and a published Site script. */
async function newSite() {
	const slug = `libraries-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	await goLive(install, siteId);
	const pages = (await editor.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: pages?.id ?? "",
		title: "Home",
		slug: "home",
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	const { script } = await staff.api.scripts.saveDraft({ siteId, entryId: null, code: "window.motionKit.start();" });
	await staff.api.scripts.publish({ siteId, scriptId: script.id });
	return { siteId, url: (path: string) => `https://${slug}.live.test${path}` };
}

/** The script tags of a page's <head>, in order. */
function headScripts(html: string): string[] {
	return [...headOf(html).matchAll(/<script\b[^>]*><\/script>/g)].map((match) => match[0]);
}

describe("adding a Library from the registry", () => {
	test("is downloaded once, checked, and served from the Site as a hashed file, before the Site script", async () => {
		const site = await newSite();
		const before = install.http.requests.length;

		const { library } = await staff.api.libraries.add({
			siteId: site.siteId,
			library: { source: "npm", packageName: "Motion-Kit", version: "3.13" },
		});

		expect(library).toMatchObject({
			source: "npm",
			name: "motion-kit",
			packageName: "motion-kit",
			version: "3.13.0",
			file: "dist/motion-kit.min.js",
			url: null,
			integrity: integrityOf(CORE),
			size: CORE.length,
			licence: "MIT",
			latestVersion: "3.13.0",
			newerVersion: null,
		});
		expect(library.src).toMatch(/^\/_wc\/lib\/[0-9a-f]{16}-motion-kit\.min\.js$/);
		const calls = install.http.requests.slice(before);
		expect(calls.every((call) => new URL(call.url).hostname === NPM_HOST)).toBe(true);
		expect(calls.filter((call) => call.url.endsWith(".tgz"))).toHaveLength(1);

		const page = await install.request(site.url("/"));
		const html = await expectSafePage(page.clone());
		const scripts = headScripts(html);
		expect(scripts[0]).toBe(`<script src="${library.src}" integrity="${integrityOf(CORE)}" defer></script>`);
		expect(scripts[1]).toMatch(/^<script src="\/_wc\/js\/[0-9a-f]{16}\.js" defer><\/script>$/);
		// Served from the Site: the policy names no outside host for it.
		expect(policyOf(page).get("script-src")).toEqual(["'self'"]);

		const file = await install.request(site.url(library.src));
		expect(file.status).toBe(200);
		expectSiteHeaders(file);
		expect(file.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(await file.text()).toBe(CORE);
		const etag = file.headers.get("etag") ?? "";
		expect((await install.request(site.url(library.src), { headers: { "if-none-match": etag } })).status).toBe(304);

		// Kept in the Install's storage, in the Site's folder: pages never reach the registry.
		const folder = join(install.storageDir, workspaceId, site.siteId, "libraries");
		expect(readdirSync(folder)).toEqual([library.src.slice("/_wc/lib/".length)]);
		const after = install.http.requests.length;
		await install.request(site.url("/"));
		await install.request(site.url(library.src));
		expect(install.http.requests.length).toBe(after);
	});

	test("a plugin is its own Library: a file of the package, at a tag, after the ones added before", async () => {
		const site = await newSite();
		const core = (
			await staff.api.libraries.add({
				siteId: site.siteId,
				library: { source: "npm", packageName: "motion-kit", version: "3.13.0" },
			})
		).library;
		const { library: plugin } = await staff.api.libraries.add({
			siteId: site.siteId,
			library: { source: "npm", packageName: "motion-kit", version: "latest", file: "./dist/plugins/scroll.min.js" },
		});
		expect(plugin).toMatchObject({
			version: "3.13.0",
			file: "dist/plugins/scroll.min.js",
			integrity: integrityOf(SCROLL),
		});
		expect(plugin.src).toMatch(/-scroll\.min\.js$/);

		expect((await staff.api.libraries.list({ siteId: site.siteId })).libraries.map((library) => library.id)).toEqual([
			core.id,
			plugin.id,
		]);
		const html = await (await install.request(site.url("/"))).text();
		expect(headScripts(html).slice(0, 2)).toEqual([
			`<script src="${core.src}" integrity="${core.integrity}" defer></script>`,
			`<script src="${plugin.src}" integrity="${plugin.integrity}" defer></script>`,
		]);
	});

	test("what isn't a package, a version or a file of it, or doesn't match its integrity hash, is refused and nothing is kept", async () => {
		const site = await newSite();
		fakeNpmPackage(install, "tampered-kit", { "1.0.0": { files: { "index.js": "ok()" }, tampered: true } });
		fakeNpmPackage(install, "huge-kit", { "1.0.0": { files: { "index.js": "x".repeat(5 * 1024 * 1024 + 1) } } });
		const refusal = (library: Parameters<TestBrowser["api"]["libraries"]["add"]>[0]["library"]) =>
			staff.api.libraries.add({ siteId: site.siteId, library }).then(
				() => "added",
				(error: { code: string; data?: { problem?: string } }) => `${error.code} ${error.data?.problem ?? ""}`,
			);

		expect(await refusal({ source: "npm", packageName: "Not A Name", version: "1.0.0" })).toBe("LIBRARY_REFUSED name");
		expect(await refusal({ source: "npm", packageName: "motion-kit", version: "^3.0" })).toBe(
			"LIBRARY_REFUSED version",
		);
		expect(await refusal({ source: "npm", packageName: "motion-kit", version: "9.9.9" })).toBe(
			"LIBRARY_REFUSED notFound",
		);
		expect(await refusal({ source: "npm", packageName: "motion-kit", version: "4" })).toBe("LIBRARY_REFUSED notFound");
		expect(
			await refusal({ source: "npm", packageName: "motion-kit", version: "3.13.0", file: "../etc/passwd.js" }),
		).toBe("LIBRARY_REFUSED file");
		expect(
			await refusal({ source: "npm", packageName: "motion-kit", version: "3.13.0", file: "dist/missing.js" }),
		).toBe("LIBRARY_REFUSED fileNotFound");
		expect(await refusal({ source: "npm", packageName: "tampered-kit", version: "1.0.0" })).toBe(
			"LIBRARY_REFUSED integrity",
		);
		expect(await refusal({ source: "npm", packageName: "huge-kit", version: "1.0.0" })).toBe("LIBRARY_REFUSED size");
		expect(await refusal({ source: "npm", packageName: "nobody-has-this", version: "1.0.0" })).toBe(
			"LIBRARY_REFUSED unreachable",
		);
		expect((await staff.api.libraries.list({ siteId: site.siteId })).libraries).toEqual([]);
	});
});

describe("adding a Library by address", () => {
	test("is downloaded once through the guarded fetcher and served from the Site", async () => {
		const site = await newSite();
		install.dns.answer("cdn.example.org", ["93.184.215.14"]);
		const code = "window.slider = {};";
		install.http.respond("GET", "https://cdn.example.org/slider/2.1/slider.umd.js", { body: code });

		const { library } = await staff.api.libraries.add({
			siteId: site.siteId,
			library: { source: "url", url: "https://cdn.example.org/slider/2.1/slider.umd.js" },
		});

		expect(library).toMatchObject({
			source: "url",
			name: "slider.umd.js",
			version: null,
			integrity: integrityOf(code),
		});
		const page = await install.request(site.url("/"));
		expect(headScripts(await page.clone().text())[0]).toBe(
			`<script src="${library.src}" integrity="${library.integrity}" defer></script>`,
		);
		expect(policyOf(page).get("script-src")).toEqual(["'self'"]);
		expect(await (await install.request(site.url(library.src))).text()).toBe(code);
	});

	test("an address inside the server's network, or not https, is refused", async () => {
		const site = await newSite();
		install.dns.answer("intranet.example.org", ["10.0.0.5"]);
		await expect(
			staff.api.libraries.add({
				siteId: site.siteId,
				library: { source: "url", url: "https://intranet.example.org/a.js" },
			}),
		).rejects.toMatchObject({ code: "LIBRARY_REFUSED", data: { problem: "unreachable" } });
		await expect(
			staff.api.libraries.add({ siteId: site.siteId, library: { source: "url", url: "http://cdn.example.org/a.js" } }),
		).rejects.toMatchObject({ code: "LIBRARY_REFUSED", data: { problem: "url" } });
	});
});

describe("a Site's Libraries", () => {
	test("two added at once never take a Site past its limit", async () => {
		const site = await newSite();
		install.dns.answer("libs.example.org", ["93.184.215.20"]);
		install.http.respond("GET", /^https:\/\/libs\.example\.org\/lib-\d+\.js$/, (request) => ({
			body: `window.lib = ${JSON.stringify(new URL(request.url).pathname)};`,
		}));
		const add = (index: number) =>
			staff.api.libraries.add({
				siteId: site.siteId,
				library: { source: "url", url: `https://libs.example.org/lib-${index}.js` },
			});
		for (let index = 0; index < LIBRARIES_PER_SITE - 1; index++) await add(index);
		// The last two downloads answer only once both have started, so both adds are under way at once.
		let started = 0;
		let bothStarted: () => void = () => {};
		const together = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		install.http.respond("GET", /^https:\/\/libs\.example\.org\/last-\d+\.js$/, async (request) => {
			if (++started === 2) bothStarted();
			await together;
			return { body: `window.last = ${JSON.stringify(new URL(request.url).pathname)};` };
		});
		const last = (index: number) =>
			staff.api.libraries.add({
				siteId: site.siteId,
				library: { source: "url", url: `https://libs.example.org/last-${index}.js` },
			});

		const results = await Promise.allSettled([last(1), last(2)]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			reason: { code: "LIBRARY_REFUSED", data: { problem: "limit" } },
		});
		expect((await staff.api.libraries.list({ siteId: site.siteId })).libraries).toHaveLength(LIBRARIES_PER_SITE);
	});

	test("a package whose archive unpacks to more than WebCraft reads is refused, however small it is", async () => {
		const site = await newSite();
		fakeNpmPackage(install, "padded-kit", {
			"1.0.0": { files: { "index.js": "ok()", "padding.txt": "0".repeat(LIBRARY_ARCHIVE_UNPACKED_MAX_BYTES) } },
		});

		await expect(
			staff.api.libraries.add({
				siteId: site.siteId,
				library: { source: "npm", packageName: "padded-kit", version: "1.0.0" },
			}),
		).rejects.toMatchObject({ code: "LIBRARY_REFUSED", data: { problem: "size" } });
		expect((await staff.api.libraries.list({ siteId: site.siteId })).libraries).toEqual([]);
	});
});

describe("Library updates", () => {
	test("checking says which can be updated; nothing changes until Staff update one", async () => {
		const site = await newSite();
		const kit = fakeNpmPackage(install, "tween-kit", { "1.0.0": { files: { "index.js": "tween(1)" } } });
		const { library } = await staff.api.libraries.add({
			siteId: site.siteId,
			library: { source: "npm", packageName: "tween-kit", version: "1.0.0" },
		});
		kit.publish("1.1.0", { files: { "index.js": "tween(1.1)" } });

		const [checked] = (await staff.api.libraries.checkUpdates({ siteId: site.siteId })).libraries;
		expect(checked).toMatchObject({
			version: "1.0.0",
			latestVersion: "1.1.0",
			newerVersion: "1.1.0",
			src: library.src,
		});
		expect(headScripts(await (await install.request(site.url("/"))).text())[0]).toContain(library.src);

		const { library: updated } = await staff.api.libraries.update({ siteId: site.siteId, libraryId: library.id });
		expect(updated).toMatchObject({
			id: library.id,
			version: "1.1.0",
			newerVersion: null,
			integrity: integrityOf("tween(1.1)"),
		});
		expect(updated.src).not.toBe(library.src);
		expect(headScripts(await (await install.request(site.url("/"))).text())[0]).toBe(
			`<script src="${updated.src}" integrity="${updated.integrity}" defer></script>`,
		);
		// A page loaded before the update still finds its file.
		expect(await (await install.request(site.url(library.src))).text()).toBe("tween(1)");

		// Back to an older version, when Staff ask for one.
		const { library: back } = await staff.api.libraries.update({
			siteId: site.siteId,
			libraryId: library.id,
			version: "1.0.0",
		});
		expect(back).toMatchObject({ version: "1.0.0", src: library.src, newerVersion: "1.1.0" });
	});

	test("removing one takes it off every page", async () => {
		const site = await newSite();
		const { library } = await staff.api.libraries.add({
			siteId: site.siteId,
			library: { source: "npm", packageName: "motion-kit", version: "3.13.0" },
		});
		await staff.api.libraries.remove({ siteId: site.siteId, libraryId: library.id });
		expect((await install.request(site.url("/")).then((page) => page.text())).includes(library.src)).toBe(false);
		await expect(staff.api.libraries.remove({ siteId: site.siteId, libraryId: library.id })).rejects.toMatchObject({
			code: "LIBRARY_NOT_FOUND",
		});
	});

	test("only Staff manage them; each change is in the Audit log", async () => {
		const site = await newSite();
		const npm = { source: "npm" as const, packageName: "motion-kit", version: "3.13.0" };
		const { library } = await staff.api.libraries.add({ siteId: site.siteId, library: npm });
		for (const call of [
			() => editor.api.libraries.list({ siteId: site.siteId }),
			() => editor.api.libraries.add({ siteId: site.siteId, library: npm }),
			() => editor.api.libraries.checkUpdates({ siteId: site.siteId }),
			() => editor.api.libraries.update({ siteId: site.siteId, libraryId: library.id }),
			() => editor.api.libraries.remove({ siteId: site.siteId, libraryId: library.id }),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}

		await staff.api.libraries.update({ siteId: site.siteId, libraryId: library.id, version: "3.12.0" });
		await staff.api.libraries.remove({ siteId: site.siteId, libraryId: library.id });
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 10 });
		const ours = entries.filter((entry) => entry.siteId === site.siteId);
		expect(ours.map((entry) => entry.action).slice(0, 3)).toEqual(["library.remove", "library.update", "library.add"]);
		expect(ours[1]?.details).toMatchObject({ name: "motion-kit", from: "3.13.0", to: "3.12.0" });
	});
});

// Last in the file: it moves the clock past every session.
describe("replaced Library files", () => {
	test("are served for 30 days, then removed from storage", async () => {
		const site = await newSite();
		const { library } = await staff.api.libraries.add({
			siteId: site.siteId,
			library: { source: "npm", packageName: "motion-kit", version: "3.13.0" },
		});
		await staff.api.libraries.update({ siteId: site.siteId, libraryId: library.id, version: "3.12.0" });
		const folder = join(install.storageDir, workspaceId, site.siteId, "libraries");
		expect(readdirSync(folder)).toHaveLength(2);

		await install.clock.advance(29 * 24 * 60 * 60 * 1000);
		expect((await install.drainJobs()).failed).toEqual([]);
		expect((await install.request(site.url(library.src))).status).toBe(200);

		await install.clock.advance(2 * 24 * 60 * 60 * 1000);
		expect((await install.drainJobs()).failed).toEqual([]);
		expect((await install.request(site.url(library.src))).status).toBe(404);
		expect(readdirSync(folder)).toHaveLength(1);
	});
});
