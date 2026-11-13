/**
 * What the Design system screen shows beside what Staff edit (spec stories 65 to 70): the Draft
 * with the change not yet saved applied, as its compiled stylesheet (`compileStylesheet` over the
 * Draft, with every Class, so each can be shown), each colour's ramp in light and dark (and the
 * generated values beneath any override), each scale step's sizes, how many places use each Class
 * and token, and the contrast Check. Nothing is saved.
 */
import {
	BASE_TARGETS,
	type ColourMode,
	colourSteps,
	compileStylesheet,
	type DesignSystem,
	type Range,
	stepRange,
} from "@webcraft/renderer";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { type ContrastResult, contrastChecks } from "./contrast.ts";
import { draftDesignSystem } from "./design-systems.ts";
import { type DesignSystemChange, withChange } from "./drafts.ts";
import { type UseCounts, useCounts } from "./usage.ts";

/** A colour's steps in one mode, as shown and as generated without overrides. */
export type RampView = { shown: Record<string, string>; generated: Record<string, string> };

export type DesignSystemPreview = {
	/**
	 * The Draft's stylesheet with every Class, and with its dark values whether Dark mode is on or
	 * not, so the screen can show them (`data-wc-theme="dark"` on the preview's root).
	 */
	stylesheet: string;
	ramps: Record<string, Record<ColourMode, RampView>>;
	scales: Record<"space" | "text", { id: string; name: string; size: Range; custom: boolean }[]>;
	uses: UseCounts;
	contrast: ContrastResult[];
	/** The elements base styles can style, in the stylesheet's order. */
	baseTargets: readonly string[];
};

/** The Draft with an unsaved change, previewed. Throws `DesignSystemInvalidError` as saving it would. */
export async function previewDesignSystem(scope: SiteScope, change: DesignSystemChange): Promise<DesignSystemPreview> {
	const draft = withChange(await draftDesignSystem(scope), change);
	return { ...previewOf(draft), uses: await useCounts(scope, draft) };
}

function previewOf(draft: DesignSystem): Omit<DesignSystemPreview, "uses"> {
	const stylesheet = compileStylesheet(
		{ ...draft, darkMode: true },
		{ classIds: new Set(draft.classes.map((each) => each.id)) },
	);
	const ramps: DesignSystemPreview["ramps"] = {};
	for (const colour of draft.tokens.colours) {
		const plain = { ...colour, light: { ...colour.light, steps: {} }, dark: { ...colour.dark, steps: {} } };
		ramps[colour.id] = {
			light: { shown: colourSteps(colour, "light"), generated: colourSteps(plain, "light") },
			dark: { shown: colourSteps(colour, "dark"), generated: colourSteps(plain, "dark") },
		};
	}
	const scale = (kind: "space" | "text") =>
		draft.tokens[kind].steps.map((step) => ({
			id: step.id,
			name: step.name,
			size: stepRange(draft.tokens[kind], step),
			custom: step.size !== null,
		}));
	return {
		stylesheet,
		ramps,
		scales: { space: scale("space"), text: scale("text") },
		contrast: contrastChecks(draft),
		baseTargets: BASE_TARGETS,
	};
}
