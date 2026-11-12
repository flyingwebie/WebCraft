/**
 * The HTML panel's markup (ADR 0016, ADR 0017): previewing it as Staff type, through the same parser
 * and rules as saving it, and saving it to the Draft of the Template or Component it is, only when
 * Staff save and only if it parses. A save names the version of the Draft it was opened at, so it
 * never overwrites someone else's save (`DraftChangedError`).
 */

import type { MarkupNotice } from "@webcraft/renderer";
import type { Json } from "../co-editing/document.ts";
import { readComponentMarkup, saveComponentMarkup } from "../content/components.ts";
import {
	readTemplateMarkup,
	saveArchiveTemplateMarkup,
	saveEntryTemplateMarkup,
	saveSearchTemplateMarkup,
	saveSiteTemplateMarkup,
} from "../content/templates.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { draftStyles, draftTrees } from "../design-system/stylesheet.ts";
import type { CodePreview, SiteHost } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type CssTarget, previewCss } from "./css.ts";
import { CodeSourceNotFoundError } from "./errors.ts";
import { readCodeRef, resolveSource, type SourceDeps } from "./sources.ts";

/** Markup typed for one Template or Component, by its reference (`content/<placement id>`), not saved yet. */
export type MarkupChange = { ref: string; text: string };

/**
 * What a page in Code mode shows with unsaved changes: markup read as the tree it would save as, in
 * place of its source's Draft, and CSS read into the Design system's Draft, with the styles that
 * makes (generated Classes for inline styles included). Without changes, the Drafts as they are.
 * Throws `TemplateMarkupInvalidError` and `DesignSystemInvalidError` as saving would.
 */
export async function previewMarkup(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	path: string,
	change: MarkupChange | undefined,
	css?: { target: CssTarget; text: string },
): Promise<{ preview: CodePreview; notices: MarkupNotice[] }> {
	if (!change) {
		if (!css) return { preview: { styles: await draftStyles(scope) }, notices: [] };
		const designSystem = previewCss(await draftDesignSystem(scope), css);
		return { preview: { styles: await draftStyles(scope, { designSystem }) }, notices: [] };
	}
	const { source } = await resolveSource(scope, deps, host, path, readCodeRef(change.ref));
	const read = async () => {
		if (source.kind === "component" && source.id !== null) {
			const component = await readComponentMarkup(scope, source.id, change.text, deps.sources);
			return { ...component, source: { kind: "component", id: source.id, version: component.version } } as const;
		}
		if (source.kind === "entryTemplate" && source.postTypeId !== null) {
			const template = await readTemplateMarkup(
				scope,
				{ kind: "entry", postTypeId: source.postTypeId },
				change.text,
				deps.sources,
			);
			return { ...template, source: { kind: "entryTemplate", tree: template.tree } } as const;
		}
		if (source.kind === "archiveTemplate" && source.postTypeId !== null) {
			const template = await readTemplateMarkup(
				scope,
				{ kind: "archive", postTypeId: source.postTypeId },
				change.text,
				deps.sources,
			);
			return { ...template, source: { kind: "archiveTemplate", tree: template.tree } } as const;
		}
		if (source.kind === "searchTemplate") {
			const template = await readTemplateMarkup(scope, { kind: "search" }, change.text, deps.sources);
			return { ...template, source: { kind: "searchTemplate", tree: template.tree } } as const;
		}

		if (source.kind === "siteTemplate") {
			const template = await readTemplateMarkup(scope, { kind: "site" }, change.text, deps.sources);
			return { ...template, source: { kind: "siteTemplate", tree: template.tree } } as const;
		}
		throw new CodeSourceNotFoundError();
	};
	const { tree, notices, designSystem: withClasses, source: shown } = await read();
	const designSystem = css ? previewCss(withClasses, css) : withClasses;
	const styles = await draftStyles(scope, { designSystem, trees: [...(await draftTrees(scope)), tree] });
	return { preview: { source: shown, styles }, notices };
}

/** What saving markup answers: the markup as stored now (new elements with their ids), its version and notices. */
export type SavedMarkup = {
	markup: string;
	version: string;
	notices: MarkupNotice[];
	history: { resource: string; before: Json; after: Json }[];
};

/**
 * Saves markup to the Draft of the Template or Component a reference names, through the same saves
 * as the Management API (`templates.save…Markup`, `components.saveMarkup`), based on the version
 * it was opened at (null: there was no Draft yet).
 */
export async function saveMarkup(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	input: { path: string; ref: string; markup: string; version: string | null },
): Promise<SavedMarkup> {
	return scope.transaction(async (scope) => {
		const { source } = await resolveSource(scope, deps, host, input.path, readCodeRef(input.ref));
		const base = { basedOn: input.version };
		const designBefore = await draftDesignSystem(scope);
		const finish = async (
			saved: { markup: string; version: string; notices: MarkupNotice[] },
			item: { id: string; draft: unknown },
			kind: string,
		): Promise<SavedMarkup> => {
			const designAfter = await draftDesignSystem(scope);
			const used = JSON.stringify(item.draft);
			const created = designAfter.classes.filter(
				(each) => !designBefore.classes.some((old) => old.id === each.id) && used.includes(`"${each.id}"`),
			);
			const history: SavedMarkup["history"] = [];
			if (created.length)
				history.push({
					resource: `draft:${scope.site.id}:designSystem`,
					before: designBefore as unknown as Json,
					after: { ...designBefore, classes: [...designBefore.classes, ...created] } as unknown as Json,
				});
			history.push({
				resource: `draft:${scope.site.id}:${kind}:${item.id}`,
				before: (source.draft ?? source.tree) as Json,
				after: item.draft as Json,
			});
			return { markup: saved.markup, version: saved.version, notices: saved.notices, history };
		};
		if (source.kind === "component" && source.id !== null) {
			const saved = await saveComponentMarkup(scope, source.id, { markup: input.markup }, deps.sources, base);
			return finish(saved, saved.component, "component");
		}
		if (source.kind === "entryTemplate" && source.postTypeId !== null) {
			const saved = await saveEntryTemplateMarkup(scope, source.postTypeId, input.markup, deps.sources, base);
			return finish(saved, saved.template, "template");
		}
		if (source.kind === "archiveTemplate" && source.postTypeId !== null) {
			const saved = await saveArchiveTemplateMarkup(scope, source.postTypeId, input.markup, deps.sources, base);
			return finish(saved, saved.template, "template");
		}
		if (source.kind === "searchTemplate") {
			const saved = await saveSearchTemplateMarkup(scope, input.markup, deps.sources, base);
			return finish(saved, saved.template, "template");
		}
		if (source.kind === "siteTemplate") {
			const saved = await saveSiteTemplateMarkup(scope, input.markup, deps.sources, base);
			return finish(saved, saved.template, "template");
		}
		throw new CodeSourceNotFoundError();
	});
}
