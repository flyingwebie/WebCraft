// Site search (ADR 0021): one full-text index per Site and language over every Post Type's published
// Entries, built from each Post Type's Searched fields, and the built-in Filter with only a search box
// that visitors search it with.
export { markSearchIndexStale, SEARCH_INDEX_VERSION } from "./index-version.ts";
export {
	defaultSearchedFields,
	SEARCH_WEIGHTS,
	SEARCHED_FIELDS_MAX,
	SEARCHED_TYPES,
	type SearchedField,
	type SearchWeight,
} from "./searched-fields.ts";
