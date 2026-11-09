import { type InstallServices, isToolset, OPT_IN_TOOLSETS, type ToolsetKey, toolsetModule } from "@webcraft/core";

/** One Toolset a person can switch on for an API token or AI client, as the admin offers it. */
export type ToolsetOffered = {
	key: ToolsetKey;
	/** A Module's own Toolset: the Module's id and name (WebCraft's own are named by the admin's messages). */
	module: { id: string; name: string } | null;
	/** Off unless chosen, with a warning: Submissions hold what visitors typed into Forms. */
	optIn: boolean;
};

/** The Toolsets this Install offers, in order: WebCraft's own, then each Module's own. */
export function toolsetOffer(services: InstallServices): ToolsetOffered[] {
	return services.apiTokens.toolsets().map((key) => {
		const moduleId = toolsetModule(key);
		const module = moduleId ? services.modules.registry.get(moduleId) : undefined;
		const name = module?.manifest ? (Object.values(module.manifest.name)[0] ?? module.id) : moduleId;
		return {
			key,
			module: moduleId ? { id: moduleId, name: name ?? moduleId } : null,
			optIn: isToolset(key) && OPT_IN_TOOLSETS.includes(key),
		};
	});
}
