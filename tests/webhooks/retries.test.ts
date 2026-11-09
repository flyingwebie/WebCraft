// Retries (spec story 139): a delivery whose attempt fails for a reason that may pass (no answer,
// 408, 429, 5xx) is tried again after a wait that grows fourfold from 1 minute, or as long as the
// receiver's Retry-After asks (up to 6 hours), 6 attempts in all, always with the same delivery id.
// Other answers fail it at once. Every call goes through the guarded fetcher.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { FakeAnswer, RecordedRequest } from "../harness/fake-http.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { confirmed } from "./support.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let staffAccount: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	({ browser: staff, account: staffAccount } = await install.createStaff({ workspaces: [workspaceId] }));
	install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/**
 * A Site with one Webhook to `https://hooks.agency.example/<path>`, answering as `answer` says;
 * publishes the Site's Globals once, which queues one delivery. Answers the Site and Webhook.
 */
async function deliveryTo(
	path: string,
	answer: FakeAnswer | ((request: RecordedRequest) => FakeAnswer),
): Promise<{ siteId: string; webhookId: string; url: string }> {
	const { id: siteId } = await install.createSite(workspaceId, { slug: `retries-${++sites}` });
	const url = `https://hooks.agency.example/${path}`;
	install.http.respond("POST", url, answer);
	const { webhook } = await addWebhook(siteId, url);
	await staff.api.globals.publish({ siteId });
	return { siteId, webhookId: webhook.id, url };
}

/** The Webhook's only delivery, as the delivery log shows it. */
async function theDelivery(siteId: string, webhookId: string) {
	const { deliveries } = await staff.api.webhooks.deliveries({ siteId, webhookId });
	expect(deliveries).toHaveLength(1);
	const [delivery] = deliveries;
	if (!delivery) throw new Error("No delivery.");
	return delivery;
}

/** Runs each retry when the delivery log says it is due; answers when each attempt ran, in minutes after the first. */
async function followRetries(siteId: string, webhookId: string): Promise<number[]> {
	const start = install.clock.now().getTime();
	await install.drainJobs();
	const minutes = [0];
	for (let delivery = await theDelivery(siteId, webhookId); delivery.status === "retrying"; ) {
		const due = delivery.nextAttemptAt?.getTime() ?? 0;
		// Not a moment before it is due.
		await install.clock.set(new Date(due - 1000));
		await install.drainJobs();
		expect((await theDelivery(siteId, webhookId)).attempts).toHaveLength(delivery.attempts.length);
		await install.clock.set(new Date(due));
		await install.drainJobs();
		minutes.push((due - start) / MINUTE);
		delivery = await theDelivery(siteId, webhookId);
	}
	return minutes;
}

/** Adds a Webhook receiving `publish`, confirming who Staff are when the clock moved past their check. */
function addWebhook(siteId: string, url: string) {
	return confirmed(staff, staffAccount, () => staff.api.webhooks.add({ siteId, url, events: ["publish"] }));
}

function requestsTo(url: string): RecordedRequest[] {
	return install.http.requests.filter((request) => request.url === url);
}

