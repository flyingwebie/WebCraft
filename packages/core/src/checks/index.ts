import { checkSightings, popups, templates } from "@webcraft/db/schema";
import type { QualityCheck } from "@webcraft/renderer";
import { and, eq, inArray, notInArray, type SQL } from "drizzle-orm";
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
import { popupAttachments } from "../popups/catalogue.ts";
import { popupChecks } from "../popups/checks.ts";
import type { PopupSettings } from "../popups/index.ts";
import type { SitePages } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

export type SiteCheck = {
	check: string;
	at: string;
	detail?: string;
	componentId?: string;
	params?: Readonly<Record<string, number>>;
	item: {
		kind: "entry" | "template" | "component" | "designSystem" | "popup";
		id: string;
		name: string;
		templateKind?: TemplateKind;
	};
	language: string;
	href: string;
	/** When it was first seen: the first time Checks were read after it appeared (`check_sightings`). */
	since: Date;
};

/** A Check as it is worked out, before its sighting is looked up. */
type FoundCheck = Omit<SiteCheck, "since">;

/** What a Check is, whatever its words: the item, language, check and where it is. */
async function sightingKey(check: FoundCheck): Promise<string> {
	const what = [check.item.kind, check.item.id, check.language, check.check, check.at, check.componentId ?? ""];
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(what.join("\n")));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Answers each Check found with when it was first seen, keeping `check_sightings` in step: a Check
 * found for the first time is seen now, and the sightings `covered` holds that weren't found again
 * are dropped (fixed). `covered` is what this read looked at, so a read that sees less (a Member's,
 * one Entry's) never drops what it didn't look at.
 */
async function withSightings(scope: SiteScope, found: FoundCheck[], covered: SQL | undefined): Promise<SiteCheck[]> {
	const keys = await Promise.all(found.map(sightingKey));
	const now = scope.now();
	const seen = await scope.transaction(async (tx) => {
		const unique = new Map(found.map((check, index) => [keys[index] ?? "", check]));
		if (unique.size > 0) {
			await tx.db
				.insert(checkSightings)
				.values(
					Array.from(unique, ([key, check]) => ({
						workspaceId: tx.site.workspaceId,
						siteId: tx.site.id,
						key,
						itemKind: check.item.kind,
						itemId: check.item.id,
						language: check.language,
						firstSeenAt: now,
					})),
				)
				.onConflictDoNothing();
		}
		const gone = unique.size > 0 ? notInArray(checkSightings.key, [...unique.keys()]) : undefined;
		await tx.db.delete(checkSightings).where(tx.where(checkSightings, and(covered, gone)));
		if (unique.size === 0) return new Map<string, Date>();
		const rows = await tx.db
			.select({ key: checkSightings.key, firstSeenAt: checkSightings.firstSeenAt })
			.from(checkSightings)
			.where(tx.where(checkSightings, inArray(checkSightings.key, [...unique.keys()])));
		return new Map(rows.map((row) => [row.key, row.firstSeenAt]));
	});
	return found.map((check, index) => ({ ...check, since: seen.get(keys[index] ?? "") ?? now }));
}

export function createChecks(pages: SitePages, sources: ComponentSources) {
	const collectEntry = async (scope: SiteScope, item: Entry): Promise<FoundCheck[]> => {
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
				structure && target
					? buildingAreaLink(scope.site.id, target, c.at)
					: `${base.href}#${encodeURIComponent(c.at)}`;
			return { ...c, ...base, href };
		});
	};
	/** Every Check of the Site the person may see, and which sightings that covers. */
	const found = async (scope: SiteScope): Promise<[FoundCheck[], SQL | undefined]> => {
		const checks: FoundCheck[] = [];
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
			// A Member's Checks are the Entries' only: the sightings of Structure stay as they are.
			return [checks, eq(checkSightings.itemKind, "entry")];
		const targets: { target: BuilderTarget; item: SiteCheck["item"] }[] = [];
		const attached = await popupAttachments(scope);
		for (const row of await scope.select(popups))
			for (const check of popupChecks(row.draft as PopupSettings, attached.has(row.id)))
				checks.push({
					...check,
					item: { kind: "popup", id: row.id, name: row.name },
					language: site.defaultLanguage,
					href: `/sites/${scope.site.id}/popups?popup=${row.id}`,
				});
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
						href: buildingAreaLink(
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
		return [checks, undefined];
	};
	return {
		async entry(scope: SiteScope, entryId: string, language?: string): Promise<SiteCheck[]> {
			const entry = await getEntry(scope, entryId, language);
			return withSightings(
				scope,
				await collectEntry(scope, entry),
				and(
					eq(checkSightings.itemKind, "entry"),
					eq(checkSightings.itemId, entry.id),
					eq(checkSightings.language, entry.language),
				),
			);
		},
		async list(scope: SiteScope): Promise<SiteCheck[]> {
			return withSightings(scope, ...(await found(scope)));
		},
	};
}
export type ChecksService = ReturnType<typeof createChecks>;
export type { QualityCheck };

/**
 * The admin's way into the building area (ADR 0037) for a Check found in a Template or Component: the
 * document opened (`target`, as `/_webcraft/build` names it) with the element the Check is about
 * selected, when the Check names one. The admin adds where its logo tile goes back to.
 */
function buildingAreaLink(siteId: string, target: string, at: string): string {
	const query = new URLSearchParams({ open: `/${target}` });
	if (at.includes("#")) query.set("element", (at.split("#").at(-1) ?? "").replace(/(?:\.\d+)+$/, ""));
	return `/sites/${siteId}/build?${query.toString()}`;
}
