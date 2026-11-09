/**
 * The HTML panel's markup (ADR 0016, ADR 0017): previewing it as Staff type, through the same parser
 * and rules as saving it, and saving it to the Draft of the Template or Component it is, only when
 * Staff save and only if it parses. A save names the version of the Draft it was opened at, so it
 * never overwrites someone else's save (`DraftChangedError`).
 */
import type { MarkupNotice } from "@webcraft/renderer";
import { readComponentMarkup, saveComponentMarkup } from "../content/components.ts";
import { readTemplateMarkup, saveEntryTemplateMarkup, saveSiteTemplateMarkup } from "../content/templates.ts";
import { draftStyles, draftTrees } from "../design-system/stylesheet.ts";
import type { CodePreview, SiteHost } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { CodeSourceNotFoundError } from "./errors.ts";
import { readCodeRef, resolveSource, type SourceDeps } from "./sources.ts";

/** Markup typed for one Template or Component, by its reference (`content/<placement id>`), not saved yet. */
export type MarkupChange = { ref: string; text: string };

/**
 * What a page in Code mode shows with unsaved markup: the tree it reads as, in place of its source's
 * Draft, and the styles it would have (generated Classes for inline styles included). Without a
 * change, the Drafts as they are. Throws `TemplateMarkupInvalidError` as saving would.
 */
export async function previewMarkup(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	path: string,
	change: MarkupChange | undefined,
): Promise<{ preview: CodePreview; notices: MarkupNotice[] }> {
	if (!change) return { preview: { styles: await draftStyles(scope) }, notices: [] };
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
		if (source.kind === "siteTemplate") {
			const template = await readTemplateMarkup(scope, { kind: "site" }, change.text, deps.sources);
			return { ...template, source: { kind: "siteTemplate", tree: template.tree } } as const;
		}
		throw new CodeSourceNotFoundError();
	};
	const { tree, notices, designSystem, source: shown } = await read();
	const styles = await draftStyles(scope, { designSystem, trees: [...(await draftTrees(scope)), tree] });
	return { preview: { source: shown, styles }, notices };
}

/** What saving markup answers: the markup as stored now (new elements with their ids), its version and notices. */
export type SavedMarkup = { markup: string; version: string; notices: MarkupNotice[] };

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
	const { source } = await resolveSource(scope, deps, host, input.path, readCodeRef(input.ref));
	const base = { basedOn: input.version };
	if (source.kind === "component" && source.id !== null) {
		const saved = await saveComponentMarkup(scope, source.id, { markup: input.markup }, deps.sources, base);
		return { markup: saved.markup, version: saved.version, notices: saved.notices };
	}
	if (source.kind === "entryTemplate" && source.postTypeId !== null) {
		const saved = await saveEntryTemplateMarkup(scope, source.postTypeId, input.markup, deps.sources, base);
		return { markup: saved.markup, version: saved.version, notices: saved.notices };
	}
	if (source.kind === "siteTemplate") {
		const saved = await saveSiteTemplateMarkup(scope, input.markup, deps.sources, base);
		return { markup: saved.markup, version: saved.version, notices: saved.notices };
	}
	throw new CodeSourceNotFoundError();
}
