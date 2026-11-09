/**
 * Publishing the Design system: its Draft (tokens, Classes, base styles, custom CSS, dark mode)
 * becomes what visitors see, as one item. Generated Classes, made from inline styles in Template
 * markup, go live with the Template that made them instead: they are part of that Template's look,
 * and nothing about them can differ between the Draft and the published version until Staff change
 * them, when they stop being generated.
 */
import { designSystems } from "@webcraft/db/schema";
import {
	type DesignClass,
	type DesignSystem,
	DesignSystemInvalidError,
	defaultDesignSystem,
	designSystemNames,
	designSystemProblems,
	type ElementTree,
	readDesignSystem,
	referencesIn,
} from "@webcraft/renderer";
import { eq } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { lockDesignSystem } from "./design-systems.ts";
import { classIdsIn } from "./stylesheet.ts";

/** What publishing the Design system did. */
export type PublishedDesignSystem = { id: string; publishedAt: Date };

/**
 * Publishes the Design system's Draft (open the Site with `structure.edit`): in the publish's
 * transaction, which also clears the page cache. Refused when the Draft can't be used as it is
 * (`DesignSystemInvalidError`).
 */
export async function publishDesignSystem(scope: SiteScope): Promise<PublishedDesignSystem> {
	const locked = await lockDesignSystem(scope);
	const problems = designSystemProblems(locked.draft);
	if (problems.length > 0) throw new DesignSystemInvalidError(problems);
	const now = scope.now();
	await scope.update(
		designSystems,
		{ published: locked.draft, publishedAt: locked.row.publishedAt ?? now, lastPublishedAt: now },
		eq(designSystems.id, locked.row.id),
	);
	await scope.audit("designSystem.publish", {
		designSystemId: locked.row.id,
		classes: locked.draft.classes.length,
		darkMode: locked.draft.darkMode,
	});
	return { id: locked.row.id, publishedAt: now };
}

/**
 * Brings the generated Classes a Template being published uses into the published Design system,
 * so its inline styles show with it. Classes Staff made or changed wait for the Design system's own
 * publish, and so does a generated Class that needs a token visitors don't have yet.
 */
export async function publishGeneratedClasses(scope: SiteScope, tree: ElementTree): Promise<void> {
	const used = classIdsIn([tree]);
	const row = await scope.first(designSystems);
	if (!row || !readDesignSystem(row.draft).classes.some((each) => each.generated && used.has(each.id))) return;
	const locked = await lockDesignSystem(scope);
	const published = locked.published ?? defaultDesignSystem();
	const adding = locked.draft.classes.filter(
		(each) => each.generated && used.has(each.id) && fitsInto(published, each),
	);
	if (adding.length === 0) return;
	const next: DesignSystem = { ...published, classes: [...published.classes, ...adding] };
	if (designSystemProblems(next).length > 0) return;
	await scope.update(designSystems, { published: next }, eq(designSystems.id, locked.row.id));
}

/** Whether a Class can join a Design system as it is: its id and name are free, and every token it needs is there. */
function fitsInto(designSystem: DesignSystem, candidate: DesignClass): boolean {
	if (designSystem.classes.some((each) => each.id === candidate.id || each.name === candidate.name)) return false;
	const names = designSystemNames(designSystem);
	const { tokens, classes } = referencesIn([
		...candidate.styles,
		...candidate.css,
		...Object.values(candidate.breakpoints).flat(),
	]);
	return (
		tokens.every((ref) => names.tokens.propertyOf(ref) !== undefined) &&
		classes.every((id) => names.classIds.has(id)) &&
		Object.keys(candidate.breakpoints).every((id) => designSystem.tokens.breakpoints.some((each) => each.id === id))
	);
}
