/**
 * What the visual builder works on: one Template or Component of a Site, its Draft, and what its
 * tree may hold, read as saving its Draft would check it (ADR 0017: the builder and Template markup
 * are two views of the same tree).
 */
import type { ElementTree, LoopCatalogue, ParseTreeOptions } from "@webcraft/renderer";

import {
	type Component,
	type ComponentSources,
	componentSource,
	componentVersion,
	type SiteComponents,
	siteComponents,
} from "../content/components.ts";
import type { FieldDefinition, FieldInput } from "../content/field-types.ts";
import { draftVersion } from "../content/json.ts";
import { loopCatalogue } from "../content/loops.ts";
import { getPostType, type PostType } from "../content/post-types.ts";
import { type Template, type TemplateKind, templateSource } from "../content/templates.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/** What the builder opens: one of the Site's Templates (by kind and Post Type) or one of its own Components. */
export type BuilderTarget =
	| { kind: "siteTemplate" }
	| { kind: "searchTemplate" }
	| { kind: "entryTemplate"; postTypeId: string }
	| { kind: "archiveTemplate"; postTypeId: string }
	| { kind: "component"; componentId: string };

/** The kind of tree a target holds: a Template's kind, or a Component's. */
export type SourceKind = TemplateKind | "component";

/** A target as the builder reads it now. */
export type BuilderSource = {
	kind: SourceKind;
	/** The Template; null while the Site hasn't made it, and for a Component. */
	template: Template | null;
	/** The Component; null for a Template. */
	component: Component | null;
	/** The Post Type an Entry or Archive template belongs to. */
	postType: PostType | null;
	/** A Component's Props as its Draft will have them; null for a Template. */
	props: FieldDefinition[] | null;
	/** The Draft's tree; empty while there is none. */
	draft: ElementTree;
	/** The Draft's version, which the next save names as `basedOn`; null while there is none. */
	version: string | null;
	/** The Components its Draft may place, as Drafts place them. */
	components: SiteComponents;
	/** What its trees may hold, as `parseElementTree` and `parseTemplateMarkup` take it (Classes aside). */
	rules: Omit<ParseTreeOptions, "popups" | "classIds" | "forms" | "filters" | "components" | "loops"> & {
		components: SiteComponents;
		forms: SiteComponents["forms"];
		popups: SiteComponents["popups"];
		filters: SiteComponents["filters"];
		loops: LoopCatalogue;
	};
};

const EMPTY_TREE: ElementTree = { version: 1, nodes: [] };

const TEMPLATE_KINDS = {
	siteTemplate: "site",
	searchTemplate: "search",
	entryTemplate: "entry",
	archiveTemplate: "archive",
} as const;

/**
 * Reads what `target` names on the scope's Site (open it with `structure.edit`). `props` are a
 * Component's Props as the builder has them before saving (checked as saving checks them); its
 * Draft's when absent. Throws as saving would for what can't be saved: a Template Pages don't have,
 * a Module's Component, a Component or Post Type the Site doesn't have.
 */
export async function readSource(
	scope: SiteScope,
	target: BuilderTarget,
	sources: ComponentSources,
	props?: readonly FieldInput[],
): Promise<BuilderSource> {
	if (target.kind === "component") {
		const found = await componentSource(scope, target.componentId, props, sources);
		return {
			kind: "component",
			template: null,
			component: found.component,
			postType: null,
			props: found.props,
			draft: found.component.draft.tree,
			version: componentVersion(found.component.draft),
			components: found.catalogue,
			rules: found.rules,
		};
	}
	const kind = TEMPLATE_KINDS[target.kind];
	const postTypeId = "postTypeId" in target ? target.postTypeId : null;
	const found = await templateSource(scope, kind, postTypeId);
	const components = await siteComponents(scope, "draft", sources);
	return {
		kind,
		template: found.template,
		component: null,
		postType: postTypeId === null ? null : await getPostType(scope, postTypeId),
		props: null,
		draft: found.template?.draft ?? EMPTY_TREE,
		version: found.template ? draftVersion(found.template.draft) : null,
		components,
		rules: found.rules(components, await loopCatalogue(scope, "draft")),
	};
}
