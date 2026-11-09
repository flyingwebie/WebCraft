// After the event (ADR 0024, story 151): Modules react to what happens on a Site as background jobs,
// so a Module that fails never blocks saving or publishing; its failures go to the Module log.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { SAMPLE_HOOK, sample } from "./sample/index.ts";

const MINUTE = 60_000;

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	await (await install.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	workspaceId = (await install.createWorkspace()).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

beforeEach(async () => {
	// Whatever an earlier test left queued runs now, so each test sees only its own jobs.
	await install.clock.advance(60 * MINUTE);
	await install.drainJobs();
	install.dns.answer("hooks.sample.example", ["93.184.216.34"]);
	install.http.respond("POST", SAMPLE_HOOK, { status: 204 });
});

afterAll(async () => {
	await install.close();
});

const notes = (browser: TestBrowser) => moduleApi<typeof sample>(browser, "sample").notes;

/** A Site with a published Entry template, and a Draft Entry ready to publish. */
async function siteWithEntry() {
	const site = await install.createSite(workspaceId);
	const { postType } = await staff.api.postTypes.create({
		siteId: site.id,
		name: "Posts",
		urlPattern: "/posts/{slug}",
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: site.id,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId: site.id, templateId: template.id });
	const { entry } = await staff.api.entries.create({ siteId: site.id, postTypeId: postType.id, title: "Hello" });
	return { siteId: site.id, slug: site.slug, entryId: entry.id };
}

const hookCalls = () => install.http.requests.filter((request) => request.url === SAMPLE_HOOK);

type LoggedError = { name?: string; reason?: string; message: string };

/** The error the newest line of the sample's Module log records. */
async function lastError(admin?: TestBrowser): Promise<LoggedError> {
	const { lines } = await (admin ?? (await install.superadmin())).api.modules.log({ moduleId: "sample" });
	return (lines[0]?.details.error ?? { message: "" }) as LoggedError;
}

describe("events", () => {
	test("reach a Module after the change is saved, as a background job, acting as itself", async () => {
		const { siteId, entryId } = await siteWithEntry();
		const before = hookCalls().length;

		await staff.api.entries.publish({ siteId, entryId });

		expect((await notes(staff).list({ siteId })).notes).toEqual([]);
		const report = await install.drainJobs();
		expect(report.failed).toEqual([]);
		expect((await notes(staff).list({ siteId })).notes).toEqual([
			expect.objectContaining({ body: `Entry ${entryId} was published.`, source: "module" }),
		]);
		const calls = hookCalls().slice(before);
		expect(calls.map((call) => JSON.parse(call.body))).toEqual([{ entryId, siteId }]);
		expect(calls[0]?.headers.get("authorization")).toBeNull();
		const { entries } = await (await install.superadmin()).api.audit.list();
		expect(entries[0]).toMatchObject({
			action: "sample.note.add",
			personId: null,
			via: { kind: "module", name: "sample" },
			siteId,
			details: { entryId },
		});
	});

	test("tell a Module where a published Entry is, and which published paths the publish changed", async () => {
		const { siteId, entryId } = await siteWithEntry();
		const postTypeId = (await staff.api.entries.get({ siteId, entryId })).entry.postTypeId;
		await staff.api.entries.publish({ siteId, entryId });
		await staff.api.entries.saveDraft({ siteId, entryId, slug: "hello-again" });
		await install.drainJobs();

		await staff.api.entries.publish({ siteId, entryId });
		await install.drainJobs();

		const { lines } = await (await install.superadmin()).api.modules.log({ moduleId: "sample", limit: 200 });
		const heard = lines.filter(
			(line) => line.message === "Heard that an Entry was published." && line.siteId === siteId,
		);
		expect(heard.map((line) => line.details)).toEqual([
			{
				entryId,
				postTypeId,
				path: "/posts/hello-again",
				pathChanges: [{ entryId, language: "en", from: "/posts/hello", to: "/posts/hello-again" }],
			},
			{ entryId, postTypeId, path: "/posts/hello", pathChanges: [] },
		]);
	});

	test("never block a publish when the Module fails: the failure goes to the Module log and is tried again", async () => {
		const { siteId, slug, entryId } = await siteWithEntry();
		install.http.respond("POST", SAMPLE_HOOK, { status: 500 });

		await staff.api.entries.publish({ siteId, entryId });

		expect((await install.request(`https://${slug}.sites.test/posts/hello`)).status).toBe(200);
		const first = await install.drainJobs();
		expect(first.failed.map((job) => job.name)).toEqual(["modules.event"]);
		const admin = await install.superadmin();
		expect((await admin.api.modules.log({ moduleId: "sample" })).lines[0]).toMatchObject({
			level: "error",
			message: "The event entry.published failed.",
			siteId,
			details: { event: "entry.published", error: { message: "The hook answered 500." } },
		});

		install.http.respond("POST", SAMPLE_HOOK, { status: 204 });
		await install.clock.advance(5 * MINUTE);
		// Only the Module's events: moving the clock also brings scheduled jobs (domain checks) due.
		const retried = await install.drainJobs({ only: ["modules.event"] });
		expect(retried.completed.map((job) => job.name)).toEqual(["modules.event"]);
	});

	test("reach a Module only where it is on", async () => {
		const { siteId, entryId } = await siteWithEntry();
		await staff.api.modules.setOnSite({ siteId, moduleId: "sample", on: false });
		const before = hookCalls().length;

		await staff.api.entries.publish({ siteId, entryId });
		const report = await install.drainJobs();

		expect(report.failed).toEqual([]);
		expect(hookCalls().length).toBe(before);
		await staff.api.modules.setOnSite({ siteId, moduleId: "sample", on: true });
		expect((await notes(staff).list({ siteId })).notes).toEqual([]);
	});

	test("aren't sent for a change that was rolled back", async () => {
		const { siteId, entryId } = await siteWithEntry();
		// A required Field left empty: the publish is refused, nothing is saved.
		const postTypeId = (await staff.api.entries.get({ siteId, entryId })).entry.postTypeId;
		await staff.api.postTypes.update({
			siteId,
			postTypeId,
			fields: [{ key: "summary", label: "Summary", type: "text", required: true }],
		});

		await expect(staff.api.entries.publish({ siteId, entryId })).rejects.toMatchObject({ code: "ENTRY_INCOMPLETE" });
		const report = await install.drainJobs();

		expect(report.completed.filter((job) => job.name === "modules.event")).toEqual([]);
	});
});

describe("a Module's own jobs", () => {
	test("run in the background, when they are due, in the place they were queued from", async () => {
		const site = await install.createSite(workspaceId);
		const { note } = await notes(staff).add({ siteId: site.id, body: "Remind me" });

		await notes(staff).remind({ siteId: site.id, noteId: note.id, delaySeconds: 3600 });
		expect((await install.drainJobs()).completed.map((job) => job.name)).not.toContain("modules.job");

		await install.clock.advance(61 * MINUTE);
		expect((await install.drainJobs()).completed.map((job) => job.name)).toContain("modules.job");
		const { lines } = await (await install.superadmin()).api.modules.log({ moduleId: "sample" });
		expect(lines[0]).toMatchObject({
			level: "info",
			message: "Reminded about a note.",
			siteId: site.id,
			details: { noteId: note.id, found: true },
		});
	});

	test("queued in a change that was rolled back never run", async () => {
		const site = await install.createSite(workspaceId);
		const { note } = await notes(staff).add({ siteId: site.id, body: "Remind me, or not" });

		await expect(
			notes(staff).remind({ siteId: site.id, noteId: note.id, delaySeconds: 0, giveUp: true }),
		).rejects.toMatchObject({ code: "MODULE_ERROR", status: 409, data: { code: "gave-up" } });

		await install.clock.advance(MINUTE);
		expect((await install.drainJobs()).completed.map((job) => job.name)).not.toContain("modules.job");
	});
});

describe("outside calls", () => {
	test("carry the Module's secrets only as WebCraft fills them in, and the secret is never shown", async () => {
		const { siteId, entryId } = await siteWithEntry();
		const settings = moduleApi<typeof sample>(staff, "sample").settings;

		const { token } = await settings.setHookToken({ siteId, token: "a-hook-token-0123456789-wxyz" });
		expect(token).toEqual({ set: true, lastFour: "wxyz", updatedAt: expect.any(Date) });

		const before = hookCalls().length;
		await staff.api.entries.publish({ siteId, entryId });
		await install.drainJobs();
		expect(hookCalls()[before]?.headers.get("authorization")).toBe("Bearer a-hook-token-0123456789-wxyz");
	});

	test("carry a secret in the address too, written so it can't change the address", async () => {
		const site = await install.createSite(workspaceId);
		const settings = moduleApi<typeof sample>(staff, "sample").settings;
		await settings.setHookToken({ siteId: site.id, token: "a token/with?odd&chars#0123" });
		install.http.respond("GET", /^https:\/\/hooks\.sample\.example\/check\//, { status: 204 });
		const before = install.http.requests.length;

		expect(await settings.checkHook({ siteId: site.id })).toEqual({ status: 204, seen: null });

		const token = "a%20token%2Fwith%3Fodd%26chars%230123";
		expect(install.http.requests.slice(before).map((request) => request.url)).toEqual([
			`https://hooks.sample.example/check/${token}?token=${token}`,
		]);
	});

	test("that fail never hand the secret back to the Module, in the error or anything behind it", async () => {
		const site = await install.createSite(workspaceId);
		const settings = moduleApi<typeof sample>(staff, "sample").settings;
		await settings.setHookToken({ siteId: site.id, token: "never-shown-token-0123456789" });
		// The call fails the way an unreachable host does, with an error naming the address.
		install.http.respond("GET", /^https:\/\/hooks\.sample\.example\/check\//, (request) => {
			throw new Error(`Unable to connect to ${request.url}`);
		});

		const { status, seen } = await settings.checkHook({ siteId: site.id });

		expect(status).toBeNull();
		expect(seen?.join("\n")).toContain("didn't answer");
		expect(seen?.join("\n")).not.toContain("never-shown-token");
	});

	test("that carry a secret never follow a redirect", async () => {
		const { siteId, entryId } = await siteWithEntry();
		await moduleApi<typeof sample>(staff, "sample").settings.setHookToken({
			siteId,
			token: "another-token-abcdefghij",
		});
		install.http.respond("POST", SAMPLE_HOOK, {
			status: 307,
			headers: { location: "https://hooks.sample.example/moved" },
		});
		const before = install.http.requests.length;

		await staff.api.entries.publish({ siteId, entryId });
		await install.drainJobs();

		expect(install.http.requests.slice(before).map((request) => request.url)).toEqual([SAMPLE_HOOK]);
		const { lines } = await (await install.superadmin()).api.modules.log({ moduleId: "sample" });
		expect(lines[0]?.details).toMatchObject({ error: { message: "The hook answered 307." } });
	});

	test("are refused when the declared host resolves inside the server's network, before anything is sent", async () => {
		const { siteId, entryId } = await siteWithEntry();
		install.dns.answer("hooks.sample.example", ["10.0.0.5"]);
		const before = hookCalls().length;

		await staff.api.entries.publish({ siteId, entryId });
		const report = await install.drainJobs();

		expect(hookCalls().length).toBe(before);
		// A refusal is never tried again: the Module must change.
		expect(report.failed).toEqual([]);
		const error = await lastError();
		expect(error).toMatchObject({ name: "ModuleRefusedError", reason: "host" });
		expect(error.message).toContain("inside the server's network");
	});

	test("check the address again after every redirect", async () => {
		const twoHosts = {
			...sample,
			manifest: { ...sample.manifest, outsideHosts: ["hooks.sample.example", "internal.sample.example"] },
		};
		const other = await createTestInstall({ modules: [twoHosts] });
		try {
			const admin = await other.superadmin();
			await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
			const site = await other.createSite((await other.createWorkspace()).id);
			const { postType } = await admin.api.postTypes.create({
				siteId: site.id,
				name: "Posts",
				urlPattern: "/p/{slug}",
			});
			const { entry } = await admin.api.entries.create({ siteId: site.id, postTypeId: postType.id, title: "Hi" });
			other.dns.answer("hooks.sample.example", ["93.184.216.34"]);
			other.dns.answer("internal.sample.example", ["192.168.1.10"]);
			other.http.respond("POST", SAMPLE_HOOK, {
				status: 302,
				headers: { location: "https://internal.sample.example/admin" },
			});

			await admin.api.entries.publish({ siteId: site.id, entryId: entry.id });
			await other.drainJobs();

			expect(other.http.requests.map((request) => request.url)).not.toContain("https://internal.sample.example/admin");
			const error = await lastError(admin);
			expect(error.reason).toBe("host");
			expect(error.message).toContain("192.168.1.10");
		} finally {
			await other.close();
		}
	});

	test("connect to the address that was checked, though DNS answers otherwise when the connection is made", async () => {
		const { siteId, entryId } = await siteWithEntry();
		// DNS rebinding: a public address for the check, then one inside the server's network.
		install.dns.answerInTurn("hooks.sample.example", [["93.184.216.34"], ["10.0.0.5"]]);
		const before = hookCalls().length;

		await staff.api.entries.publish({ siteId, entryId });
		await install.drainJobs();

		const connectedTo = hookCalls()
			.slice(before)
			.map((call) => call.address);
		expect(connectedTo).toEqual(["93.184.216.34"]);
	});

	test("connect, after a redirect, to the address checked for that hop", async () => {
		const { siteId, entryId } = await siteWithEntry();
		install.dns.answerInTurn("hooks.sample.example", [["93.184.216.34"], ["93.184.216.35"], ["10.0.0.5"]]);
		install.http.respond("POST", SAMPLE_HOOK, { status: 307, headers: { location: "/moved" } });
		install.http.respond("POST", "https://hooks.sample.example/moved", { status: 204 });
		const before = install.http.requests.length;

		await staff.api.entries.publish({ siteId, entryId });
		await install.drainJobs();

		expect(install.http.requests.slice(before).map((call) => [call.url, call.address])).toEqual([
			[SAMPLE_HOOK, "93.184.216.34"],
			["https://hooks.sample.example/moved", "93.184.216.35"],
		]);
	});

	test("follow at most 3 redirects", async () => {
		const { siteId, entryId } = await siteWithEntry();
		install.http.respond("POST", SAMPLE_HOOK, { status: 302, headers: { location: "/hop" } });
		install.http.respond("GET", "https://hooks.sample.example/hop", {
			status: 302,
			headers: { location: "https://hooks.sample.example/hop" },
		});
		const before = install.http.requests.length;

		await staff.api.entries.publish({ siteId, entryId });
		await install.drainJobs();

		expect(install.http.requests.length - before).toBe(4);
		const error = await lastError();
		expect(error.name).toBe("GuardedFetchError");
		expect(error.message).toContain("More than 3 redirects");
	});

	test("give up on an answer that is too large, or too slow", async () => {
		const { siteId, entryId } = await siteWithEntry();
		install.http.respond("POST", SAMPLE_HOOK, { status: 200, body: "x".repeat(5 * 1024 * 1024 + 1) });

		await staff.api.entries.publish({ siteId, entryId });
		await install.drainJobs();
		expect((await lastError()).message).toContain("larger than");

		install.http.respond("POST", SAMPLE_HOOK, () => new Promise(() => {}));
		await install.clock.advance(5 * MINUTE);
		await install.drainJobs();
		expect((await lastError()).message).toContain("No answer within 2000 ms");
	});
});

describe("email", () => {
	test("goes out through WebCraft's email, in the Module's words, recorded in the Email log", async () => {
		const site = await install.createSite(workspaceId);
		const { note } = await notes(staff).add({ siteId: site.id, body: "The van arrives at 9." });

		const { results } = await notes(staff).share({ siteId: site.id, noteId: note.id, email: "driver@client.example" });

		expect(results).toEqual([{ recipient: "driver@client.example", status: "logged" }]);
		const email = await install.lastEmailTo("driver@client.example");
		expect(email.subject).toBe("A note for you");
		expect(email.text).toContain("The van arrives at 9.");
		expect(email.text).toContain("Sent by the Sample notes Module.");
		const { lines } = await (await install.superadmin()).api.install.emailLog.list({});
		expect(lines[0]).toMatchObject({
			type: "module-message",
			category: "work",
			related: { kind: "module", id: "sample" },
		});
	});

	test("is refused to a Module that doesn't declare it uses email", async () => {
		const quiet = await createTestInstall({ modules: [{ ...sample, manifest: { ...sample.manifest, uses: [] } }] });
		try {
			const admin = await quiet.superadmin();
			await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
			const site = await quiet.createSite((await quiet.createWorkspace()).id);
			const { note } = await notes(admin).add({ siteId: site.id, body: "Hush" });

			await expect(
				notes(admin).share({ siteId: site.id, noteId: note.id, email: "someone@client.example" }),
			).rejects.toMatchObject({ code: "MODULE_FAILED" });
			const { lines } = await admin.api.modules.log({ moduleId: "sample" });
			expect(lines[0]?.details).toMatchObject({ error: { name: "ModuleRefusedError", reason: "use" } });
		} finally {
			await quiet.close();
		}
	});
});
