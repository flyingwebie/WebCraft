import { clientRefusal, openApiDocument, publicProcedure } from "@webcraft/api";
import {
	type AddedPermission,
	type ApiClientUse,
	can,
	type InstallServices,
	PERMISSIONS,
	type Permission,
} from "@webcraft/core";

import { type GeneratedTool, generateTools } from "./tools.ts";

const generated = new WeakMap<object, GeneratedTool[]>();

/** Every tool of the Install's public procedures (its Modules' included), generated once per document. */
export async function allTools(services: InstallServices): Promise<GeneratedTool[]> {
	const document = await openApiDocument(services);
	let tools = generated.get(document);
	if (!tools) {
		tools = generateTools(document);
		generated.set(document, tools);
	}
	return tools;
}

/** Where an API client reaches: its Workspace and the Sites of it it reaches. */
export type ClientPlaces = { workspaceId: string; sites: { id: string; workspaceId: string }[] };

/** The Workspace and Sites an API client (a token or a grant) reaches now. */
export async function placesOf(services: InstallServices, use: ApiClientUse): Promise<ClientPlaces> {
	const { actor } = use.access;
	if (actor.kind !== "token" && actor.kind !== "grant") return { workspaceId: "", sites: [] };
	const workspace = await services.data.workspace(use.access, actor.workspaceId, "workspace.view").catch(() => null);
	if (!workspace) return { workspaceId: actor.workspaceId, sites: [] };
	// The Sites of the Workspace the client sees: those it reaches.
	const sites = await services.sites.list(workspace);
	return {
		workspaceId: actor.workspaceId,
		sites: sites.map((site) => ({ id: site.id, workspaceId: site.workspaceId })),
	};
}

/**
 * The tools a client's session lists: those in a Toolset switched on for it (or for every client),
 * that it may call (only reads when it is read-only; nothing that publishes unless its person let
 * it), whose Permission its person holds somewhere it reaches, and, for a Module's tools, where
 * that Module runs. Each tool still checks the exact Permission on what it is called on.
 */
export async function listedTools(services: InstallServices, use: ApiClientUse): Promise<GeneratedTool[]> {
	const tools = await allTools(services);
	const places = await placesOf(services, use);
	const runs = new Map<string, Promise<boolean>>();
	const moduleRuns = (moduleId: string) => {
		let answer = runs.get(moduleId);
		if (!answer) {
			const module = services.modules.registry.get(moduleId);
			answer =
				module?.runnable && module.level === "workspace"
					? Promise.resolve(true)
					: Promise.all(places.sites.map((site) => services.modules.runsOn(site, moduleId))).then((each) =>
							each.some(Boolean),
						);
			runs.set(moduleId, answer);
		}
		return answer;
	};
	const listed: GeneratedTool[] = [];
	for (const tool of tools) {
		const procedure = publicProcedure(services, tool.path);
		if (!procedure || clientRefusal(use.client, procedure)) continue;
		if (!holdsAny(use, places, procedure.needs)) continue;
		if (tool.path[0] === "m" && !(await moduleRuns(tool.path[1] ?? ""))) continue;
		listed.push(tool);
	}
	return listed;
}

/** Whether the client's person holds one of `needs` on its Workspace or one of the Sites it reaches. */
function holdsAny(use: ApiClientUse, places: ClientPlaces, needs: readonly (Permission | AddedPermission)[]): boolean {
	if (needs.length === 0) return true;
	const { actor } = use.access;
	return needs.some((need) => {
		const levels: readonly string[] = typeof need === "string" ? permissionLevels(need) : need.levels;
		if (levels.includes("workspace") && can(actor, need, { level: "workspace", workspaceId: places.workspaceId })) {
			return true;
		}
		return (
			levels.includes("site") &&
			places.sites.some((site) => can(actor, need, { level: "site", workspaceId: site.workspaceId, siteId: site.id }))
		);
	});
}

/** The levels a Permission is checked at: `can()` throws on another, so it is only asked there. */
function permissionLevels(permission: Permission): readonly string[] {
	return PERMISSIONS[permission];
}
