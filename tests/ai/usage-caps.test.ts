// What AI costs (ADR 0011): tokens and estimated cost recorded for every call, per Workspace and
// Site; a monthly cap, required on a shared key and optional on a Workspace's own; at 80% the
// Workspace's Owners and Staff are told, at 100% calls stop until the cap is raised or the month
// ends. Two calls at once can never both pass the cap.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const KEY = "sk-usage-test-key-0123456789abcdef";
/** $1,000 per million tokens, so 1,000 tokens cost $1 and the numbers stay readable. */
const PRICE = { input: 1000, output: 1000 };

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	// Near the end of a month, so a test can move into the next one within a session's life.
	install = await createTestInstall({ now: new Date("2026-11-28T10:00:00Z") });
	admin = await install.superadmin();
});

afterAll(async () => {
	await install.close();
});

type Place = Awaited<ReturnType<typeof workspace>>;

async function workspace() {
	const workspaceId = (await install.createWorkspace()).id;
	const sites = [(await install.createSite(workspaceId)).id, (await install.createSite(workspaceId)).id];
	const owner = await install.createMember({ workspaceId, role: "owner" });
	const staff = await install.createStaff({ workspaces: [workspaceId] });
	const images: Record<string, string> = {};
	for (const siteId of sites) {
		const { media } = await owner.browser.api.media.upload({
			siteId,
			file: upload(await photo({ width: 320, height: 240 }), "loaf.jpg"),
		});
		images[siteId] = media.id;
	}
	expect((await install.drainJobs()).failed).toEqual([]);
	return { workspaceId, sites, owner, staff, images };
}

/** Every description from now on uses `tokens` input tokens and nothing else. */
function describeUsing(tokens: number) {
	install.ai.answer(() => ({ text: "A loaf.", usage: { inputTokens: tokens, outputTokens: 0 } }));
}

function suggest(place: Place, siteId = place.sites[0] ?? "") {
	return place.owner.browser.api.media.suggestAltText({ siteId, mediaId: place.images[siteId] ?? "" });
}

/** The cap emails `address` got: no Install SMTP is set here, so they are written to the log. */
async function capEmails(address: string) {
	await install.drainJobs();
	return install.logs
		.map((entry) => entry.email as { to?: string; subject?: string } | undefined)
		.filter((email): email is { to: string; subject: string } => email?.to === address)
		.filter((email) => /AI cap/.test(email.subject));
}

describe("what calls cost", () => {
	test("tokens and estimated cost are recorded per Site, at the model's price", async () => {
		const place = await workspace();
		await place.owner.browser.api.aiKeys.setOwn({
			workspaceId: place.workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: KEY,
		});
		install.ai.answer(() => ({ text: "A loaf.", usage: { inputTokens: 1000, outputTokens: 100 } }));
		await suggest(place, place.sites[0]);
		await suggest(place, place.sites[0]);
		await suggest(place, place.sites[1]);

		const { own, usage } = await place.owner.browser.api.aiKeys.get({ workspaceId: place.workspaceId });
		// $0.25 per million input tokens and $2 per million output tokens: WebCraft's estimate for the model.
		expect(own?.price).toEqual({ input: 0.25, output: 2, estimated: true });
		expect(usage.month).toBe("2026-11");
		const [first, second] = [place.sites[0], place.sites[1]].map((siteId) =>
			usage.sites.find((site) => site.siteId === siteId),
		);
		expect(first).toMatchObject({ calls: 2, inputTokens: 2000, outputTokens: 200, keys: ["own"] });
		expect(first?.cost).toBeCloseTo(0.0009, 8);
		expect(second).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 100 });
		expect(usage.own).toMatchObject({ cap: null, percent: null, stopped: false });
		expect(usage.own?.spent).toBeCloseTo(0.00135, 8);
	});

	test("another Workspace's calls never show in a Workspace's usage", async () => {
		const ours = await workspace();
		const theirs = await workspace();
		for (const place of [ours, theirs]) {
			await place.owner.browser.api.aiKeys.setOwn({
				workspaceId: place.workspaceId,
				provider: "openai",
				model: "gpt-5-mini",
				endpoint: null,
				key: KEY,
			});
		}
		describeUsing(500);
		await suggest(theirs);

		const { usage } = await ours.owner.browser.api.aiKeys.get({ workspaceId: ours.workspaceId });
		expect(usage.sites).toEqual([]);
		await expect(ours.owner.browser.api.aiKeys.get({ workspaceId: theirs.workspaceId })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
	});
});

