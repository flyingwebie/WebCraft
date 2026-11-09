// The delivery log (spec stories 99, 139): each attempt of each delivery is recorded, with its time,
// the receiver's status, how long it took, the start of its answer, or what went wrong. Staff send a
// test from the admin, redeliver a failed delivery, and the log is kept 30 days.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { RecordedRequest } from "../harness/fake-http.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { confirmed, receiverAccepts } from "./support.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let staffAccount: TestAccount;
let staffId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	({
		browser: staff,
		account: staffAccount,
		personId: staffId,
	} = await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" }));
	install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with a Webhook receiving `publish` at `https://hooks.agency.example/<path>`. */
async function webhookAt(path: string) {
	const { id: siteId, slug } = await install.createSite(workspaceId, { name: "Acme Bakery", slug: `log-${++sites}` });
	const url = `https://hooks.agency.example/${path}`;
	const { webhook, secret } = await confirmed(staff, staffAccount, () =>
		staff.api.webhooks.add({ siteId, url, events: ["publish"] }),
	);
	return { siteId, slug, url, webhookId: webhook.id, secret: secret ?? "" };
}

async function deliveriesOf(siteId: string, webhookId: string) {
	return (await staff.api.webhooks.deliveries({ siteId, webhookId })).deliveries;
}

function requestsTo(url: string): RecordedRequest[] {
	return install.http.requests.filter((request) => request.url === url);
}

describe("each attempt", () => {
	test("is recorded with its time, the receiver's status, how long it took and the start of its answer", async () => {
		const { siteId, url, webhookId } = await webhookAt("recorded");
		const answers = [
			{ status: 500, body: `${"Internal error. ".repeat(40)}Trace id abc` },
			{ status: 200, body: '{"ok":true}' },
		];
		install.http.respond("POST", url, async () => {
			await install.clock.advance(250);
			return answers.shift() ?? { status: 200 };
		});
		const publishedAt = install.clock.now();
		await staff.api.globals.publish({ siteId });

		await install.drainJobs();
		await install.clock.advance(MINUTE);
		await install.drainJobs();

		const [delivery] = await deliveriesOf(siteId, webhookId);
		expect(delivery).toMatchObject({ event: "publish", test: false, status: "delivered", lastStatusCode: 200 });
		expect(delivery?.createdAt).toEqual(publishedAt);
		expect(delivery?.attempts).toEqual([
			{
				number: 1,
				at: publishedAt,
				durationMs: 250,
				statusCode: 500,
				problem: "status",
				excerpt: `${"Internal error. ".repeat(40).slice(0, 500)}…`,
			},
			{
				number: 2,
				at: new Date(publishedAt.getTime() + 250 + MINUTE),
				durationMs: 250,
				statusCode: 200,
				problem: null,
				excerpt: '{"ok":true}',
			},
		]);
		expect(JSON.parse(delivery?.body ?? "{}")).toMatchObject({ id: delivery?.id, type: "publish" });
	});

	test("the log lists the newest deliveries first, a page at a time", async () => {
		const { siteId, url, webhookId } = await webhookAt("paged");
		install.http.respond("POST", url, { status: 204 });
		for (let count = 0; count < 3; count++) {
			await staff.api.globals.publish({ siteId });
			await install.clock.advance(1000);
		}
		await install.drainJobs();

		const first = await staff.api.webhooks.deliveries({ siteId, webhookId, limit: 2 });
		expect(first.deliveries).toHaveLength(2);
		const second = await staff.api.webhooks.deliveries({ siteId, webhookId, limit: 2, before: first.next ?? "" });
		expect(second).toMatchObject({ next: null });
		const all = [...first.deliveries, ...second.deliveries];
		expect(all.map((delivery) => delivery.createdAt.getTime())).toEqual(
			all.map((delivery) => delivery.createdAt.getTime()).sort((a, b) => b - a),
		);
		expect(new Set(all.map((delivery) => delivery.id)).size).toBe(3);
	});
});

describe("Send test", () => {
	test("sends a signed test event at once, and shows what the receiver answered", async () => {
		const { siteId, slug, url, webhookId, secret } = await webhookAt("tested");
		install.http.respond("POST", url, { status: 200, body: "pong" });

		const { delivery } = await staff.api.webhooks.test({ siteId, webhookId });

		const [request] = requestsTo(url);
		if (!request) throw new Error("The test wasn't sent.");
		expect(receiverAccepts(request, secret, install.clock.now())).toBe(true);
		expect(request.headers.get("webcraft-event")).toBe("test");
		expect(JSON.parse(request.body)).toEqual({
			id: delivery.id,
			type: "test",
			occurredAt: install.clock.now().toISOString(),
			site: { id: siteId, name: "Acme Bakery", url: `https://${slug}.sites.test` },
			data: { by: { id: staffId, name: "Ada Staff" }, via: "admin" },
		});
		expect(delivery).toMatchObject({
			event: "test",
			test: true,
			status: "delivered",
			attempts: [{ number: 1, statusCode: 200, problem: null, excerpt: "pong" }],
		});
		expect((await deliveriesOf(siteId, webhookId)).map((each) => each.id)).toEqual([delivery.id]);
	});

	test("a failed test isn't tried again, and doesn't count as a failure of the Webhook", async () => {
		const { siteId, url, webhookId } = await webhookAt("test-fails");
		install.http.respond("POST", url, { status: 503 });

		const { delivery } = await staff.api.webhooks.test({ siteId, webhookId });
		await install.clock.advance(DAY);
		await install.drainJobs();

		expect(delivery).toMatchObject({ status: "failed", lastStatusCode: 503 });
		expect(requestsTo(url)).toHaveLength(1);
		const { webhooks } = await staff.api.webhooks.list({ siteId });
		expect(webhooks[0]).toMatchObject({ failuresInARow: 0, status: "on" });
	});

	test("only Staff send tests", async () => {
		const { siteId, webhookId } = await webhookAt("members-cannot-test");
		const owner = await install.createMember({ workspaceId, role: "owner" });
		await expect(owner.browser.api.webhooks.test({ siteId, webhookId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("Redeliver", () => {
	test("sends a failed delivery again, with the same id and body, in a new round of attempts", async () => {
		const { siteId, url, webhookId, secret } = await webhookAt("redelivered");
		install.http.respond("POST", url, { status: 410 });
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();
		const [failed] = await deliveriesOf(siteId, webhookId);
		expect(failed).toMatchObject({ status: "failed", lastStatusCode: 410 });

		install.http.respond("POST", url, { status: 202 });
		await install.clock.advance(MINUTE);
		const { delivery } = await staff.api.webhooks.redeliver({ siteId, webhookId, deliveryId: failed?.id ?? "" });
		expect(delivery).toMatchObject({ id: failed?.id, status: "queued" });
		await install.drainJobs();

		const [redelivered] = await deliveriesOf(siteId, webhookId);
		expect(redelivered).toMatchObject({ id: failed?.id, status: "delivered", lastStatusCode: 202 });
		expect(redelivered?.attempts.map((attempt) => [attempt.number, attempt.statusCode])).toEqual([
			[1, 410],
			[2, 202],
		]);
		const [first, second] = requestsTo(url);
		expect(second?.body).toBe(first?.body);
		expect(second?.headers.get("webcraft-delivery")).toBe(failed?.id ?? "");
		if (!second) throw new Error("Not redelivered.");
		expect(receiverAccepts(second, secret, install.clock.now())).toBe(true);
	});

	test("only a failed delivery is redelivered, not a test, and only while the Webhook is on", async () => {
		const { siteId, url, webhookId } = await webhookAt("redelivery-refused");
		install.http.respond("POST", url, { status: 503 });
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();
		const [retrying] = await deliveriesOf(siteId, webhookId);
		await expect(
			staff.api.webhooks.redeliver({ siteId, webhookId, deliveryId: retrying?.id ?? "" }),
		).rejects.toMatchObject({ code: "WEBHOOK_REDELIVERY_REFUSED", data: { problem: "not-failed" } });

		const { delivery: test } = await staff.api.webhooks.test({ siteId, webhookId });
		await expect(staff.api.webhooks.redeliver({ siteId, webhookId, deliveryId: test.id })).rejects.toMatchObject({
			code: "WEBHOOK_REDELIVERY_REFUSED",
			data: { problem: "test" },
		});

		await staff.api.webhooks.setEnabled({ siteId, webhookId, enabled: false });
		await expect(
			staff.api.webhooks.redeliver({ siteId, webhookId, deliveryId: retrying?.id ?? "" }),
		).rejects.toMatchObject({ code: "WEBHOOK_REDELIVERY_REFUSED", data: { problem: "switched-off" } });
		await expect(
			staff.api.webhooks.redeliver({ siteId, webhookId, deliveryId: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: "WEBHOOK_DELIVERY_NOT_FOUND" });
	});
});

describe("the delivery log's retention", () => {
	test("deliveries are kept 30 days, then deleted by the daily purge", async () => {
		const { siteId, url, webhookId } = await webhookAt("purged");
		install.http.respond("POST", url, { status: 204 });
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();

		// Sessions don't last a month: the Superadmin signs in again to look.
		const logOf = async () =>
			(await (await install.superadmin()).api.webhooks.deliveries({ siteId, webhookId })).deliveries;

		await install.clock.advance(29 * DAY);
		await install.drainJobs();
		expect(await logOf()).toHaveLength(1);

		await install.clock.advance(2 * DAY);
		await install.drainJobs();
		expect(await logOf()).toEqual([]);
	});
});
