// What the building area's chrome starts from (ADR 0037, BA-04): beside the session's header token
// and the page to frame, the shell's document carries the Site and the person (the avatar, the Site's
// settings in the admin), the Design system's breakpoints and Dark mode (the size readout, Dark
// preview) as its Draft has them, and the Site's Staging address for "View on Staging".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	// On its Primary domain, so the Staging address is another place to view the Site.
	await goLive(install, siteId);
});

afterAll(async () => {
	await install.close();
});

describe("the shell's chrome", () => {
	test("starts from the Site, the person, the Design system's Draft and the Staging address", async () => {
		const { draft } = (await staff.api.designSystem.get({ siteId })).designSystem;
		// Changed in the Draft only: the building area shows what is being built.
		await staff.api.designSystem.saveDraft({
			siteId,
			darkMode: true,
			tokens: {
				...draft.tokens,
				breakpoints: [
					...draft.tokens.breakpoints.map((each) => (each.width === 768 ? { ...each, name: "tablet" } : each)),
					{ name: "phone", width: 480 },
				],
			},
		});

		const building = await openBuildingArea(install, staff, siteId);
		const config = shellConfigIn(await (await building.shell(building.landed)).text());

		expect(config).toMatchObject({
			site: { id: siteId, name: "Acme Bakery" },
			person: { name: "Davide Del Gatto" },
			darkMode: true,
			settings: install.adminUrl(`/sites/${siteId}/domains`),
		});
		// Narrowest first, by name and width only.
		expect(config?.breakpoints).toEqual([
			{ name: "phone", width: 480 },
			{ name: "tablet", width: 768 },
			{ name: "lg", width: 1024 },
			{ name: "xl", width: 1280 },
			{ name: "2xl", width: 1536 },
		]);
		expect(String(config?.staging)).toMatch(/^https?:\/\/bakery\.[^/]+$/);
		expect(config?.staging).not.toBe(building.origin);
	});
});
