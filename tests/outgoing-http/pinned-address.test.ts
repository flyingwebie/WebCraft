// Outgoing HTTP connects to the address the guarded fetcher checked, never to one the host name
// resolves to later (DNS rebinding). These tests call real servers on this machine, on 127.0.0.1 and
// ::1, with each process's adapter: Bun's (the web process) in the test, Node's (the worker) in a
// `node` process. The host names (`pinned.test`, …) are made up: the system can't resolve them, so a
// call only reaches a server when the adapter connects to the address it was given.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBunHttp } from "@webcraft/server/outgoing-http";

import { createTestCertificateAuthority } from "../harness/certificates.ts";
import { type Call, type Outcome, runCall } from "./calls.ts";
import { type CallsProcess, NODE_CALLS, startCalls } from "./children.ts";

// The servers listen on loopback, which the guarded fetcher calls only as the Install's own addresses.
const LOOPBACK = ["127.0.0.1", "::1"];

type Seen = { host: string | null; method: string; path: string; body: string };

/**
 * A server on `address` that answers what it saw, with the port the client called from (one per
 * connection), and remembers the requests whose client went away.
 */
function startServer(address: string, tls?: Parameters<typeof Bun.serve>[0]["tls"]) {
	const seen: Seen[] = [];
	const closed: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: address,
		tls,
		async fetch(request, server) {
			const url = new URL(request.url);
			const path = `${url.pathname}${url.search}`;
			request.signal.addEventListener("abort", () => closed.push(path));
			seen.push({ host: request.headers.get("host"), method: request.method, path, body: await request.text() });
			if (url.pathname === "/redirect") {
				return new Response(null, { status: 302, headers: { location: url.searchParams.get("to") ?? "/" } });
			}
			if (url.pathname === "/never") return new Promise<Response>(() => {});
			if (url.pathname === "/endless") {
				const chunk = new Uint8Array(1024).fill(120);
				return new Response(new ReadableStream({ pull: (controller) => controller.enqueue(chunk) }));
			}
			if (url.pathname === "/compressed") {
				const gzip = request.headers.get("accept-encoding")?.includes("gzip");
				const text = "a compressed answer ".repeat(50);
				return gzip
					? new Response(Bun.gzipSync(text), { headers: { "content-encoding": "gzip" } })
					: new Response(text);
			}
			return Response.json({ ...seen.at(-1), clientPort: server.requestIP(request)?.port });
		},
	});
	return { port: server.port, seen, closed, stop: () => server.stop(true) };
}

type Server = ReturnType<typeof startServer>;

const authority = createTestCertificateAuthority();
// A client that sends no server name, or another one, gets this certificate: valid for the servers'
// addresses, never for the host names the tests call.
const addressesOnly = authority.issue({ hosts: ["another.test"], addresses: LOOPBACK });
const pinnedTest = authority.issue({ hosts: ["pinned.test"] });
const tls = [
	{ cert: addressesOnly.cert, key: addressesOnly.key },
	{ serverName: "pinned.test", cert: pinnedTest.cert, key: pinnedTest.key },
];

let plain: Server;
let plain6: Server;
let secure: Server;
let secure6: Server;
let node: CallsProcess;

beforeAll(() => {
	plain = startServer("127.0.0.1");
	plain6 = startServer("::1");
	secure = startServer("127.0.0.1", tls);
	secure6 = startServer("::1", tls);
	node = startCalls(["node", NODE_CALLS, authority.cert]);
});

afterAll(async () => {
	await node.close();
	for (const server of [plain, plain6, secure, secure6]) server.stop();
});

const bunHttp = createBunHttp({ ca: authority.cert });
const runtimes: [string, (call: Call) => Promise<Outcome>][] = [
	["Bun (web)", (call) => runCall(bunHttp, call)],
	["Node (worker)", (call) => node.call(call)],
];

/** The answer of a call that should have worked, with the request the server saw. */
function answered(outcome: Outcome) {
	if ("error" in outcome) throw new Error(`The call failed: ${JSON.stringify(outcome.error)}`);
	return outcome;
}

