/**
 * Components in a body (#79, spec story 85): each Body field lists the Site's Components it allows
 * (`BodyField.components`); Members place them as Component Blocks and fill their Props. A body
 * places the published version of a Component, as visitors see it, so only published Components can
 * go in and their published Props are what a Block's values are checked against.
 *
 * Module Block types and Components use the same catalogue, allowances and stored Placement shape.
 * Unavailable Module data stays intact; only new or changed unavailable Placements are refused.
 */

import { components } from "@webcraft/db/schema";
import { type Block, type ComponentFound, ELEMENT_TREE_VERSION, type PropInfo } from "@webcraft/renderer";
import { inArray } from "drizzle-orm";
import { isUuid } from "../ids.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { storedComponentVersion } from "./component-versions.ts";
import type { BodyField, FieldDefinition } from "./field-types.ts";
import { getPostType } from "./post-types.ts";
import { mapPropLeaves } from "./prop-leaves.ts";
import { readPropText } from "./props.ts";
import type { ReferenceCheck } from "./relationships.ts";

/** A Component a body allows, as the block editors offer it: its name and its published Props. */
export type BodyComponent = { id: string; name: string; props: FieldDefinition[] };

type PublishedComponent = {
	id: string;
	name: string;
	props: FieldDefinition[] | null;
	label?: Readonly<Record<string, string>>;
	localizedProps?: Readonly<Record<string, FieldDefinition[]>>;
};

async function publishedComponents(
	scope: Pick<SiteScope | VisitorScope, "db" | "where" | "site" | "componentSources">,
	ids: readonly string[],
): Promise<Map<string, PublishedComponent>> {
	const own = [...new Set(ids)].filter(isUuid);
	const fromModules = await scope.componentSources.moduleComponentsAt(scope);
	const rows =
		own.length === 0
			? []
			: await scope.db
					.select()
					.from(components)
					.where(scope.where(components, inArray(components.id, own)));
	return new Map<string, PublishedComponent>([
		...fromModules.map((component): [string, PublishedComponent] => [component.id, component]),
		...rows.map((row): [string, PublishedComponent] => [
			row.id,
			{
				id: row.id,
				name: row.name,
				props: row.published === null ? null : storedComponentVersion(row.published).props,
			},
		]),
	]);
}

/** The Components a Body field allows that are published, in its order, with their published Props. */
export async function bodyComponents(
	scope: Pick<SiteScope, "db" | "where" | "site" | "componentSources">,
	field: BodyField,
	language?: string,
): Promise<BodyComponent[]> {
	const found = await publishedComponents(scope, field.components);
	return field.components.flatMap((id) => {
		const component = found.get(id);
		return component?.props
			? [
					{
						id,
						name: language ? (component.label?.[language] ?? component.name) : component.name,
						props: language ? (component.localizedProps?.[language] ?? component.props) : component.props,
					},
				]
			: [];
	});
}

/** A Prop as Markdown's Component tags are checked against it. */
function propInfo(prop: FieldDefinition): PropInfo {
	return {
		key: prop.key,
		required: prop.required && (prop.default === null || prop.default === undefined),
		check(text) {
			const read = readPropText(prop, text);
			return "problem" in read ? read.problem : undefined;
		},
	};
}

/**
 * The Components a body's Markdown may name, by name: those its Field allows and are published. Any
 * other of the Site's is refused with the reason.
 */
export async function bodyComponentFinder(
	scope: Pick<SiteScope, "select" | "db" | "where" | "site" | "componentSources">,
	field: BodyField,
	previous: readonly Block[] = [],
): Promise<(name: string) => ComponentFound> {
	const rows = await scope.select(components);
	const allowed = new Map((await bodyComponents(scope, field)).map((component) => [component.name, component]));
	const placed = new Set(previous.flatMap((block) => (block.type === "component" ? [block.component] : [])));
	for (const component of await scope.componentSources.retainedModuleComponentsAt(scope)) {
		if (!placed.has(component.id)) continue;
		const name = component.id.slice(component.id.indexOf(":") + 1);
		// The source schema reads an unchanged Block even if the installed Module changed. The
		// ordinary Body save still refuses inserting another one or changing these retained Props.
		allowed.set(name, { ...component, name });
	}
	// An older Site Component may share a Module's new tag. Include unavailable and retained
	// Block identities too: Markdown must never silently retarget their data to another Component.
	const known = new Map(
		[...scope.componentSources.allModuleComponents(), ...rows].map((component) => [component.id, component.name]),
	);
	const relevant = new Set([
		...field.components,
		...previous.flatMap((block) => (block.type === "component" ? [block.component] : [])),
	]);
	for (const id of relevant) if (!known.has(id) && id.includes(":")) known.set(id, id.split(":")[1] ?? "");
	return (name) => {
		if ([...relevant].filter((id) => known.get(id) === name).length > 1)
			return {
				refused: `More than one Component is named ${name}. Use JSON Blocks to keep their identities, or rename the Site's Component.`,
			};
		const component = allowed.get(name);
		if (component)
			return {
				id: component.id,
				name,
				props: component.props.map(propInfo),
				tree: { version: ELEMENT_TREE_VERSION, nodes: [] },
			};
		const module = scope.componentSources.allModuleComponents().find((component) => component.name === name);
		const unavailable = field.components.some((id) => id.includes(":") && id.split(":")[1] === name);
		if (module || unavailable)
			return {
				refused: unavailable
					? `${name}'s Module is unavailable: restore a compatible approved Module first.`
					: `This Body field doesn't allow ${name}.`,
			};
		const row = rows.find((each) => each.name === name);
		if (!row) return undefined;
		if (!field.components.includes(row.id)) return { refused: `This Body field doesn't allow ${name}.` };
		return { refused: `${name} isn't published yet: publish it first.` };
	};
}

