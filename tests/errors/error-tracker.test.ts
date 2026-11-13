// An outside error tracker (WEBCRAFT_ERROR_DSN, spec story 16): each unexpected failure is also sent
// there as an event, redacted like every log line, through the guarded fetcher, never holding up the
// request or job that failed, at most once a minute per cause.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { samplePing } from "@webcraft/core";

import { createTestInstall, type RecordedRequest, type TestBrowser, type TestInstall } from "../harness/index.ts";

const DSN = "https://f00dfeedc0ffee42@errors.agency.example/tracker/1234";
const ENVELOPES = "https://errors.agency.example/tracker/api/1234/envelope/";

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ errorDsn: DSN });
	admin = await install.superadmin();
	install.dns.answer("errors.agency.example", ["93.184.216.34"]);
});

beforeEach(() => {
	install.http.respond("POST", ENVELOPES, { status: 200, body: '{"id":"ok"}' });
});

afterAll(async () => {
	await install.close();
});

/** The events the tracker received so far, read as it reads an envelope. */
function events(): { auth: string | null; header: Record<string, unknown>; event: Record<string, unknown> }[] {
	return install.http.requests
		.filter((request: RecordedRequest) => request.url === ENVELOPES)
		.map((request) => {
			const [header = "{}", item = "{}", event = "{}"] = request.body.split("\n");
			expect(JSON.parse(item)).toMatchObject({ type: "event" });
			expect(request.headers.get("content-type")).toBe("application/x-sentry-envelope");
			return { auth: request.headers.get("x-sentry-auth"), header: JSON.parse(header), event: JSON.parse(event) };
		});
}

/** Waits until `ready` holds (events go out in the background), for at most `ms`. */
async function until(ready: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!ready() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Waits for the event of a failure noted just now, if one is due. */
async function settle(sentBefore: number) {
	await admin.api.errorLog.list({});
	await until(() => events().length > sentBefore, 500);
}

test("a failure is sent as an event, redacted, naming where it happened", async () => {
	await install.jobs.send(samplePing, { url: "https://status.unreachable.example/check?token=planted-tracker-token" });
	expect((await install.drainJobs()).failed).toHaveLength(1);
	await settle(0);

	const [sent, ...more] = events();
	expect(more).toEqual([]);
	expect(sent?.auth).toMatch(/^Sentry sentry_version=7, sentry_key=f00dfeedc0ffee42, sentry_client=webcraft\/\S+$/);
	expect(sent?.header).toMatchObject({ dsn: DSN, event_id: sent?.event.event_id });
	expect(sent?.event).toMatchObject({
		level: "error",
		platform: "node",
		transaction: "sample.ping",
		tags: { source: "job", job: "sample.ping" },
		exception: { values: [{ type: "UnexpectedRequestError" }] },
	});
	const text = JSON.stringify(sent);
	expect(text).toContain("token=[redacted]");
	expect(text).not.toContain("planted-tracker-token");
	expect(sent?.event.fingerprint).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
	expect((await admin.api.errorLog.list({})).groups[0]?.count).toBe(1);
});

test("one cause is sent at most once a minute; the Error log still counts every failure", async () => {
	const before = events().length;
	await install.jobs.send(samplePing, { url: "https://status.unreachable.example/again-1" });
	await install.jobs.send(samplePing, { url: "https://status.unreachable.example/again-2" });
	await install.drainJobs();
	await settle(before);
	// The first test's failure was sent less than a minute ago: nothing new for this cause yet.
	expect(events()).toHaveLength(before);

	await install.clock.advance(61_000);
	await install.jobs.send(samplePing, { url: "https://status.unreachable.example/again-3" });
	await install.drainJobs({ only: ["sample.ping"] });
	await settle(before);
	expect(events().length).toBeGreaterThan(before);
});

test("a tracker that doesn't answer holds nothing up, and the failure is still in the Error log", async () => {
	install.http.respond("POST", ENVELOPES, () => new Promise(() => {}));
	await install.clock.advance(61_000);
	const before = (await admin.api.errorLog.list({})).groups[0]?.count ?? 0;

	await install.jobs.send(samplePing, { url: "https://status.unreachable.example/slow" });
	const drained = await install.drainJobs({ only: ["sample.ping"] });

	expect(drained.failed.length).toBeGreaterThan(0);
	const [group] = (await admin.api.errorLog.list({})).groups;
	expect(group?.count).toBeGreaterThan(before);
	// After the guarded fetcher's 5 seconds, the event is given up, and that is said at warn.
	const givenUp = () => install.logs.find((entry) => entry.msg === "An event couldn't be sent to the error tracker");
	await until(() => givenUp() !== undefined, 8_000);
	expect(givenUp()).toMatchObject({ level: "warn", problem: "timeout" });
}, 20_000);
