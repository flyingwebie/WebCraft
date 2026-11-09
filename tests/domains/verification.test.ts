// Domain verification (ADR 0015): the Install fetches `http://<domain>/_webcraft/verify/<token>` and
// accepts only the answer it alone can make for that token. Until then the domain waits for DNS and
// is checked again: every few minutes for the first hour, hourly for 7 days, then only when Staff ask.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, TEST_INSTALL_ADDRESSES, type TestBrowser, type TestInstall } from "../harness/index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let install: TestInstall;
let workspaceId: string;

/**
 * The Superadmin's API: signed in again when the clock moved past their session's end (sessions end
 * after 7 days unused, and these tests move days ahead).
 */
async function api(): Promise<TestBrowser["api"]> {
	return (await install.superadmin()).api;
}

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

/** A new Site with one domain added; answers the Site and the domain's id. */
async function siteWithDomain(name: string): Promise<{ siteId: string; domainId: string }> {
	const { id: siteId } = await install.createSite(workspaceId);
	const { domains } = await (await api()).domains.add({ siteId, name });
	return { siteId, domainId: domains[0]?.id ?? "" };
}

async function domainOf(siteId: string, name: string) {
	const found = (await (await api()).domains.list({ siteId })).domains.find((domain) => domain.name === name);
	if (!found) throw new Error(`The Site has no domain ${name}.`);
	return found;
}

/** Moves the clock on and runs the jobs that came due, as the worker would. */
async function after(ms: number): Promise<void> {
	await install.clock.advance(ms);
	const { failed } = await install.drainJobs();
	expect(failed).toEqual([]);
}

/** The verification requests the Install made to a domain. */
function verifyRequests(name: string) {
	return install.http.requests.filter((request) => request.url.startsWith(`http://${name}/_webcraft/verify/`));
}

