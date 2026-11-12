// The real Mailer connects to the address the sender checked for a Site's own server (`connectTo`),
// never to one the host name resolves to later, and still asks for the server by its name: TLS sends
// the name (SNI) and checks the certificate against it, never against the address. These tests send
// to real SMTP servers on 127.0.0.1, on Node (the worker) and on Bun (the web process's test emails).
// The host names are made up: the system can't resolve them, so an email only arrives when the
// Mailer connects to the address it was given.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SmtpConnection } from "@webcraft/core";

import { createTestCertificateAuthority } from "../harness/certificates.ts";
import { type LocalSmtpServer, startSmtpServer } from "../harness/index.ts";

const SEND = new URL("./mailer-send.ts", import.meta.url).pathname;
const ACCOUNT = { username: "mailer", password: "the smtp password" };

const authority = createTestCertificateAuthority();
// A client that names no server, or one the server doesn't know, gets this certificate: valid for the
// address the Mailer connects to, never for the host names the tests send to.
const addressOnly = authority.issue({ hosts: ["another.test"], addresses: ["127.0.0.1"] });
const names = { "mail.pinned.test": authority.issue({ hosts: ["mail.pinned.test"] }) };

let plain: LocalSmtpServer;
let implicit: LocalSmtpServer;
let upgraded: LocalSmtpServer;

beforeAll(async () => {
	plain = await startSmtpServer(ACCOUNT);
	implicit = await startSmtpServer(ACCOUNT, { security: "tls", certificate: addressOnly, names });
	upgraded = await startSmtpServer(ACCOUNT, { security: "starttls", certificate: addressOnly, names });
});

afterAll(async () => {
	await Promise.all([plain.close(), implicit.close(), upgraded.close()]);
});

type Outcome = { sent?: string; failed?: string };

/** Sends one email through `smtp` with the real Mailer, in a process of `runtime`. */
async function send(runtime: "node" | "bun", smtp: Omit<SmtpConnection, "username" | "password">): Promise<Outcome> {
	const input = JSON.stringify({ ca: authority.cert, smtp: { ...smtp, ...ACCOUNT } });
	const child = Bun.spawn([runtime, SEND, input], { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	const line = out.trim().split("\n").at(-1);
	if (!line) throw new Error(`The send wrote no outcome: ${err}`);
	return JSON.parse(line) as Outcome;
}

for (const runtime of ["node", "bun"] as const) {
	describe(`the real Mailer on ${runtime}`, () => {
		test("connects to the address it was given, never resolving the name", async () => {
			const before = plain.received.length;

			const outcome = await send(runtime, {
				host: "mail.pinned.test",
				connectTo: "127.0.0.1",
				port: plain.port,
				security: "none",
			});

			expect(outcome.sent).toMatch(/^250 /);
			expect(plain.received.slice(before).map((email) => email.to)).toEqual([["davide@agency.example"]]);
		});

		test("without an address, a name nothing resolves is not reached", async () => {
			const outcome = await send(runtime, { host: "mail.pinned.test", port: plain.port, security: "none" });

			expect(outcome.sent).toBeUndefined();
			expect(outcome.failed).toBeString();
		});

		for (const [security, server] of [
			["tls", () => implicit],
			["starttls", () => upgraded],
		] as const) {
			test(`asks for the server by its name, and takes its certificate for that name (${security})`, async () => {
				const before = server().received.length;

				const outcome = await send(runtime, {
					host: "mail.pinned.test",
					connectTo: "127.0.0.1",
					port: server().port,
					security,
				});

				expect(outcome.sent).toMatch(/^250 /);
				expect(server().received.length).toBe(before + 1);
			});

			test(`refuses a certificate that is valid for the address but not for the name (${security})`, async () => {
				const before = server().received.length;

				// The server doesn't know this name, so it answers with the certificate for its address.
				const outcome = await send(runtime, {
					host: "other.pinned.test",
					connectTo: "127.0.0.1",
					port: server().port,
					security,
				});

				expect(outcome.sent).toBeUndefined();
				expect(outcome.failed).toBeString();
				expect(server().received.length).toBe(before);
			});
		}
	});
}
