import { createHmac, timingSafeEqual } from "node:crypto";

import type { RecordedRequest } from "../harness/fake-http.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";

/**
 * Runs a Sensitive action (adding a Webhook, changing one) as a signed-in person. A test may have
 * moved the clock past their last identity check: when one is asked for, they confirm their password
 * and the call is tried again, as the admin's "Confirm it's you" does.
 */
export async function confirmed<Result>(
	browser: TestBrowser,
	account: TestAccount,
	call: () => Promise<Result>,
): Promise<Result> {
	try {
		return await call();
	} catch (error) {
		if ((error as { code?: string }).code !== "IDENTITY_CHECK_REQUIRED") throw error;
		await browser.api.session.confirmIdentity({ password: account.password });
		return call();
	}
}

/**
 * Checks a delivery's signature as a receiver does (`docs/webhooks.md`): HMAC-SHA256 of `<t>.<body>`
 * with the signing secret, compared in constant time, and `t` within 5 minutes of the receiver's
 * clock. Answers whether the receiver accepts it.
 */
export function receiverAccepts(request: RecordedRequest, secret: string, now: Date): boolean {
	const header = request.headers.get("webcraft-signature") ?? "";
	const parts = Object.fromEntries(header.split(",").map((part) => part.split("=", 2) as [string, string]));
	const timestamp = Number(parts.t);
	if (!Number.isInteger(timestamp) || Math.abs(now.getTime() / 1000 - timestamp) > 300) return false;
	const expected = createHmac("sha256", secret).update(`${timestamp}.${request.body}`).digest();
	const given = Buffer.from(parts.v1 ?? "", "hex");
	return given.length === expected.length && timingSafeEqual(given, expected);
}