describe("verifying a domain", () => {
	test("a domain pointing at the Install is verified at its next check", async () => {
		const { siteId } = await siteWithDomain("verified-bakery.example");
		install.connectDomain("verified-bakery.example");

		await after(MINUTE);

		const domain = await domainOf(siteId, "verified-bakery.example");
		expect(domain).toMatchObject({ status: "active", problem: null, nextCheckAt: null });
		expect(domain.verifiedAt).toEqual(install.clock.now());
		const [request] = verifyRequests("verified-bakery.example");
		expect(request?.method).toBe("GET");
		expect(request?.url).toMatch(/^http:\/\/verified-bakery\.example\/_webcraft\/verify\/[A-Za-z0-9_-]{20,}$/);
	});

	test("the verify path answers only the domain's own token, on that domain, and is never kept", async () => {
		await siteWithDomain("answer-bakery.example");
		await siteWithDomain("answer-cafe.example");
		install.connectDomain("answer-bakery.example");
		await after(MINUTE);
		const token = verifyRequests("answer-bakery.example")[0]?.url.split("/").pop() ?? "";

		const answer = await install.request(`http://answer-bakery.example/_webcraft/verify/${token}`);
		const body = await answer.text();
		expect(answer.status).toBe(200);
		expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(answer.headers.get("cache-control")).toBe("no-store");
		expect(body.length).toBeGreaterThanOrEqual(40);
		expect(body).not.toContain(token);

		for (const url of [
			`http://answer-bakery.example/_webcraft/verify/${token}x`,
			`http://answer-cafe.example/_webcraft/verify/${token}`,
			`http://unknown-bakery.example/_webcraft/verify/${token}`,
			`https://${install.adminHost}/_webcraft/verify/${token}`,
		]) {
			const refused = await install.request(url);
			expect(refused.status).toBe(404);
		}
	});

	test("an answer the Install didn't make is refused: another page, an echo of the token, another Install's", async () => {
		const other = await createTestInstall({ masterKey: "another-master-key-0123456789abcdefghijkl" });
		try {
			const otherAdmin = await other.superadmin();
			const otherWorkspace = await other.createWorkspace();
			const otherSite = await other.createSite(otherWorkspace.id);
			await otherAdmin.api.domains.add({ siteId: otherSite.id, name: "impostor-bakery.example" });

			const answers: [string, Parameters<TestInstall["http"]["respond"]>[2]][] = [
				["impostor-page.example", { body: "<h1>Welcome</h1>" }],
				["impostor-echo.example", (request) => ({ body: request.url.split("/").pop() ?? "" })],
				[
					"impostor-bakery.example",
					async (request) => {
						const response = await other.request(request.url);
						return { status: response.status, body: await response.text() };
					},
				],
			];
			for (const [name, answer] of answers) {
				const { siteId } = await siteWithDomain(name);
				install.dns.answer(name, [TEST_INSTALL_ADDRESSES[0]]);
				install.http.respond("GET", new RegExp(`^http://${name.replaceAll(".", "\\.")}/`), answer);

				await after(MINUTE);

				expect(await domainOf(siteId, name)).toMatchObject({ status: "waiting", problem: "response" });
			}
		} finally {
			await other.close();
		}
	});

	test("a domain that doesn't resolve, or points elsewhere, waits for DNS", async () => {
		const missing = await siteWithDomain("nowhere-bakery.example");
		const elsewhere = await siteWithDomain("elsewhere-bakery.example");
		install.dns.answer("elsewhere-bakery.example", ["93.184.216.34"]);
		install.http.respond("GET", /^http:\/\/elsewhere-bakery\.example\//, { status: 404, body: "Not here" });

		await after(MINUTE);

		expect(await domainOf(missing.siteId, "nowhere-bakery.example")).toMatchObject({
			status: "waiting",
			problem: "dns",
		});
		expect(await domainOf(elsewhere.siteId, "elsewhere-bakery.example")).toMatchObject({
			status: "waiting",
			problem: "dns",
		});
	});

	test("a domain answering a redirect isn't followed, and isn't verified", async () => {
		const { siteId } = await siteWithDomain("redirecting-bakery.example");
		install.dns.answer("redirecting-bakery.example", [TEST_INSTALL_ADDRESSES[0]]);
		install.http.respond("GET", /^http:\/\/redirecting-bakery\.example\//, {
			status: 308,
			headers: { location: "https://redirecting-bakery.example/" },
		});

		await after(MINUTE);

		expect(await domainOf(siteId, "redirecting-bakery.example")).toMatchObject({ problem: "response" });
		expect(install.http.requests.filter((request) => request.url.includes("redirecting-bakery"))).toHaveLength(1);
	});

	test("a redirect to the same verify address over HTTPS is followed once: platforms answering plain HTTP with it (Railway's edge, Coolify's proxy) verify too", async () => {
		const { siteId } = await siteWithDomain("upgrading-bakery.example");
		install.connectDomain("upgrading-bakery.example");
		install.http.respond("GET", /^http:\/\/upgrading-bakery\.example\//, (request) => ({
			status: 301,
			headers: { location: request.url.replace(/^http:/, "https:") },
		}));

		await after(MINUTE);

		expect(await domainOf(siteId, "upgrading-bakery.example")).toMatchObject({ status: "active", problem: null });
		const upgraded = install.http.requests.filter((request) =>
			request.url.startsWith("https://upgrading-bakery.example/_webcraft/verify/"),
		);
		expect(upgraded).toHaveLength(1);
		expect(upgraded[0]?.address).toBe(TEST_INSTALL_ADDRESSES[0]);
	});

	test("any other redirect, even over HTTPS on the same domain, is a wrong answer and isn't followed", async () => {
		for (const [name, location] of [
			["path-bakery.example", (url: string) => url.replace(/^http:/, "https:").replace("/verify/", "/verify/x")],
			["port-bakery.example", (url: string) => url.replace(/^http:\/\/([^/]+)/, "https://$1:8443")],
			["host-bakery.example", (url: string) => url.replace(/^http:\/\/[^/]+/, "https://elsewhere-cafe.example")],
		] as const) {
			const { siteId } = await siteWithDomain(name);
			install.connectDomain(name);
			install.http.respond("GET", new RegExp(`^http://${name.replaceAll(".", "\\.")}/`), (request) => ({
				status: 302,
				headers: { location: location(request.url) },
			}));

			await after(MINUTE);

			expect(await domainOf(siteId, name)).toMatchObject({ status: "waiting", problem: "response" });
			expect(
				install.http.requests.filter((request) => request.url.startsWith("https://") && request.url.includes(name)),
			).toEqual([]);
		}
	});

	test("the Install never calls an address inside its network, unless it is the Install's own", async () => {
		const inside = await siteWithDomain("intranet-bakery.example");
		install.dns.answer("intranet-bakery.example", ["10.0.0.5"]);
		install.http.respond("GET", /^http:\/\/intranet-bakery\.example\//, { body: "secret" });
		const loopback = await siteWithDomain("loopback-bakery.example");
		install.dns.answer("loopback-bakery.example", ["127.0.0.1", TEST_INSTALL_ADDRESSES[0]]);

		await after(MINUTE);

		expect(await domainOf(inside.siteId, "intranet-bakery.example")).toMatchObject({ problem: "dns" });
		expect(await domainOf(loopback.siteId, "loopback-bakery.example")).toMatchObject({ problem: "dns" });
		expect(install.http.requests.filter((request) => /intranet|loopback/.test(request.url))).toEqual([]);
	});

	test("the check connects to the address it checked, though DNS answers otherwise when it connects", async () => {
		const { siteId } = await siteWithDomain("rebinding-bakery.example");
		install.connectDomain("rebinding-bakery.example");
		const own = TEST_INSTALL_ADDRESSES[0];
		// DNS rebinding: the Install's address while the domain is checked, then one inside its network.
		install.dns.answerInTurn("rebinding-bakery.example", [[own], [own], ["10.0.0.5"]]);

		await after(MINUTE);

		expect(verifyRequests("rebinding-bakery.example").map((request) => request.address)).toEqual([own]);
		expect(await domainOf(siteId, "rebinding-bakery.example")).toMatchObject({ status: "active", problem: null });
	});
});

