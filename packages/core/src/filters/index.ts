import type { ComponentSources } from "../content/components.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { FilterSources, FilterVersionInput } from "./definition.ts";
import {
	createFilter,
	type Filter,
	filterDetails,
	getFilter,
	listFilters,
	type NewFilter,
	saveFilterDraft,
} from "./filters.ts";
import { type FilterPreview, type FilterPreviewInput, previewFilter } from "./preview.ts";
import type { FilterUsage } from "./usage.ts";

export type { FilterSources, FilterVersionInput } from "./definition.ts";
export { FilterInvalidError, FilterNameTakenError, FilterNotFoundError } from "./errors.ts";
export type { Filter, NewFilter } from "./filters.ts";
export type { FilterPreview, FilterPreviewInput } from "./preview.ts";
export type { FilterPlacement, FilterUsage } from "./usage.ts";

/**
 * Filters (GLOSSARY.md), behind `services.filters`: the controls visitors use to narrow, search and
 * sort one query Loop, as Structure (open the Site with `structure.edit`), published through
 * `publishing.publish` with `{ kind: "filter" }`. Pages show them where Templates place
 * `{{@filter <name> for="<loop>"}}` (`site-pages/filters.ts`).
 */
export type Filters = {
	/** The Site's Filters, by name, each with where it is placed. */
	list(scope: SiteScope): Promise<(Filter & { usage: FilterUsage })[]>;
	get(scope: SiteScope, filterId: string): Promise<Filter>;
	/** A Filter as its builder reads it: where it is placed, and what its controls can use from its Loop. */
	details(
		scope: SiteScope,
		filterId: string,
	): Promise<{ filter: Filter; usage: FilterUsage; sources: FilterSources | null }>;
	/**
	 * Its Draft with changes not saved yet, rendered where it is placed with its Loop's published
	 * Entries and real counts, for the Filter builder's live preview (`FilterInvalidError` as saving).
	 */
	preview(scope: SiteScope, filterId: string, input: FilterPreviewInput): Promise<FilterPreview>;
	/** Makes a Filter for one of the Site's query Loops (a Loop has one Filter at most), as a Draft. */
	create(scope: SiteScope, input: NewFilter): Promise<Filter>;
	/** Saves its Draft: its mode, words and controls, each part given replacing that part. */
	saveDraft(scope: SiteScope, filterId: string, change: FilterVersionInput): Promise<Filter>;
};

export function createFilters(options: { sources: ComponentSources }): Filters {
	return {
		list: listFilters,
		get: getFilter,
		details: filterDetails,
		preview: (scope, filterId, input) => previewFilter(scope, options.sources, filterId, input),
		create: createFilter,
		saveDraft: saveFilterDraft,
	};
}
