// The shell's code in files of its own (BA-30): the file the shell's document loads imports nothing at
// once, and names the rest of the shell's files (each place's, the Media picker's, the parts they
// share) only for when they are needed. Every one of them is served from the Site's address as the
// shell's first file is: hashed, kept a year, with nothing about the Site or the person in it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

/** The files a file of the shell's names: those it imports at once, and those it imports when asked. */
function namedIn(code: string): { now: string[]; later: string[] } {
	const now = [...code.matchAll(/\bfrom\s*"\.\/([^"]+\.js)"/g), ...code.matchAll(/\bimport\s*"\.\/([^"]+\.js)"/g)];
	const later = [...code.matchAll(/\bimport\(\s*"\.\/([^"]+\.js)"\s*\)/g)];
	return { now: now.map((match) => match[1] ?? ""), later: later.map((match) => match[1] ?? "") };
}

describe("the shell's files", () => {
	test("the first file imports nothing at once, and each place and the Media picker are files of their own", async () => {
		const building = await openBuildingArea(install, staff, siteId);
		const html = await (await building.shell("/_webcraft/build/page/")).text();
		const first = /src="\/_webcraft\/edit\/assets\/(shell-[0-9a-f]{16}\.js)"/.exec(html)?.[1] ?? "";
		const code = await (await building.browser.request(`${building.origin}/_webcraft/edit/assets/${first}`)).text();

		const { now, later } = namedIn(code);
		expect(now).toEqual([]);
		expect(later.map((name) => name.replace(/-[0-9a-f]{16}\.js$/, "")).sort()).toEqual(
			[
				"shell-ComponentsPlace",
				"shell-ContentPlace",
				"shell-FormsPlace",
				"shell-LoopsPlace",
				"shell-MediaPlace",
				"shell-Picker",
				"shell-StylesPlace",
				"shell-TemplatesPlace",
			].sort(),
		);
	});

	test("every file the shell may load is served as its first file is, hashed and kept a year, to anyone", async () => {
		const building = await openBuildingArea(install, editor, siteId);
		const html = await (await building.shell("/_webcraft/build/page/")).text();
		const first = /src="\/_webcraft\/edit\/assets\/(shell-[0-9a-f]{16}\.js)"/.exec(html)?.[1] ?? "";
		// A browser with no session at all: the files hold nothing about the Site or the person.
		const anyone = install.browser({ origin: building.origin });

		const seen = new Set<string>();
		const waiting = [first];
		while (waiting.length > 0) {
			const name = waiting.pop() ?? "";
			if (seen.has(name)) continue;
			seen.add(name);
			expect(name).toMatch(/^shell-([A-Za-z]+-)?[0-9a-f]{16}\.js$/);
			const file = await anyone.request(`${building.origin}/_webcraft/edit/assets/${name}`);
			expect({ name, status: file.status }).toEqual({ name, status: 200 });
			expect(file.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
			expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
			const { now, later } = namedIn(await file.text());
			waiting.push(...now, ...later);
		}
		// The first file, eight files of their own and the parts they share.
		expect(seen.size).toBeGreaterThan(9);
		const head = await anyone.request(`${building.origin}/_webcraft/edit/assets/${first}`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(
			(await anyone.request(`${building.origin}/_webcraft/edit/assets/shell-ContentPlace-0000000000000000.js`)).status,
		).toBe(404);
	});
});
