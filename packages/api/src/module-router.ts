import type { InstallServices } from "@webcraft/core";
import type { z } from "zod";

import { signedIn } from "./context.ts";
import { id } from "./inputs.ts";
import { languageOf } from "./procedures/modules.ts";
import { apiRouter } from "./router.ts";

type Registry = InstallServices["modules"]["registry"];

/** Each Module's procedures, by Module id, then by their names: `m.sample.notes.add`. */
type ModuleProcedureRouter = { [name: string]: ReturnType<typeof moduleProcedure> | ModuleProcedureRouter };

const built = new WeakMap<Registry, typeof apiRouter & { m: Record<string, ModuleProcedureRouter> }>();

/**
 * The whole Management API of an Install: WebCraft's procedures (`apiRouter`) and, under `m`, the
 * procedures of the Modules it loads. Each Module procedure takes the Site (`siteId`, Site-level
 * Modules) or Workspace (`workspaceId`) besides its own input, and runs through the Module host:
 * only where the Module runs, for people holding its Permission there.
 */
export function adminRouter(
	services: InstallServices,
): typeof apiRouter & { m: Record<string, ModuleProcedureRouter> } {
	const { registry } = services.modules;
	let router = built.get(registry);
	if (!router) {
		const m: Record<string, ModuleProcedureRouter> = {};
		for (const module of registry.all()) {
			if (!module.runnable) continue;
			const procedures: ModuleProcedureRouter = {};
			for (const [name, procedure] of module.procedures) {
				const parts = name.split(".");
				let group = procedures;
				for (const part of parts.slice(0, -1)) {
					group[part] ??= {};
					group = group[part] as ModuleProcedureRouter;
				}
				group[parts.at(-1) ?? name] = moduleProcedure(module.id, module.level, name, procedure.input);
			}
			m[module.id] = procedures;
		}
		router = { ...apiRouter, m };
		built.set(registry, router);
	}
	return router;
}

function moduleProcedure(moduleId: string, level: "site" | "workspace", name: string, input: z.ZodObject) {
	const placeKey = level === "site" ? "siteId" : "workspaceId";
	return signedIn.input(input.extend({ [placeKey]: id })).handler(async ({ context, input: given }) => {
		const { [placeKey]: placeId, ...own } = given as Record<string, unknown>;
		return context.services.modules.callProcedure({
			access: context.access,
			person: { id: context.person.id, language: await languageOf(context.services, context.person) },
			moduleId,
			procedure: name,
			placeId: String(placeId),
			input: own,
		});
	});
}
