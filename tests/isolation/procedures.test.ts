// Workspace isolation (ADR 0007): every procedure that takes a Workspace or a Site refuses another
// Workspace's data. Each procedure gets one line here; the last test fails when one is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { traverseContractProcedures } from "@orpc/server";
import { apiRouter } from "@webcraft/api";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { workspaceIsolation } from "../harness/isolation.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

const isolation = workspaceIsolation(() => install);

/** A slug no other call has used. */
let slugs = 0;
const newSlug = () => `isolation-${++slugs}`;

/** An email address no other call has used. */
let addresses = 0;
const newAddress = () => `isolation-${++addresses}@client.example`;

/** A pending Member invite in the Workspace, made by the Superadmin, who reaches every Workspace. */
async function inviteIn(workspaceId: string): Promise<string> {
	const admin = await install.superadmin();
	const { invite } = await admin.api.members.invite({ workspaceId, email: newAddress(), role: "author", sites: "all" });
	return invite.id;
}

/** A Member of the Workspace, made the way people become one. */
async function memberOf(workspaceId: string): Promise<string> {
	return (await install.createMember({ workspaceId, role: "author" })).personId;
}

describe("Workspaces", () => {
	isolation.refuses("workspaces.get", (api, { workspaceId }) => api.workspaces.get({ workspaceId }), {
		as: ["staff", "owner", "author"],
	});
});

describe("Sites", () => {
	isolation.refuses("sites.list", (api, { workspaceId }) => api.sites.list({ workspaceId }), {
		as: ["staff", "editor"],
	});
	isolation.refuses("sites.get", (api, { siteId }) => api.sites.get({ siteId }), { as: ["staff", "author"] });
	isolation.refuses("sites.create", (api, { workspaceId }) =>
		api.sites.create({ workspaceId, name: "Leaked Site", slug: newSlug() }),
	);
});

describe("Members", () => {
	isolation.refuses("members.list", (api, { workspaceId }) => api.members.list({ workspaceId }), {
		as: ["staff", "owner"],
	});
	isolation.refuses(
		"members.invite",
		(api, { workspaceId }) => api.members.invite({ workspaceId, email: newAddress(), role: "author", sites: "all" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.resendInvite",
		async (api, { workspaceId }) => api.members.resendInvite({ workspaceId, inviteId: await inviteIn(workspaceId) }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.revokeInvite",
		async (api, { workspaceId }) => api.members.revokeInvite({ workspaceId, inviteId: await inviteIn(workspaceId) }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.changeAccess",
		async (api, { workspaceId }) =>
			api.members.changeAccess({ workspaceId, personId: await memberOf(workspaceId), role: "editor", sites: "all" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.remove",
		async (api, { workspaceId }) => api.members.remove({ workspaceId, personId: await memberOf(workspaceId) }),
		{ as: ["staff", "owner"] },
	);
});

test("every procedure that takes a Workspace or a Site has an isolation test above", async () => {
	const scoped: string[] = [];
	await traverseContractProcedures({ router: apiRouter, path: [] }, ({ contract, path }) => {
		const shape = (contract["~orpc"].inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
		if ("workspaceId" in shape || "siteId" in shape) scoped.push(path.join("."));
	});

	expect(scoped.length).toBeGreaterThan(0);
	expect(scoped.filter((procedure) => !isolation.covered.has(procedure))).toEqual([]);
});
