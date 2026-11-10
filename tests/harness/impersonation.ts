// Impersonation as the Superadmin and Staff start it (ADR 0008): it needs their own second factor
// and a recent identity check, then their admin session acts as the person for at most an hour.
//
//     const anna = await withSecondFactor(install, await install.createStaff({ workspaces: [acme] }));
//     await impersonate(anna.browser, member.personId);
//     await anna.browser.api.session.current(); // the Member
//     await anna.browser.api.impersonation.stop();
import type { ApiClient } from "@webcraft/api";

import { TEST_PASSWORD, type TestAccount, type TestBrowser, type TestInstall } from "./index.ts";
import { addAuthenticator, confirmIfAsked } from "./two-factor.ts";

/** Someone signed in who has added an authenticator app, as impersonating needs. */
export type WithSecondFactor<Person extends { browser: TestBrowser }> = Person & { secret: string };

/** Adds an authenticator app to a signed-in person's account (their browser stays signed in). */
export async function withSecondFactor<Person extends { browser: TestBrowser }>(
	install: TestInstall,
	person: Person,
): Promise<WithSecondFactor<Person>> {
	const { secret } = await addAuthenticator(install, person.browser);
	return { ...person, secret };
}

/**
 * Starts impersonating `personId` in `browser`'s admin session, confirming the password first when
 * the identity check is old (as "Confirm it's you" does), and answers what `start` answered.
 */
export function impersonate(
	browser: TestBrowser,
	personId: string,
	input: Omit<Parameters<ApiClient["impersonation"]["start"]>[0], "personId"> = {},
	password: TestAccount["password"] = TEST_PASSWORD,
): ReturnType<ApiClient["impersonation"]["start"]> {
	return confirmIfAsked(browser, password, () => browser.api.impersonation.start({ personId, ...input }));
}
