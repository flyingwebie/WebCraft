/**
 * What every answer on the admin host must carry (audit A3-2): nothing but the admin's own pages may
 * frame it, browsers never guess a type, addresses stay in the admin, and an enforced policy holds.
 * Pages bring the admin's page policy; every other answer one that loads nothing at all, unless it
 * brings its own (the builder's canvas, a Media preview, a downloaded upload).
 */
import { expect } from "bun:test";

import { type Policy, policyOf } from "./site-safety.ts";

/** Checks the security headers of an answer on the admin host. Answers its enforced policy. */
export function expectAdminHeaders(response: Response, options: { https?: boolean } = {}): Policy {
	const where = `${response.status} ${response.url || "answer"}`;
	expect(response.headers.get("x-content-type-options"), where).toBe("nosniff");
	expect(["same-origin", "no-referrer"], where).toContain(response.headers.get("referrer-policy") ?? "");
	expect(["DENY", "SAMEORIGIN"], where).toContain(response.headers.get("x-frame-options") ?? "");
	const policy = policyOf(response);
	expect([["'none'"], ["'self'"]], `${where}: frame-ancestors`).toContainEqual(policy.get("frame-ancestors") ?? []);
	// Only over HTTPS: a browser ignores it on plain HTTP, where it would promise what isn't there.
	const transport = response.headers.get("strict-transport-security");
	if (options.https ?? true) expect(transport, where).toMatch(/^max-age=\d{8,}$/);
	else expect(transport, where).toBeNull();
	return policy;
}

/** Checks an answer that is no page: the headers, and a policy under which it loads and runs nothing. */
export function expectInertAnswer(response: Response, options: { https?: boolean } = {}): void {
	const policy = expectAdminHeaders(response, options);
	const where = `${response.status} ${response.url || "answer"}`;
	expect(policy.get("default-src"), where).toEqual(["'none'"]);
	expect(policy.get("frame-ancestors"), where).toEqual(["'none'"]);
	expect(response.headers.get("x-frame-options"), where).toBe("DENY");
}
