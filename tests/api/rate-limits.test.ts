// Each API token makes at most 300 requests a minute, 30 of them writes: past that, 429 with
// `Retry-After`; every answer says what is left (`RateLimit-*`). Counters hold a keyed hash of what
// they count, never the token.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, type TokenClient, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

async function scriptFor(
	workspaceId: string,
	name: string,
): Promise<{ script: TokenClient; secret: string; tokenId: string }> {
	const { secret, tokenId } = await createApiToken(await install.superadmin(), { workspaceId, name });
	return { script: tokenClient(install, secret), secret, tokenId };
}

/** Reads the Workspace `times` times, 25 at once, and answers the statuses and the last answer. */
async function reads(script: TokenClient, workspaceId: string, times: number) {
	const statuses: number[] = [];
	let last: Response | undefined;
	for (let done = 0; done < times; done += 25) {
		const answers = await Promise.all(
			Array.from({ length: Math.min(25, times - done) }, () =>
				script.request("workspaces/get", {
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ workspaceId }),
				}),
			),
		);
		statuses.push(...answers.map((answer) => answer.status));
		last = answers.at(-1);
	}
	return { statuses, last };
}

describe("per token", () => {
	test("300 requests a minute, then 429 with Retry-After until the minute is over", async () => {
		const workspace = await install.createWorkspace();
		const { script } = await scriptFor(workspace.id, "Busy");
		const { script: other } = await scriptFor(workspace.id, "Quiet");

		const first = await reads(script, workspace.id, 1);
		expect(first.last?.headers.get("ratelimit-limit")).toBe("300");
		expect(first.last?.headers.get("ratelimit-remaining")).toBe("299");
		const { statuses } = await reads(script, workspace.id, 299);
		expect(statuses.every((status) => status === 200)).toBe(true);

		await install.clock.advance(20_000);
		const refused = await reads(script, workspace.id, 1);
		expect(refused.statuses).toEqual([429]);
		expect(refused.last?.headers.get("retry-after")).toBe("40");
		expect(await refused.last?.json()).toMatchObject({
			code: "TOO_MANY_REQUESTS",
			data: { retryAfterSeconds: 40, limit: "requests" },
		});

		// Another token has its own count.
		expect((await reads(other, workspace.id, 1)).statuses).toEqual([200]);

		await install.clock.advance(40_000);
		expect((await reads(script, workspace.id, 1)).statuses).toEqual([200]);
	});

	test("30 writes a minute; reads go on meanwhile", async () => {
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		const { script } = await scriptFor(workspace.id, "Writer");
		const write = () => script.api.languages.setBrowserRedirect({ siteId: site.id, browserLanguageRedirect: false });

		for (let done = 0; done < 30; done++) await write();

		await expect(write()).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			status: 429,
			data: { limit: "writes" },
		});
		await script.api.languages.list({ siteId: site.id });

		await install.clock.advance(60_000);
		await write();
	});

	test("the counters never hold the token", async () => {
		const workspace = await install.createWorkspace();
		const { script, secret } = await scriptFor(workspace.id, "Counted");

		await reads(script, workspace.id, 3);

		expect(await install.tablesHolding(secret)).toEqual([]);
	});
});
