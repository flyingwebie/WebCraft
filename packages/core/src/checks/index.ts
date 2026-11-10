import { templates } from "@webcraft/db/schema";
import type { QualityCheck } from "@webcraft/renderer";
import { renderPreview } from "../builder/preview.ts";
import { type BuilderTarget, readSource } from "../builder/sources.ts";
import { type ComponentSources, listComponents } from "../content/components.ts";
import { type Entry, getEntry, listEntries } from "../content/entries.ts";
import { siteLanguages } from "../content/languages.ts";
import { listPostTypes } from "../content/post-types.ts";
import type { TemplateKind } from "../content/templates.ts";
import { designSystemChecks } from "../design-system/contrast.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { can } from "../permissions/can.ts";
import type { SitePages } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

export type SiteCheck = {
	check: string;
	at: string;
	detail?: string;
	componentId?: string;
	params?: Readonly<Record<string, number>>;
	item: {
		kind: "entry" | "template" | "component" | "designSystem";
		id: string;
		name: string;
		templateKind?: TemplateKind;
	};
	language: string;
	href: string;
};
export function createChecks(pages: SitePages, sources: ComponentSources) {
	const collectEntry = async (scope: SiteScope, item: Entry): Promise<SiteCheck[]> => {
		const lang = item.language;
		const base = {
			item: { kind: "entry" as const, id: item.id, name: item.draft.title },
			language: lang,
			href: `/sites/${scope.site.id}/entries/${item.postTypeId}/${item.id}?language=${encodeURIComponent(lang)}`,
		};
		const { checks: rendered, bodies, templateKind } = await pages.checkEntry(scope, item.id, lang);
		const checks = [
			...rendered,
			...item.checks.filter(
				(c) =>
					c.check.startsWith("seo") ||
					(!(c.check === "skippedHeading" && bodies.some((path) => c.at.startsWith(`fields.${path}[`))) &&
						!rendered.some((r) => r.check === c.check && r.at === c.at)),
			),
		];
		const structure = can(scope.access.actor, "structure.edit", {
			level: "site",
			workspaceId: scope.site.workspaceId,
			siteId: scope.site.id,
		});
		return checks.map((c) => {
			const componentId = "componentId" in c ? c.componentId : undefined;
			const target = componentId
				? `component/${componentId}`
				: c.at === "site" || c.at.startsWith("site#")
					? "site-template"
					: c.at === "content" || c.at.startsWith("content#")
						? templateKind === "search"
							? "search-template"
							: templateKind === "entry"
								? `entry-template/${item.postTypeId}`
								: undefined
						: undefined;
			const href =
				structure && target ? builderLink(scope.site.id, target, c.at) : `${base.href}#${encodeURIComponent(c.at)}`;
			return { ...c, ...base, href };
		});
	};
	return {
		entry: async (scope: SiteScope, entryId: string, language?: string) =>
			collectEntry(scope, await getEntry(scope, entryId, language)),
		async list(scope: SiteScope): Promise<SiteCheck[]> {
			const checks: SiteCheck[] = [];
			const site = await siteLanguages(scope);
			const postTypes = await listPostTypes(scope);
			for (const language of site.languages) {
				for (const postType of postTypes) {
					for (const item of await listEntries(scope, postType.id, language.code))
						checks.push(...(await collectEntry(scope, item)));
				}
			}
			if (
				!can(scope.access.actor, "structure.edit", {
					level: "site",
					workspaceId: scope.site.workspaceId,
					siteId: scope.site.id,
				})
			)
				return checks;
			const targets: { target: BuilderTarget; item: SiteCheck["item"] }[] = [];
			for (const template of await scope.select(templates)) {
				const kind = template.kind as TemplateKind;
				const target: BuilderTarget =
					kind === "site"
						? { kind: "siteTemplate" }
						: kind === "search"
							? { kind: "searchTemplate" }
							: kind === "archive"
								? { kind: "archiveTemplate", postTypeId: template.postTypeId ?? "" }
								: { kind: "entryTemplate", postTypeId: template.postTypeId ?? "" };
				targets.push({
					target,
					item: {
						kind: "template",
						id: template.id,
						name: postTypes.find((p) => p.id === template.postTypeId)?.name ?? "",
						templateKind: kind,
					},
				});
			}
			for (const component of await listComponents(scope, sources))
				if (!component.module)
					targets.push({
						target: { kind: "component", componentId: component.id },
						item: { kind: "component", id: component.id, name: component.name },
					});
			for (const { target, item } of targets) {
				const source = await readSource(scope, target, sources);
				for (const language of site.languages) {
					const result = await renderPreview(scope, sources, {
						kind: source.kind,
						postType: source.postType,
						props: source.props,
						tree: source.draft,
						className: () => undefined,
						formKey: () => undefined,
						filterName: () => undefined,
						language: language.code,
					});
					const path =
						target.kind === "component"
							? `component/${target.componentId}`
							: target.kind === "entryTemplate"
								? `entry-template/${target.postTypeId}`
								: target.kind === "archiveTemplate"
									? `archive-template/${target.postTypeId}`
									: target.kind === "siteTemplate"
										? "site-template"
										: "search-template";
					for (const check of target.kind === "archiveTemplate"
						? await pages.checkArchive(scope, target.postTypeId, language.code)
						: result.checks)
						checks.push({
							...check,
							item,
							language: language.code,
							href: builderLink(
								scope.site.id,
								check.componentId
									? `component/${check.componentId}`
									: check.at === "site" || check.at.startsWith("site#")
										? "site-template"
										: path,
								check.at,
							),
						});
				}
			}
			for (const check of designSystemChecks(await draftDesignSystem(scope)))
				checks.push({
					check: "contrast",
					at: check.id,
					detail: `${check.foreground.name} / ${check.background.name} (${check.mode})`,
					params: { ratio: check.ratio, required: check.required },
					item: { kind: "designSystem", id: scope.site.id, name: "" },
					language: site.defaultLanguage,
					href: `/sites/${scope.site.id}/design-system?tab=tokens`,
				});
			return checks;
		},
	};
}
export type ChecksService = ReturnType<typeof createChecks>;
export type { QualityCheck };

function builderLink(siteId: string, target: string, at: string): string {
	if (!at.includes("#")) return `/builder/${siteId}/${target}`;
	return `/builder/${siteId}/${target}?element=${encodeURIComponent((at.split("#").at(-1) ?? "").replace(/(?:\.\d+)+$/, ""))}`;
}
