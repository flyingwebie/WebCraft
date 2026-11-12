import type { ApiClient } from "@webcraft/api";
import type { FieldInput } from "@webcraft/core";

import type { BuilderTarget } from "./model.ts";

/**
 * Saves the builder's Draft (ADR 0017): Template markup, through the same saves as Code mode, the CLI
 * and AI clients, based on the version the builder opened (`CHANGED_MEANWHILE` when someone saved it
 * since), with a Component's Props. One-off styles in the markup become generated Classes there. The
 * shared document handles tree and Prop edits; this path creates a first Draft and materializes
 * pending inline styles as Classes through the canonical saver.
 */
export async function saveDraft(
	api: ApiClient,
	siteId: string,
	target: BuilderTarget,
	change: { markup: string; props: FieldInput[] | null; basedOn: string | null },
) {
	const { markup, basedOn } = change;
	const save = async () => {
		switch (target.kind) {
			case "siteTemplate":
				return api.templates.saveSiteTemplateMarkup({ siteId, markup, basedOn });
			case "searchTemplate":
				return api.templates.saveSearchTemplateMarkup({ siteId, markup, basedOn });
			case "entryTemplate":
				return api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: target.postTypeId, markup, basedOn });
			case "archiveTemplate":
				return api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: target.postTypeId, markup, basedOn });
			case "component":
				return api.components.saveMarkup({
					siteId,
					componentId: target.componentId,
					markup,
					basedOn,
					...(change.props ? { props: change.props } : {}),
				});
		}
	};
	const stored = await save();
	const item = "component" in stored ? stored.component : stored.template;
	return {
		...stored,
		history: {
			resource: `draft:${siteId}:${"component" in stored ? "component" : "template"}:${item.id}`,
			after: item.draft,
		},
	};
}

/** Publishes the Template or Component: what visitors see changes at once. */
export async function publishDraft(
	api: ApiClient,
	siteId: string,
	target: BuilderTarget,
	templateId: string | null,
): Promise<void> {
	if (target.kind === "component") {
		await api.components.publish({ siteId, componentId: target.componentId });
		return;
	}
	if (templateId) await api.templates.publish({ siteId, templateId });
}
