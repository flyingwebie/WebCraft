// Every request has an id of the web process's own making: its log lines, the jobs it queues and its
// Error log entry carry it, and the answer names it in `X-Request-Id`. A client can't choose it, even
// through the proxy in front of the web process, which hands on whatever headers a client sent: an id
// copied from elsewhere would make one person's requests look like another's.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, fromAddress, type TestInstall } from "../harness/index.ts";

/** Where the proxy reaches the web process from in the Compose file: a trusted proxy. */
const PROXY = "172.18.0.5";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

function throughProxy(url: string, headers: Record<string, string> = {}) {
	return install.request(
		fromAddress(new Request(url, { headers: { "x-forwarded-for": "198.51.100.7", ...headers } }), PROXY),
	);
}

test("a request's id is made by the web process, whatever X-Request-Id a client sent through the proxy", async () => {
	const copied = "an-id-copied-from-a-support-thread";

	const answer = await throughProxy(install.adminUrl("/healthz"), { "x-request-id": copied });

	expect(answer.status).toBe(200);
	expect(answer.headers.get("x-request-id")).toMatch(UUID);
	expect(answer.headers.get("x-request-id")).not.toBe(copied);
});

test("the lines a request writes carry that id, not the client's", async () => {
	const copied = "0d6c1b9e-1111-4222-8333-444455556666";
	const logged = install.logs.length;
	// Eleven sign-ins from one visitor in a minute: the eleventh is refused, and the log says so.
	let last: Response | undefined;
	for (let attempt = 0; attempt < 11; attempt++) {
		last = await install.request(
			fromAddress(
				new Request(install.adminUrl("/api/rpc/session/signIn"), {
					method: "POST",
					headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.8", "x-request-id": copied },
					body: JSON.stringify({ json: { email: `nobody-${attempt}@agency.example`, password: "a guessed password" } }),
				}),
				PROXY,
			),
		);
	}

	expect(last?.status).toBe(429);
	const lines = install.logs.slice(logged).filter((entry) => entry.msg.includes("Too many requests"));
	expect(lines).toHaveLength(1);
	expect(lines[0]?.requestId).toBe(last?.headers.get("x-request-id"));
	expect(JSON.stringify(install.logs.slice(logged))).not.toContain(copied);
});

test("every request gets an id of its own", async () => {
	const first = await throughProxy(install.adminUrl("/healthz"));
	const second = await throughProxy(install.adminUrl("/healthz"));

	expect(first.headers.get("x-request-id")).not.toBe(second.headers.get("x-request-id"));
});
