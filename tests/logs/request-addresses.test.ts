// What a failed request leaves behind names where it happened, never a token its address carried. A
// Share link's token is its path; setup, invite, Edit mode and Staging links carry theirs as `token`,
// and the undo history's handoff as `history`. Only hashes of those are kept, so the log, the Error
// log and an outside error tracker must not hold the working token either.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, fromAddress, type RecordedRequest, type TestInstall } from "../harness/index.ts";

const DSN = "https://f00dfeedc0ffee42@errors.agency.example/tracker/1234";
const ENVELOPES = "https://errors.agency.example/tracker/api/1234/envelope/";

let install: TestInstall;

beforeAll(async () => {
	// Nothing answers at its database: every request that needs it fails in a way nothing expects.
	install = await createTestInstall({ database: "unreachable", errorDsn: DSN });
	install.dns.answer("errors.agency.example", ["93.184.216.34"]);
	install.http.respond("POST", ENVELOPES, { status: 200, body: '{"id":"ok"}' });
});

afterAll(async () => {
	await install.close();
});

/** Everything the tracker was sent, as text. */
function sentToTracker(): string {
	return install.http.requests
		.filter((request: RecordedRequest) => request.url === ENVELOPES)
		.map((request) => request.body)
		.join("\n");
}

/** Waits until the tracker was sent something more (events go out in the background), for at most `ms`. */
async function settle(before: number, ms = 300): Promise<void> {
	const end = Date.now() + ms;
	while (sentToTracker().length === before && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}

let addresses = 0;

/** A request that fails, and what the Install wrote and sent because of it. */
async function failing(url: string) {
	const logged = install.logs.length;
	const sent = sentToTracker().length;
	const answer = await install.request(fromAddress(new Request(url), `203.0.113.${++addresses}`));
	await settle(sent);
	return {
		status: answer.status,
		log: JSON.stringify(install.logs.slice(logged)),
		tracker: sentToTracker().slice(sent),
	};
}

test("a Share link's token, which is its path, is in neither the log nor what the tracker is sent", async () => {
	const token = "Sh4reL1nkT0ken-that-0pens-a-Dashb0ard_12345";

	const failed = await failing(`https://share.sites.test/${token}?range=last30`);

	expect(failed.status).toBe(500);
	expect(failed.log).toContain("A request failed unexpectedly");
	expect(failed.log).not.toContain(token);
	expect(failed.log).toContain("https://share.sites.test/[share-link]?range=…");
	expect(failed.tracker).not.toContain(token);
});

test("nor are the tokens other links carry in their query: Staging and Edit mode links, the history handoff", async () => {
	const secret = "L1nkT0ken-carried-in-the-query-0f-a-l1nk_99";
	for (const url of [
		`https://bakery.sites.test/_webcraft/staging/enter?token=${secret}`,
		`https://bakery.sites.test/_webcraft/edit/enter?token=${secret}&path=%2F`,
		`https://bakery.sites.test/about?history=${secret}`,
	]) {
		const failed = await failing(url);

		expect({ url, status: failed.status }).toEqual({ url, status: 500 });
		expect(failed.log).toContain("A request failed unexpectedly");
		expect(failed.log).not.toContain(secret);
		expect(failed.tracker).not.toContain(secret);
	}
});
