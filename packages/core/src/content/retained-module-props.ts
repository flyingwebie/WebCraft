/** Authoring stays on one Prop contract while an imported Module's source version is unavailable. */
import { type ElementTree, ElementTreeInvalidError, placementsIn } from "@webcraft/renderer";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { sameJson } from "./json.ts";

const RETAINED_MODULE_PROPS_MESSAGE =
	"This Module Component uses retained source Props. Restore a compatible approved Module before inserting it or changing its Props.";

/** All editor/API/history paths converge on these checked Draft writes. Unrelated edits may proceed. */
export async function checkRetainedModulePlacements(
	scope: SiteScope,
	next: ElementTree,
	previous: ElementTree | undefined,
): Promise<void> {
	const retained = await scope.componentSources.retainedModuleComponentsAt(scope);
	if (retained.length === 0) return;
	const active = new Set((await scope.componentSources.moduleComponentsAt(scope)).map((component) => component.id));
	const blocked = new Set(retained.filter((component) => !active.has(component.id)).map((component) => component.id));
	if (blocked.size === 0) return;
	const before = new Map([...placementsIn(previous?.nodes ?? [])].map((placement) => [placement.id, placement]));
	const problems: { at: string; message: string }[] = [];
	for (const placement of placementsIn(next.nodes)) {
		if (!blocked.has(placement.component)) continue;
		const old = before.get(placement.id);
		if (!old || old.component !== placement.component || !sameJson(old.props, placement.props))
			problems.push({ at: `nodes.${placement.id}.props`, message: RETAINED_MODULE_PROPS_MESSAGE });
	}
	if (problems.length) throw new ElementTreeInvalidError(problems);
}
