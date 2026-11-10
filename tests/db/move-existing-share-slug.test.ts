// A Site slugged "share" from before Reports and Share links (#104) reserved that slug for the
// Share link address (`share.<sites domain>`, answered before any Site is resolved by hostname,
// `apps/server/src/site/pipeline.ts`): upgrading past that migration moves it to the first free
// `share-<n>` instead of silently losing its Staging address to the Share link host, and records
// the move in the Audit log as WebCraft itself (`docs/deploy/README.md` › "Upgrade notes").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { applyMigrationLevel, migrationsFolder } from "@webcraft/db";
import pg from "pg";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

/** The migration under test: every other migration, applied first, is "before the upgrade". */
const MOVE_SHARE_SLUG_MIGRATION = "20261109234551_move-existing-share-slug";

/** Every migration this build has except the one under test, in no particular order. */
function migrationsBefore(name: string): string[] {
	const names = readdirSync(migrationsFolder, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	expect(names).toContain(name);
	return names.filter((candidate) => candidate !== name);
}

describe('an Install already having a Site slugged "share" before it was reserved', () => {
	let install: TestInstall;
	let workspaceId: string;
	let siteId: string;

	beforeAll(async () => {
		install = await createTestInstall({ database: "empty" });
		// Every migration but the one under test: as an Install already had it, the day before upgrading
		// past #104 (no Module migrations are needed for this).
		await applyMigrationLevel(install.databaseUrl, { core: migrationsBefore(MOVE_SHARE_SLUG_MIGRATION), modules: {} });

		// A Site slugged "share", inserted directly: `checkSlug` (`packages/core/src/tenancy/sites.ts`)
		// refuses that slug once it is reserved, so this is how one got it, before that.
		const client = new pg.Client({ connectionString: install.databaseUrl });
		await client.connect();
		try {
			const workspace = await client.query<{ id: string }>(
				"INSERT INTO workspaces (name, created_at) VALUES ('Acme Ltd', now()) RETURNING id",
			);
			workspaceId = workspace.rows[0]?.id ?? "";
			const site = await client.query<{ id: string }>(
				"INSERT INTO sites (workspace_id, name, slug, created_at) VALUES ($1, 'Acme Share Drive', 'share', now()) RETURNING id",
				[workspaceId],
			);
			siteId = site.rows[0]?.id ?? "";
			await client.query(
				"INSERT INTO site_languages (workspace_id, site_id, code, name, direction, position, created_at) VALUES ($1, $2, 'en', 'English', 'ltr', 0, now())",
				[workspaceId, siteId],
			);
		} finally {
			await client.end();
		}
	});

	afterAll(async () => {
		await install.close();
	});

	test("moves to the first free share-<n>, stays reachable there, and the Share link address still answers", async () => {
		// The upgrade: every migration this build has, including the one under test.
		await install.migrate({ backup: false });

		const admin = await install.superadmin();
		const { site, stagingUrl } = await admin.api.sites.get({ siteId });
		expect(site.slug).toBe("share-1");
		expect(stagingUrl).toBe("https://share-1.sites.test");

		// Reachable at its new slug: the Site's own sign-in page (403), not the unbranded 404 a hostname
		// no Site has gets (`tests/sites/staging-address.test.ts`).
		const reviewer = await install.request("https://share-1.sites.test/");
		expect(reviewer.status).toBe(403);
		expect(await reviewer.text()).toContain("Acme Share Drive");

		// The Share link address is the Install's own, unaffected: an unknown token still answers its
		// own "gone" page, never the Site that used to sit there.
		const shareHost = await install.request(`https://share.sites.test/${"a".repeat(43)}`);
		expect(shareHost.status).toBe(404);
		expect(shareHost.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(await shareHost.text()).not.toContain("Acme Share Drive");

		// WebCraft itself recorded the move: no person acted, the migrate step did.
		const { entries } = await admin.api.audit.list({ limit: 20 });
		expect(entries).toContainEqual(
			expect.objectContaining({
				action: "site.slugChanged",
				personId: null,
				via: { kind: "command", name: "migrate" },
				workspaceId,
				siteId,
				details: { from: "share", to: "share-1" },
			}),
		);
	});
});
