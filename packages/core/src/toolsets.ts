/**
 * Toolsets (ADR 0030, `GLOSSARY.md`): named groups of related actions that a person switches on
 * for an AI client or an API token. A client can only call the procedures (MCP tools) of the
 * Toolsets switched on, and of those only what its person may do.
 *
 * WebCraft's own procedures each name the Toolsets they belong to (`packages/api/src/toolsets.ts`).
 * A Module's procedure names one of WebCraft's Toolsets (SDK 1.9: `toolset`), or belongs to the
 * Module's own Toolset, `m.<module id>`, when it names none.
 *
 * Submissions hold what visitors typed into Forms, so that Toolset is never on unless chosen.
 */
export const TOOLSETS = [
	"content",
	"media",
	"structure",
	"forms",
	"publishing",
	"translation",
	"siteSettings",
	"analytics",
	"submissions",
] as const;

/** One of WebCraft's own Toolsets. */
export type Toolset = (typeof TOOLSETS)[number];

/** A Toolset a client may have switched on: WebCraft's own, or a Module's own (`m.<module id>`). */
export type ToolsetKey = Toolset | `m.${string}`;

/** Toolsets that are off unless their person chooses them, knowingly: Submissions (visitors' data). */
export const OPT_IN_TOOLSETS: readonly Toolset[] = ["submissions"];

/** WebCraft's Toolsets a new API token or AI client starts with: every one but those that are opt-in. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = TOOLSETS.filter((toolset) => !OPT_IN_TOOLSETS.includes(toolset));

/** The Toolsets a new API token or AI client starts with: every one offered but those that are opt-in. */
export function defaultToolsets(offered: readonly ToolsetKey[]): ToolsetKey[] {
	return offered.filter((key) => !isToolset(key) || !OPT_IN_TOOLSETS.includes(key));
}

/** Whether `key` names one of WebCraft's own Toolsets. */
export function isToolset(key: string): key is Toolset {
	return (TOOLSETS as readonly string[]).includes(key);
}

/** The Toolset a Module's procedure belongs to when it names none of WebCraft's: the Module's own. */
export function moduleToolset(moduleId: string): ToolsetKey {
	return `m.${moduleId}`;
}

/** The Module whose own Toolset `key` is, or null for one of WebCraft's. */
export function toolsetModule(key: string): string | null {
	return key.startsWith("m.") && key.length > 2 ? key.slice(2) : null;
}

/** Why a client's choice of Toolsets was refused: a Toolset this Install doesn't offer. */
export class ToolsetUnknownError extends Error {
	override name = "ToolsetUnknownError";
	readonly toolset: string;
	constructor(toolset: string) {
		super(`There is no Toolset "${toolset}" on this Install.`);
		this.toolset = toolset;
	}
}

/** What the Toolsets offer needs to know about the Install's Modules. */
type ModulesOffering = {
	all(): Iterable<{
		readonly id: string;
		readonly runnable: boolean;
		readonly procedures?: ReadonlyMap<string, { readonly toolset?: string }>;
	}>;
};

/**
 * The Toolsets a person can switch on for a client on this Install: WebCraft's own, then the own
 * Toolset of each Module whose procedures don't all belong to one of WebCraft's.
 */
export function offeredToolsets(modules: ModulesOffering): ToolsetKey[] {
	const offered: ToolsetKey[] = [...TOOLSETS];
	for (const module of modules.all()) {
		if (!module.runnable || !module.procedures) continue;
		if ([...module.procedures.values()].some((procedure) => procedure.toolset === undefined)) {
			offered.push(moduleToolset(module.id));
		}
	}
	return offered;
}

/**
 * A client's chosen Toolsets, checked against what the Install offers: each once, in the order
 * they are offered. Throws `ToolsetUnknownError` for one the Install doesn't offer.
 */
export function chosenToolsets(chosen: readonly string[], offered: readonly ToolsetKey[]): ToolsetKey[] {
	for (const key of chosen) {
		if (!(offered as readonly string[]).includes(key)) throw new ToolsetUnknownError(key);
	}
	return offered.filter((key) => chosen.includes(key));
}