describe.each(runtimes)("%s outgoing HTTP, pinned to an address", (_, call) => {
	test("connects to it over HTTP, the URL's host name in the Host header, though the system can't resolve that name", async () => {
		const outcome = answered(
			await call({
				url: `http://pinned.test:${plain.port}/hello?to=you`,
				connectTo: "127.0.0.1",
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "a body",
			}),
		);

		expect(outcome.status).toBe(200);
		expect(JSON.parse(outcome.body)).toEqual({
			host: `pinned.test:${plain.port}`,
			method: "POST",
			path: "/hello?to=you",
			body: "a body",
			clientPort: expect.any(Number),
		});
	});

	test("over HTTPS sends the host name as the server name and checks the certificate against it", async () => {
		// The server shows its pinned.test certificate only to a client that asks for pinned.test.
		const outcome = answered(await call({ url: `https://pinned.test:${secure.port}/`, connectTo: "127.0.0.1" }));

		expect(outcome.status).toBe(200);
		expect(JSON.parse(outcome.body)).toMatchObject({ host: `pinned.test:${secure.port}`, path: "/" });
	});

	test("refuses a certificate that isn't valid for the host name, though it is for the address", async () => {
		const before = secure.seen.length;

		const outcome = await call({ url: `https://wrong.test:${secure.port}/`, connectTo: "127.0.0.1" });

		expect(outcome).toEqual({ error: expect.objectContaining({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }) });
		expect(secure.seen.length).toBe(before);
	});

	test("reuses a kept connection only for the same address and host name", async () => {
		const connection = async (name: string) => {
			const outcome = answered(await call({ url: `https://${name}:${secure.port}/`, connectTo: "127.0.0.1" }));
			return JSON.parse(outcome.body).clientPort as number;
		};

		// another.test gets the certificate valid for another.test; pinned.test must get its own.
		const another = await connection("another.test");
		const pinned = await connection("pinned.test");
		const pinnedAgain = await connection("pinned.test");

		expect(pinned).not.toBe(another);
		expect(pinnedAgain).toBe(pinned);
	});

	test("connects to an IPv6 address, over HTTP and HTTPS", async () => {
		const overHttp = answered(await call({ url: `http://pinned.test:${plain6.port}/six`, connectTo: "::1" }));
		const overHttps = answered(await call({ url: `https://pinned.test:${secure6.port}/six`, connectTo: "::1" }));

		expect(JSON.parse(overHttp.body)).toMatchObject({ host: `pinned.test:${plain6.port}`, path: "/six" });
		expect(JSON.parse(overHttps.body)).toMatchObject({ host: `pinned.test:${secure6.port}`, path: "/six" });
	});

	test("hands a redirect back without following it", async () => {
		const before = plain.seen.length;

		const outcome = answered(
			await call({ url: `http://pinned.test:${plain.port}/redirect?to=/elsewhere`, connectTo: "127.0.0.1" }),
		);

		expect(outcome.status).toBe(302);
		expect(outcome.headers.location).toBe("/elsewhere");
		expect(plain.seen.slice(before).map((seen) => seen.path)).toEqual(["/redirect?to=/elsewhere"]);
	});

	test("hands a compressed answer back decoded, as fetch does", async () => {
		const outcome = answered(
			await call({ url: `http://pinned.test:${plain.port}/compressed`, connectTo: "127.0.0.1" }),
		);

		expect(outcome.body).toBe("a compressed answer ".repeat(50));
	});
});

describe.each(runtimes)("%s outgoing HTTP, without an address to connect to", (_, call) => {
	test("calls the URL as the runtime's fetch does", async () => {
		const outcome = answered(await call({ url: `http://127.0.0.1:${plain.port}/unpinned` }));

		expect(JSON.parse(outcome.body)).toMatchObject({ host: `127.0.0.1:${plain.port}`, path: "/unpinned" });
	});
});

describe.each(runtimes)("%s outgoing HTTP under the guarded fetcher", (_, call) => {
	const guarded = (dns: Record<string, string[]>, options: { timeoutMs?: number; maxBytes?: number } = {}) => ({
		dns,
		options: { allowedHosts: Object.keys(dns), installAddresses: LOOPBACK, ...options },
	});

	test("follows a redirect itself, connecting to the address it checked for each hop", async () => {
		const landing = `https://pinned.test:${secure6.port}/landed`;

		const outcome = answered(
			await call({
				url: `http://first.test:${plain.port}/redirect?to=${encodeURIComponent(landing)}`,
				guarded: guarded({ "first.test": ["127.0.0.1"], "pinned.test": ["::1"] }),
			}),
		);

		expect(outcome.status).toBe(200);
		expect(JSON.parse(outcome.body)).toMatchObject({ host: `pinned.test:${secure6.port}`, path: "/landed" });
	});

	test("cuts off an answer that never ends at the size limit", async () => {
		const outcome = await call({
			url: `http://pinned.test:${plain.port}/endless`,
			guarded: guarded({ "pinned.test": ["127.0.0.1"] }, { maxBytes: 64 * 1024, timeoutMs: 10_000 }),
		});

		expect(outcome).toEqual({ error: expect.objectContaining({ problem: "size" }) });
	});

	test("gives up when no answer comes in time, and closes the connection", async () => {
		const path = `/never?runtime=${crypto.randomUUID()}`;

		const outcome = await call({
			url: `http://pinned.test:${plain.port}${path}`,
			guarded: guarded({ "pinned.test": ["127.0.0.1"] }, { timeoutMs: 300 }),
		});

		expect(outcome).toEqual({ error: expect.objectContaining({ problem: "timeout" }) });
		await eventually(() => plain.closed.includes(path));
	});
});

/** Waits until `check` holds, for at most 5 seconds. */
async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !check(); attempt++) await Bun.sleep(100);
	expect(check()).toBe(true);
}
