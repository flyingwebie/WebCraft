/**
 * The block editor in Edit mode (#79): a page's body is one region (`data-wc-type="body"`) that the
 * editing bar's body part edits Block by Block. It reads what the editor needs here, and saves
 * through the page's shared Draft (Co-editing) or `save`, as every other region does.
 */
import type { Block } from "@webcraft/renderer";
import { storedBlocks } from "@webcraft/renderer";

import { type BodyComponent, bodyComponents } from "../content/body-components.ts";
import { type Pasted, pastedBlocks } from "../content/body-paste.ts";
import type { EntryCheck } from "../content/entries.ts";
import { entryLanguages, getEntry } from "../content/entries.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { BodyField } from "../content/field-types.ts";
import { getPostType } from "../content/post-types.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { EditFieldInvalidError } from "./errors.ts";
import { readEditItem } from "./regions.ts";

/** A body region as the block editor opens it. */
export type BodyRegion = { item: string; field: string; language?: string };

/** What the block editor needs: the body's Blocks in the page's language, and what it may add. */
export type BodyEditing = {
	/** The Body field's label, for the editor's name. */
	label: string;
	/**
	 * The language whose Block list the page shows and changes write: the page's, or the Default
	 * language's for a Body field shared by every language. A page in a language with no list of its
	 * own yet shows the Default language's Blocks; the first change starts its own.
	 */
	language: string;
	/** Its Blocks in the language (the Default language's when the language has none of its own yet). */
	blocks: Block[];
	/** The Block types the Field switched off: the editor doesn't offer them. */
	blocksOff: BodyField["blocksOff"];
	/** The Components the Field allows that are published, with their Props, for the `/` menu. */
	components: BodyComponent[];
	/** What keeps the body from being published, each at its path (`fields.body[2].url`). */
	problems: ContentProblem[];
	/** The body's Checks (warnings that never stop publishing). */
	checks: EntryCheck[];
};

/** The body region's Entry and Body field; refuses a region that isn't an Entry's body. */
async function bodyOf(scope: SiteScope, region: BodyRegion) {
	const item = readEditItem(region.item);
	if (item.kind !== "entry") throw new EditFieldInvalidError();
	const entry = await getEntry(scope, item.id, region.language);
	const postType = await getPostType(scope, entry.postTypeId);
	const field = postType.fields.find((each): each is BodyField => each.type === "body" && each.key === region.field);
	if (!field) throw new EditFieldInvalidError();
	return { entry, field };
}

/** What the block editor needs to edit a page's body (the Site opened with `entry.edit`). */
export async function bodyEditing(scope: SiteScope, region: BodyRegion): Promise<BodyEditing> {
	const { entry, field } = await bodyOf(scope, region);
	const { language, defaultLanguage } = await entryLanguages(scope, region.language);
	const at = `fields.${field.key}`;
	const within = (path: string) => path === at || path.startsWith(`${at}[`) || path.startsWith(`${at}.`);
	return {
		label: field.label,
		language: field.translatable ? language : defaultLanguage,
		blocks: storedBlocks(entry.draft.fields[field.key]),
		blocksOff: field.blocksOff,
		components: await bodyComponents(scope, field, language),
		problems: entry.problems.filter((problem) => within(problem.at)),
		checks: entry.checks.filter((check) => within(check.at)),
	};
}

/** What was pasted into a page's body, as Blocks; nothing is saved. */
export async function pasteIntoBody(scope: SiteScope, region: BodyRegion & Pasted): Promise<{ blocks: Block[] }> {
	const { field } = await bodyOf(scope, region);
	return { blocks: pastedBlocks(region, field) };
}
