/**
 * Code mode's CSS panel (ADR 0016, ADR 0009): the selected element's Classes (each one's styles for
 * every width, each breakpoint's styles, its own CSS) or the Site CSS, read and saved through the
 * Design system's Draft and its CSS checks, with the design tokens' custom properties to suggest.
 */
import { type DesignSystem, designSystemNames, type Tokens, UTILITY_ID_PREFIX } from "@webcraft/renderer";

import { DraftChangedError } from "../content/errors.ts";
import { draftVersion } from "../content/json.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import {
	changeDraft,
	createClass,
	type DesignSystemChange,
	type EditableClass,
	type EditableDesignSystem,
	editable,
	keepClasses,
	withChange,
} from "../design-system/drafts.ts";
import { ClassNotFoundError } from "../design-system/errors.ts";
import type { SiteHost } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { findNode, readCodeRef, resolveSource, type SourceDeps } from "./sources.ts";

/** A Class as the CSS panel edits it: its CSS as text, and the version a save names. */
export type CodeClass = EditableClass & { version: string };

/** What the CSS panel shows for an element. */
export type CodeCss = {
	/** The element's Classes, in its order (token utilities left out: they are the tokens'). */
	classes: CodeClass[];
	/** The Design system's breakpoints, which a Class's breakpoint styles apply from. */
	breakpoints: { id: string; name: string; width: number }[];
	/** The Site-wide custom CSS, and the version a save names. */
	siteCss: { css: string; version: string };
	/** The design tokens' custom properties, to suggest in `var()`, with their (light) values. */
	tokens: { property: string; value: string; kind: TokenKind }[];
};

export type TokenKind = "colour" | "space" | "text" | "font" | "radius" | "shadow" | "width";

/** Which CSS a save or preview changes: one piece of a Class, or the Site CSS. */
export type CssTarget =
	| { kind: "class"; classId: string; part: "styles" }
	| { kind: "class"; classId: string; part: "css" }
	| { kind: "class"; classId: string; part: "breakpoint"; breakpointId: string }
	| { kind: "site" };

/** What the CSS panel shows for the element a reference names (none: the Site CSS only). */
export async function readCss(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	input: { path: string; ref: string | null },
): Promise<CodeCss> {
	const designSystem = await draftDesignSystem(scope);
	const view = editable(designSystem);
	let classes: CodeClass[] = [];
	if (input.ref !== null) {
		const ref = readCodeRef(input.ref);
		const { source } = await resolveSource(scope, deps, host, input.path, ref);
		const found = ref.element ? findNode(source.tree.nodes, ref.element)?.node : undefined;
		const ids = found?.type === "element" ? found.classes.filter((id) => !id.startsWith(UTILITY_ID_PREFIX)) : [];
		classes = ids.flatMap((id) => {
			const each = view.classes.find((candidate) => candidate.id === id);
			return each ? [{ ...each, version: classVersion(each) }] : [];
		});
	}
	return {
		classes,
		breakpoints: [...designSystem.tokens.breakpoints]
			.sort((a, b) => a.width - b.width)
			.map(({ id, name, width }) => ({ id, name, width })),
		siteCss: { css: view.customCss, version: siteCssVersion(view.customCss) },
		tokens: tokensOf(designSystem),
	};
}

/** A Class's version: of all of it, so a save never overwrites another piece someone changed meanwhile. */
function classVersion(each: EditableClass): string {
	return draftVersion(each);
}

function siteCssVersion(css: string): string {
	return draftVersion({ customCss: css });
}

/** The change saving `text` at `target` makes to the Draft. */
function changeAt(target: CssTarget, text: string, draft: DesignSystem): DesignSystemChange {
	if (target.kind === "site") return { customCss: text };
	const current = editable(draft).classes.find((each) => each.id === target.classId);
	if (!current) throw new ClassNotFoundError();
	const piece =
		target.part === "styles"
			? { styles: text }
			: target.part === "css"
				? { css: text }
				: { breakpoints: { ...current.breakpoints, [target.breakpointId]: text } };
	return {
		classes: keepClasses(draft).map((each) => (each.id === target.classId ? { ...each, ...piece } : each)),
	};
}

/** The text of a target as stored now (with today's names), and its version. */
function storedAt(target: CssTarget, view: EditableDesignSystem): { text: string; version: string } {
	if (target.kind === "site") return { text: view.customCss, version: siteCssVersion(view.customCss) };
	const current = view.classes.find((each) => each.id === target.classId);
	if (!current) throw new ClassNotFoundError();
	const text =
		target.part === "styles"
			? current.styles
			: target.part === "css"
				? current.css
				: (current.breakpoints[target.breakpointId] ?? "");
	return { text, version: classVersion(current) };
}

/**
 * Saves CSS to the Design system's Draft, based on the version of the Class (or Site CSS) it was
 * opened at: refused with `DraftChangedError` when someone changed it meanwhile, and with
 * `DesignSystemInvalidError` (each problem with where) when the Design system's checks refuse it.
 */
export async function saveCss(
	scope: SiteScope,
	input: { target: CssTarget; text: string; version: string | null },
): Promise<{ text: string; version: string }> {
	const view = await changeDraft(scope, (draft) => {
		const now = storedAt(input.target, editable(draft)).version;
		if (now !== input.version) throw new DraftChangedError(now);
		return changeAt(input.target, input.text, draft);
	});
	return storedAt(input.target, view.draft);
}

/** The Draft with unsaved CSS in it, for a preview; throws `DesignSystemInvalidError` as saving would. */
export function previewCss(draft: DesignSystem, change: { target: CssTarget; text: string }): DesignSystem {
	return withChange(draft, changeAt(change.target, change.text, draft));
}

/** Makes a Class of the Draft from a name the HTML panel doesn't know, with no styles yet. */
export async function makeClass(scope: SiteScope, name: string): Promise<{ class: CodeClass }> {
	const made = await createClass(scope, { name });
	return { class: { ...made.class, version: classVersion(made.class) } };
}

/** The design tokens' custom properties, by kind, with their light values. */
function tokensOf(designSystem: DesignSystem): CodeCss["tokens"] {
	const kinds = tokenKinds(designSystem.tokens);
	return designSystemNames(designSystem).tokens.properties.map((property) => ({
		property: property.property,
		value: property.light,
		kind: kinds.get(property.ref.token) ?? "colour",
	}));
}

function tokenKinds(tokens: Tokens): Map<string, TokenKind> {
	const kinds = new Map<string, TokenKind>();
	for (const each of tokens.colours) kinds.set(each.id, "colour");
	for (const each of tokens.space.steps) kinds.set(each.id, "space");
	for (const each of tokens.text.steps) kinds.set(each.id, "text");
	for (const each of tokens.fonts) kinds.set(each.id, "font");
	for (const each of tokens.radius) kinds.set(each.id, "radius");
	for (const each of tokens.shadows) kinds.set(each.id, "shadow");
	for (const each of tokens.widths) kinds.set(each.id, "width");
	return kinds;
}