/** The names of the Site's Components, by id, for writing a body's Components as Markdown. */
export async function componentNames(
	scope: Pick<SiteScope | VisitorScope, "select" | "componentSources">,
): Promise<Map<string, string>> {
	const rows = await scope.select(components);
	return new Map([...scope.componentSources.allModuleComponents(), ...rows].map((row) => [row.id, row.name]));
}

/**
 * Checks the Components bodies place against the Site's published Components: each must be one, and
 * its Prop values must be Props it has, readable as their types. `refuse` (saving) refuses what
 * doesn't fit; `rule` (a stored version) lists it as a broken rule (`prop`, `component`), and a
 * required Prop left empty too, which keeps the Entry from being published.
 */
export async function checkBodyComponents(
	scope: Pick<SiteScope, "db" | "where" | "site" | "componentSources">,
	checks: readonly Extract<ReferenceCheck, { kind: "components" }>[],
	mode: "refuse" | "rule",
): Promise<ReferenceCheck[]> {
	const references: ReferenceCheck[] = [];
	if (checks.length === 0) return references;
	const found = await publishedComponents(
		scope,
		checks.flatMap((check) => check.ids),
	);
	for (const check of checks) {
		for (const placement of check.placements) {
			const here = `${check.at}${placement.within}`;
			const report = (at: string, rule: string, message: string) =>
				check.problems.push(mode === "refuse" ? { at, message } : { at, rule, message });
			const component = found.get(placement.component);
			if (!component?.props) {
				if (placement.component.includes(":")) {
					if (mode === "rule" || placement.kept) continue;
					report(
						`${here}.component`,
						"component",
						"This Module Block is unavailable: restore a compatible approved Module before inserting or changing it.",
					);
					continue;
				}
				report(
					`${here}.component`,
					"component",
					component ? `${component.name} isn't published yet: publish it first.` : "The Site has no such Component.",
				);
				continue;
			}
			const props = component.props;
			placement.props.forEach((given, index) => {
				const prop = props.find((each) => each.key === given.name);
				if (!prop) {
					report(`${here}.props[${index}]`, "prop", `${component.name} has no Prop ${given.name}.`);
					return;
				}
				const read = readPropText(prop, given.value);
				if ("value" in read)
					mapPropLeaves(prop, read.value, (field, value) => {
						const at = `${here}.props[${index}]`;
						if (field.type === "media" && typeof value === "string")
							references.push({ kind: "media", ids: [value], at, problems: check.problems });
						if (field.type === "relationship")
							references.push({
								kind: "entries",
								ids: (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === "string"),
								postTypes: field.postTypes,
								at,
								problems: check.problems,
							});
						return value;
					});
				// An empty required value is kept, and listed below.
				if ("problem" in read && given.value.trim() !== "") {
					report(`${here}.props[${index}]`, "prop", `${component.name}'s ${prop.key}: ${read.problem}`);
				}
			});
			if (mode === "rule") {
				for (const prop of props) {
					if (!prop.required || (prop.default !== null && prop.default !== undefined) || prop.type === "boolean")
						continue;
					const given = placement.props.find((each) => each.name === prop.key);
					if (!given || given.value.trim() === "") {
						report(`${here}.props.${prop.key}`, "prop", `${component.name} needs its Prop ${prop.key}.`);
					}
				}
			}
		}
	}
	return references;
}

/** The Components a Post Type's Body field allows that are published (none when it has no Body field). */
export async function entryBodyComponents(
	scope: SiteScope,
	postTypeId: string,
	language?: string,
): Promise<BodyComponent[]> {
	const postType = await getPostType(scope, postTypeId);
	const field = postType.fields.find((each): each is BodyField => each.type === "body");
	return field ? bodyComponents(scope, field, language) : [];
}
