// The update check: once a day the worker reads a public release feed (the project's latest-release
// JSON unless WEBCRAFT_UPDATE_FEED says otherwise, `off` turns it off), sending nothing about the
// Install, and the Superadmin sees "Update available" when a newer release is out.
// `webcraft admin check-update` reads it at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_UPDATE_FEED, WEBCRAFT_VERSION } from "@webcraft/core";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

/** The next minor release after this build's version. */
function nextMinor(version: string): string {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return `${major}.${minor + 1}.0`;
}

const NEWER = nextMinor(WEBCRAFT_VERSION);

/** A release as GitHub's API describes it. */
const githubRelease = (version: string, extra: Record<string, unknown> = {}) => ({
	tag_name: `v${version}`,
	name: `WebCraft ${version}`,
	html_url: `https://github.com/flyingwebie/WebCraft/releases/tag/v${version}`,
	body: "## What's new\r\n\r\n- Scheduled Backups",
	published_at: "2026-03-01T12:00:00Z",
	draft: false,
	prerelease: false,
	...extra,
});

/** Moves the clock past the next 05:29 UTC, when the daily check runs, and runs the worker's jobs. */
async function nextMorning(install: TestInstall) {
	const now = install.clock.now();
	const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 6, 0);
	await install.clock.advance(next - now.getTime());
	expect((await install.drainJobs()).failed).toEqual([]);
}

function feedRequests(install: TestInstall, feed: string) {
	return install.http.requests.filter((request) => request.url === feed);
}

describe("with the project's release feed", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall();
		install.dns.answer("api.github.com", ["140.82.112.6"]);
		install.http.respond("GET", DEFAULT_UPDATE_FEED, { body: JSON.stringify(githubRelease(NEWER)) });
	});

	afterAll(async () => {
		await install.close();
	});

	test("nothing is known before the first check", async () => {
		const admin = await install.superadmin();
		expect((await admin.api.shell.context()).banners.update).toBeNull();
		expect(await admin.api.install.updates.get()).toMatchObject({
			running: WEBCRAFT_VERSION,
			enabled: true,
			checkedAt: null,
			latest: null,
			updateAvailable: false,
		});
	});

	test("the daily check finds a newer release, and the Superadmin sees it with its release notes", async () => {
		await nextMorning(install);

		const admin = await install.superadmin();
		expect((await admin.api.shell.context()).banners.update).toEqual({
			version: NEWER,
			running: WEBCRAFT_VERSION,
			url: `https://github.com/flyingwebie/WebCraft/releases/tag/v${NEWER}`,
		});
		expect(await admin.api.install.updates.get()).toMatchObject({
			updateAvailable: true,
			latest: { version: NEWER, notes: "## What's new\n\n- Scheduled Backups" },
			problem: null,
		});
	});

	test("the request says nothing about the Install: no id, no version, no cookie, a plain User-Agent", () => {
		const [request] = feedRequests(install, DEFAULT_UPDATE_FEED);
		expect(request?.method).toBe("GET");
		expect(request?.url).toBe(DEFAULT_UPDATE_FEED);
		expect(request?.body).toBe("");
		expect(Object.fromEntries(request?.headers ?? [])).toEqual({
			"user-agent": "WebCraft",
			accept: "application/json",
		});
	});

	test("the feed is read at most once a day", async () => {
		await install.clock.advance(3 * 60 * 60 * 1000);
		await install.drainJobs();
		expect(feedRequests(install, DEFAULT_UPDATE_FEED)).toHaveLength(1);

		await nextMorning(install);
		expect(feedRequests(install, DEFAULT_UPDATE_FEED)).toHaveLength(2);
	});

	test("Staff don't see the notice: updating is the Superadmin's", async () => {
		const workspaceId = (await install.createWorkspace()).id;
		const { browser } = await install.createStaff({ workspaces: [workspaceId] });
		expect((await browser.api.shell.context()).banners.update).toBeNull();
	});

	test("check-update reads the feed at once; a feed that fails keeps what was found before", async () => {
		install.http.respond("GET", DEFAULT_UPDATE_FEED, { status: 502, body: "Bad gateway" });

		const check = await install.checkUpdate();

		expect(check).toMatchObject({ problem: "status", updateAvailable: true, latest: { version: NEWER } });
		expect(feedRequests(install, DEFAULT_UPDATE_FEED)).toHaveLength(3);
	});

	test("no notice once the running version is the newest, and drafts and pre-releases don't count", async () => {
		install.http.respond("GET", DEFAULT_UPDATE_FEED, {
			body: JSON.stringify([
				githubRelease(nextMinor(NEWER), { draft: true }),
				githubRelease(`${nextMinor(NEWER)}-rc.1`, { prerelease: true }),
				githubRelease(WEBCRAFT_VERSION),
			]),
		});

		const check = await install.checkUpdate();

		expect(check).toMatchObject({ updateAvailable: false, latest: { version: WEBCRAFT_VERSION }, problem: null });
		expect((await (await install.superadmin()).api.shell.context()).banners.update).toBeNull();
	});
});

test("another feed, such as a static file of an agency's own, can be named", async () => {
	const feed = "https://updates.agency.example/webcraft.json";
	const install = await createTestInstall({ updateFeed: feed });
	try {
		install.dns.answer("updates.agency.example", ["93.184.215.14"]);
		install.http.respond("GET", feed, {
			body: JSON.stringify({ version: NEWER, url: "https://updates.agency.example/notes", notes: "Tested by us." }),
		});

		expect(await install.checkUpdate()).toMatchObject({
			updateAvailable: true,
			latest: { version: NEWER, url: "https://updates.agency.example/notes", notes: "Tested by us." },
		});
	} finally {
		await install.close();
	}
});

test("turned off, the Install never calls out and shows no notice", async () => {
	const install = await createTestInstall({ updateFeed: null });
	try {
		await nextMorning(install);
		const check = await install.checkUpdate();

		expect(check).toMatchObject({ enabled: false, checkedAt: null, updateAvailable: false });
		expect(install.http.requests.filter((request) => request.url.startsWith("https://api.github.com/"))).toEqual([]);
		expect((await (await install.superadmin()).api.shell.context()).banners.update).toBeNull();
	} finally {
		await install.close();
	}
});

test("a feed on an internal address is refused by the guarded fetcher", async () => {
	const feed = "https://updates.internal.example/webcraft.json";
	const install = await createTestInstall({ updateFeed: feed });
	try {
		install.dns.answer("updates.internal.example", ["10.0.0.5"]);
		install.http.respond("GET", feed, { body: JSON.stringify({ version: NEWER }) });

		expect(await install.checkUpdate()).toMatchObject({ problem: "address", latest: null });
		expect(install.http.requests.filter((request) => request.url === feed)).toEqual([]);
	} finally {
		await install.close();
	}
});
