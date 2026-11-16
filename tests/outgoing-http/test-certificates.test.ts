// The TLS tests (`pinned-address`, `no-proxy`, `email/pinned-server`) make their certificates with
// the harness's test authority, with a random serial number each. The runtime must take every one of
// them: a certificate it refused failed those files at load, about once in a few full runs.
import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";

import { createTestCertificateAuthority } from "../harness/certificates.ts";

describe("the test certificate authority", () => {
	test("every certificate it makes is one the runtime takes, whatever its random serial", () => {
		// A bad serial came about once in 256 certificates; 3000 of them miss it with a chance of
		// about one in a hundred thousand.
		const refused: string[] = [];
		for (let round = 0; round < 1500; round++) {
			const authority = createTestCertificateAuthority();
			const leaf = authority.issue({ hosts: ["pinned.test"], addresses: ["127.0.0.1", "::1"] });
			for (const pem of [authority.cert, leaf.cert]) {
				try {
					new X509Certificate(pem);
				} catch (error) {
					refused.push(`${(error as Error).message}\n${pem}`);
				}
			}
		}
		expect(refused).toEqual([]);
	});

	test("a server takes the certificate and key it issues, and a client that trusts it connects", async () => {
		const authority = createTestCertificateAuthority();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			tls: authority.issue({ hosts: ["pinned.test"], addresses: ["127.0.0.1"] }),
			fetch: () => new Response("hello"),
		});
		try {
			const response = await fetch(`https://127.0.0.1:${server.port}/`, { tls: { ca: authority.cert } });
			expect(await response.text()).toBe("hello");
		} finally {
			await server.stop(true);
		}
	});
});
