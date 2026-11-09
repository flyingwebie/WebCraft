import type { SiteScope } from "../tenancy/data-layer.ts";
import type { FilterVersionInput } from "./definition.ts";
import { createFilter, type Filter, getFilter, listFilters, type NewFilter, saveFilterDraft } from "./filters.ts";

export type { FilterVersionInput } from "./definition.ts";
export { FilterInvalidError, FilterNameTakenError, FilterNotFoundError } from "./errors.ts";
export type { Filter, NewFilter } from "./filters.ts";

/**
 * Filters (GLOSSARY.md), behind `services.filters`: the controls visitors use to narrow, search and
 * sort one query Loop, as Structure (open the Site with `structure.edit`), published through
 * `publishing.publish` with `{ kind: "filter" }`. Pages show them where Templates place
 * `{{@filter <name> for="<loop>"}}` (`site-pages/filters.ts`).
 */
export type Filters = {
	list(scope: SiteScope): Promise<Filter[]>;
	get(scope: SiteScope, filterId: string): Promise<Filter>;
	/** Makes a Filter for one of the Site's query Loops (a Loop has one Filter at most), as a Draft. */
	create(scope: SiteScope, input: NewFilter): Promise<Filter>;
	/** Saves its Draft: its mode, words and controls, each part given replacing that part. */
	saveDraft(scope: SiteScope, filterId: string, change: FilterVersionInput): Promise<Filter>;
};

export function createFilters(): Filters {
	return { list: listFilters, get: getFilter, create: createFilter, saveDraft: saveFilterDraft };
}