describe("a shared key's monthly cap", () => {
	async function sharedPlace(monthlyCap: number) {
		const place = await workspace();
		const { key } = await admin.api.sharedAiKeys.add({
			name: `Agency key ${place.workspaceId.slice(0, 4)}`,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: KEY,
			price: PRICE,
		});
		await admin.api.sharedAiKeys.assign({ workspace: place.workspaceId, keyId: key.id, monthlyCap });
		return { ...place, keyId: key.id };
	}

	test("at 80% the Owners and Staff are told once; at 100% calls stop cleanly, until the cap is raised", async () => {
		const place = await sharedPlace(10);
		describeUsing(4000); // $4 a call

		await suggest(place);
		expect(await capEmails(place.owner.account.email)).toEqual([]);
		await suggest(place);
		const get = () => place.owner.browser.api.aiKeys.get({ workspaceId: place.workspaceId });
		expect((await get()).usage.shared).toMatchObject({ spent: 8, cap: 10, percent: 80, stopped: false });
		for (const address of [place.owner.account.email, place.staff.account.email]) {
			expect((await capEmails(address)).map((email) => email.subject)).toEqual([
				expect.stringContaining("has used 80% of its monthly AI cap"),
			]);
		}

		// Room is left, so this call goes ahead; the next one stops.
		await suggest(place);
		expect((await get()).usage.shared).toMatchObject({ spent: 12, percent: 120, stopped: true });
		const requests = install.ai.requests.length;
		await expect(suggest(place)).rejects.toMatchObject({
			code: "AI_CAP_REACHED",
			data: { key: "shared", resumesAt: "2026-12-01T00:00:00.000Z" },
		});
		expect(install.ai.requests.length).toBe(requests);
		expect((await capEmails(place.owner.account.email)).map((email) => email.subject)).toEqual([
			expect.stringContaining("80%"),
			expect.stringContaining("has reached its monthly AI cap"),
		]);

		await admin.api.sharedAiKeys.assign({ workspace: place.workspaceId, keyId: place.keyId, monthlyCap: 20 });
		await suggest(place);
		expect((await get()).usage.shared).toMatchObject({ spent: 16, cap: 20, stopped: false });
		// Each notice goes once a month.
		expect(await capEmails(place.owner.account.email)).toHaveLength(2);
	});

	test("calls start again with the new month", async () => {
		const place = await sharedPlace(5);
		describeUsing(6000);
		await suggest(place);
		await expect(suggest(place)).rejects.toMatchObject({ code: "AI_CAP_REACHED" });

		await install.clock.set(new Date("2026-12-01T00:05:00Z"));
		await suggest(place);
		const { usage } = await place.owner.browser.api.aiKeys.get({ workspaceId: place.workspaceId });
		expect(usage).toMatchObject({ month: "2026-12", shared: { spent: 6, stopped: true } });
	});

	test("two calls at once can't both pass the cap", async () => {
		const place = await sharedPlace(1);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		install.ai.answer(async () => {
			await held;
			return { text: "A loaf.", usage: { inputTokens: 500, outputTokens: 0 } };
		});
		const before = install.ai.requests.length;
		const first = suggest(place);
		while (install.ai.requests.length === before) await Bun.sleep(5);

		// The first call's reservation already fills the cap: the second never reaches the provider.
		await expect(suggest(place)).rejects.toMatchObject({ code: "AI_CAP_REACHED" });
		expect(install.ai.requests.length).toBe(before + 1);
		release();
		await first;
		expect((await place.owner.browser.api.aiKeys.get({ workspaceId: place.workspaceId })).usage.shared?.spent).toBe(
			0.5,
		);
	});

	test("an own key's cap is optional and works the same way", async () => {
		const place = await workspace();
		await place.owner.browser.api.aiKeys.setOwn({
			workspaceId: place.workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: KEY,
			price: PRICE,
			monthlyCap: 3,
		});
		describeUsing(3000);
		await suggest(place);
		await expect(suggest(place)).rejects.toMatchObject({ code: "AI_CAP_REACHED", data: { key: "own" } });
		await place.owner.browser.api.aiKeys.setOwnCap({ workspaceId: place.workspaceId, monthlyCap: null });
		await suggest(place);
	});
});
