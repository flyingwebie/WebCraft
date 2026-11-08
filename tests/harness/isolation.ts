// Workspace isolation (ADR 0007): every procedure that reads or changes a Workspace's data must
// refuse another Workspace's. `workspaceIsolation` makes that one line per procedure:
//
//     const isolation = workspaceIsolation(() => install);
//     isolation.refuses("sites.list", (api, { workspaceId }) => api.sites.list({ workspaceId }));
//
// Each line becomes a test: a person who reaches one Workspace ("ours") calls the procedure with
// our Workspace's ids, which must work, then with another Workspace's ids ("theirs"), which must be
// refused as not found (404) or forbidden (403).
import { expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";

import type { TestInstall } from "./index.ts";

/** The Workspace and Site a call is aimed at. */
export type IsolationTarget = { workspaceId: string; siteId: string };

/** Calls one procedure, aimed at `target`, as the person whose API it is given. */
export type IsolationCall = (api: ApiClient, target: IsolationTarget) => Promise<unknown>;

/** Who makes the call: Staff assigned to our Workspace only, or a Member of it reaching all its Sites. */
export type IsolationActor = "staff" | "owner" | "editor" | "author";

type Fixture = {
	ours: IsolationTarget;
	theirs: IsolationTarget;
	apis: Record<IsolationActor, ApiClient>;
};

export type WorkspaceIsolation = {
	/**
	 * Adds a test that `call` works on our Workspace and is refused on theirs, for each actor in `as`
	 * (Staff by default). Give the procedure's name as the router names it, such as `sites.list`.
	 */
	refuses(procedure: string, call: IsolationCall, options?: { as?: readonly IsolationActor[] }): void;
	/** The procedures given to `refuses` so far. */
	readonly covered: ReadonlySet<string>;
};

export function workspaceIsolation(install: () => TestInstall): WorkspaceIsolation {
	let fixture: Promise<Fixture> | undefined;
	const covered = new Set<string>();
	const ready = () => {
		fixture ??= createFixture(install());
		return fixture;
	};

	return {
		covered,
		refuses(procedure, call, options = {}) {
			covered.add(procedure);
			for (const actor of options.as ?? ["staff"]) {
				test(`${procedure} refuses another Workspace's data (${actor})`, async () => {
					const { ours, theirs, apis } = await ready();
					const api = apis[actor];

					// The call itself is right: it works on the Workspace the person reaches.
					await call(api, ours);

					const refusal = await call(api, theirs).then(
						() => ({ status: "answered" }),
						(error: unknown) => error as { status?: unknown },
					);
					expect([403, 404]).toContain(refusal.status as number);
				});
			}
		},
	};
}

async function createFixture(install: TestInstall): Promise<Fixture> {
	const target = async (name: string) => {
		const workspace = await install.createWorkspace(name);
		const site = await install.createSite(workspace.id);
		return { workspaceId: workspace.id, siteId: site.id };
	};
	const ours = await target("Our Workspace");
	const theirs = await target("Their Workspace");
	const member = async (role: "owner" | "editor" | "author") =>
		(await install.createMember({ workspaceId: ours.workspaceId, role })).browser.api;
	return {
		ours,
		theirs,
		apis: {
			staff: (await install.createStaff({ workspaces: [ours.workspaceId] })).browser.api,
			owner: await member("owner"),
			editor: await member("editor"),
			author: await member("author"),
		},
	};
}