describe("an attempt that fails for a reason that may pass", () => {
	test("is tried again after waits growing fourfold from 1 minute, 6 attempts in all, with the same delivery id", async () => {
		const { siteId, webhookId, url } = await deliveryTo("server-error", { status: 503, body: "Down for upgrade" });

		expect(await followRetries(siteId, webhookId)).toEqual([0, 1, 5, 21, 85, 341]);

		const delivery = await theDelivery(siteId, webhookId);
		expect(delivery).toMatchObject({ status: "failed", nextAttemptAt: null, lastStatusCode: 503 });
		expect(delivery.attempts.map((attempt) => [attempt.number, attempt.statusCode, attempt.problem])).toEqual([
			[1, 503, "status"],
			[2, 503, "status"],
			[3, 503, "status"],
			[4, 503, "status"],
			[5, 503, "status"],
			[6, 503, "status"],
		]);
		const requests = requestsTo(url);
		expect(requests).toHaveLength(6);
		expect(new Set(requests.map((request) => request.headers.get("webcraft-delivery")))).toEqual(
			new Set([delivery.id]),
		);
		expect(new Set(requests.map((request) => JSON.parse(request.body).id))).toEqual(new Set([delivery.id]));
		// Each attempt is signed when it is sent.
		expect(new Set(requests.map((request) => request.headers.get("webcraft-signature"))).size).toBe(6);
	});

	test("408, 429 and no answer at all are tried again too", async () => {
		const answers: FakeAnswer[] = [{ status: 408 }, { status: 429 }, { status: 204 }];
		const { siteId, webhookId } = await deliveryTo("busy", () => answers.shift() ?? { status: 204 });
		const unanswered = await deliveryTo("unreachable-then-up", { status: 500 });
		// Nobody answers it at first: the fake fails a request no rule answers, as an unreachable server does.
		install.http.respond("POST", unanswered.url, () => {
			throw new TypeError("connection refused");
		});

		await followRetries(siteId, webhookId);
		expect((await theDelivery(siteId, webhookId)).attempts.map((attempt) => attempt.statusCode)).toEqual([
			408, 429, 204,
		]);
		expect(await theDelivery(siteId, webhookId)).toMatchObject({ status: "delivered", lastStatusCode: 204 });

		await install.drainJobs();
		expect(await theDelivery(unanswered.siteId, unanswered.webhookId)).toMatchObject({
			status: "retrying",
			lastStatusCode: null,
			lastProblem: "unreachable",
		});
		install.http.respond("POST", unanswered.url, { status: 200 });
		await followRetries(unanswered.siteId, unanswered.webhookId);
		expect(await theDelivery(unanswered.siteId, unanswered.webhookId)).toMatchObject({ status: "delivered" });
	});

	test("waits as long as Retry-After asks when that is longer, but never more than 6 hours", async () => {
		const longer = await deliveryTo("retry-after-longer", { status: 429, headers: { "retry-after": "600" } });
		const shorter = await deliveryTo("retry-after-shorter", { status: 503, headers: { "retry-after": "5" } });
		const capped = await deliveryTo("retry-after-capped", { status: 503, headers: { "retry-after": "259200" } });
		const dated = await deliveryTo("retry-after-date", () => ({
			status: 503,
			headers: { "retry-after": new Date(install.clock.now().getTime() + 2 * HOUR).toUTCString() },
		}));
		const now = install.clock.now().getTime();
		await install.drainJobs();

		const dueIn = async ({ siteId, webhookId }: { siteId: string; webhookId: string }) =>
			((await theDelivery(siteId, webhookId)).nextAttemptAt?.getTime() ?? 0) - now;
		expect(await dueIn(longer)).toBe(10 * MINUTE);
		expect(await dueIn(shorter)).toBe(MINUTE);
		expect(await dueIn(capped)).toBe(6 * HOUR);
		expect(await dueIn(dated)).toBe(2 * HOUR);
	});
});

describe("an attempt that fails for good", () => {
	test("another 4xx answer fails the delivery at once", async () => {
		for (const status of [400, 401, 404, 410, 422]) {
			const { siteId, webhookId, url } = await deliveryTo(`client-error-${status}`, { status });
			await install.drainJobs();
			await install.clock.advance(HOUR);
			await install.drainJobs();
			expect(await theDelivery(siteId, webhookId)).toMatchObject({ status: "failed", lastStatusCode: status });
			expect(requestsTo(url)).toHaveLength(1);
		}
	});

	test("a redirect isn't followed: the call carries a signature, so it goes only where Staff said", async () => {
		const { siteId, webhookId, url } = await deliveryTo("moved", {
			status: 302,
			headers: { location: "https://elsewhere.example/collect" },
		});
		install.dns.answer("elsewhere.example", ["93.184.216.35"]);
		install.http.respond("POST", "https://elsewhere.example/collect", { status: 200 });

		await followRetries(siteId, webhookId);

		expect(await theDelivery(siteId, webhookId)).toMatchObject({
			status: "failed",
			lastStatusCode: 302,
			lastProblem: "redirect",
		});
		expect(requestsTo(url)).toHaveLength(1);
		expect(requestsTo("https://elsewhere.example/collect")).toEqual([]);
	});
});

describe("the guarded fetcher's rules", () => {
	test("a host resolving to an address inside the network is never called, and the address isn't shown", async () => {
		install.dns.answer("inside.agency.example", ["10.0.0.5"]);
		const { id: siteId } = await install.createSite(workspaceId, { slug: `retries-${++sites}` });
		const url = "https://inside.agency.example/hook";
		install.http.respond("POST", url, { status: 200 });
		const { webhook } = await addWebhook(siteId, url);
		await staff.api.globals.publish({ siteId });

		await install.drainJobs();

		const delivery = await theDelivery(siteId, webhook.id);
		expect(delivery).toMatchObject({ status: "retrying", lastStatusCode: null, lastProblem: "address" });
		expect(requestsTo(url)).toEqual([]);
		expect(JSON.stringify(delivery)).not.toContain("10.0.0.5");
	});

	test("the connection goes to the address checked, even when DNS answers differently a moment later", async () => {
		install.dns.answerInTurn("rebinding.agency.example", [["93.184.216.40"], ["127.0.0.1"]]);
		const { id: siteId } = await install.createSite(workspaceId, { slug: `retries-${++sites}` });
		const url = "https://rebinding.agency.example/hook";
		install.http.respond("POST", url, { status: 200 });
		await addWebhook(siteId, url);
		await staff.api.globals.publish({ siteId });

		await install.drainJobs();

		expect(requestsTo(url).map((request) => request.address)).toEqual(["93.184.216.40"]);
	});
});