describe("checking again until it is verified", () => {
	test("every few minutes for the first hour, hourly for 7 days, then only when Staff ask", async () => {
		const { siteId } = await siteWithDomain("patient-bakery.example");
		const name = "patient-bakery.example";
		const started = install.clock.now().getTime();

		await after(MINUTE);
		let domain = await domainOf(siteId, name);
		expect(domain.lastCheckedAt?.getTime()).toBe(started + MINUTE);
		expect(domain.nextCheckAt?.getTime()).toBe(started + 6 * MINUTE);

		// Within the first hour, a check every 5 minutes.
		for (let minute = 6; minute <= 56; minute += 5) await after(5 * MINUTE);
		domain = await domainOf(siteId, name);
		expect(domain.lastCheckedAt?.getTime()).toBe(started + 56 * MINUTE);
		expect(domain.nextCheckAt?.getTime()).toBe(started + 61 * MINUTE);

		// Then hourly.
		await after(5 * MINUTE);
		domain = await domainOf(siteId, name);
		expect(domain.lastCheckedAt?.getTime()).toBe(started + 61 * MINUTE);
		expect(domain.nextCheckAt?.getTime()).toBe(started + HOUR + 61 * MINUTE);
		await after(HOUR);
		domain = await domainOf(siteId, name);
		expect(domain.nextCheckAt?.getTime()).toBe(started + 2 * HOUR + 61 * MINUTE);

		// After 7 days, only when Staff ask: pointing it at the Install now changes nothing by itself.
		await after(7 * DAY);
		domain = await domainOf(siteId, name);
		expect(domain).toMatchObject({ status: "waiting", nextCheckAt: null });
		install.connectDomain(name);
		await after(DAY);
		expect(await domainOf(siteId, name)).toMatchObject({ status: "waiting" });
		expect(verifyRequests(name)).toEqual([]);

		const { domain: checked } = await (await api()).domains.check({ siteId, domainId: domain.id });
		expect(checked).toMatchObject({ status: "active", problem: null });
	});

	test("Check now checks at once, and starts the checks every few minutes again", async () => {
		const { siteId, domainId } = await siteWithDomain("eager-bakery.example");
		await after(8 * DAY);

		const { domain } = await (await api()).domains.check({ siteId, domainId });

		expect(domain).toMatchObject({ status: "waiting", problem: "dns" });
		expect(domain.lastCheckedAt).toEqual(install.clock.now());
		expect(domain.nextCheckAt?.getTime()).toBe(install.clock.now().getTime() + 5 * MINUTE);
		install.connectDomain("eager-bakery.example");
		await after(5 * MINUTE);
		expect(await domainOf(siteId, "eager-bakery.example")).toMatchObject({ status: "active" });
	});

	test("only Staff check a domain", async () => {
		const { siteId, domainId } = await siteWithDomain("owner-checked-bakery.example");
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;

		await expect(owner.api.domains.check({ siteId, domainId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
