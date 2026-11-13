// WebCraft has no outgoing proxy in v1: neither process sends its calls through `HTTP_PROXY` or
// `HTTPS_PROXY`, even when its environment sets them. Bun's `fetch` would honour them and Node's
// doesn't, so the web process clears them; both then call servers directly, the same way. These tests
// start each process's outgoing HTTP in a process of its own, with those variables pointing at a
// "proxy" that only records what reaches it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestCertificateAuthority } from "../harness/certificates.ts";
import type { Call, Outcome } from "./calls.ts";
import { BUN_CALLS, type CallsProcess, NODE_CALLS, startCalls } from "./children.ts";

const authority = createTestCertificateAuthority();
const certificate = authority.issue({ hosts: ["direct.test"], addresses: ["127.0.0.1"] });

const proxied: string[] = [];
let proxy: ReturnType<typeof Bun.serve>;
let plain: ReturnType<typeof Bun.serve>;
let secure: ReturnType<typeof Bun.serve>;
const children: CallsProcess[] = [];

beforeAll(() => {
	proxy = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			proxied.push(`${request.method} ${request.url}`);
			return new Response("from the proxy");
		},
	});
	const answer = () => new Response("from the server");
	plain = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer });
	secure = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer, tls: certificate });
});

afterAll(async () => {
	await Promise.all(children.map((child) => child.close()));
	for (const server of [proxy, plain, secure]) server.stop(true);
});

/** The environment of a server whose operator set an outgoing proxy. */
function withProxy(): Record<string, string | undefined> {
	const url = `http://127.0.0.1:${proxy.port}`;
	return {
		...process.env,
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		http_proxy: url,
		https_proxy: url,
		NO_PROXY: "",
		no_proxy: "",
	};
}

const runtimes = [
	["Bun (web)", () => startCalls(["bun", BUN_CALLS, authority.cert], withProxy())],
	["Node (worker)", () => startCalls(["node", NODE_CALLS, authority.cert], withProxy())],
] as const;

function body(outcome: Outcome): string {
	if ("error" in outcome) throw new Error(`The call failed: ${JSON.stringify(outcome.error)}`);
	return outcome.body;
}

describe.each(runtimes)("%s outgoing HTTP, with HTTP_PROXY and HTTPS_PROXY set", (_, start) => {
	let calls: CallsProcess;

	beforeAll(() => {
		calls = start();
		children.push(calls);
	});

	test("calls servers directly: pinned calls, over HTTP and HTTPS, and calls the guarded fetcher doesn't check", async () => {
		proxied.length = 0;
		const made: Call[] = [
			{ url: `http://direct.test:${plain.port}/pinned`, connectTo: "127.0.0.1" },
			{ url: `https://direct.test:${secure.port}/pinned`, connectTo: "127.0.0.1" },
			{ url: `http://127.0.0.1:${plain.port}/unpinned` },
		];

		for (const call of made) expect(body(await calls.call(call))).toBe("from the server");
		expect(proxied).toEqual([]);
	});
});
