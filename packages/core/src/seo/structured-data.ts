import {
	isList,
	type JsonLd,
	mediaReference,
	type SocialImage,
	type TemplateValue,
	textOf,
	type ValueReader,
} from "@webcraft/renderer";

import type { FieldDefinition } from "../content/field-types.ts";
import {
	fieldAt,
	type PropertyKind,
	SCHEMA_PROPERTIES,
	SCHEMA_TYPE_NAMES,
	type SchemaType,
	sourceGives,
} from "./seo-rules.ts";
import type { SeoOrganization } from "./site-settings.ts";

/**
 * Structured data (the SEO decision): the JSON-LD graph every page carries. Its nodes are built here
 * from plain values only (text without markup, numbers, ISO dates, absolute addresses); the renderer
 * writes the graph as one escaped `application/ld+json` block (`jsonLdText`).
 */
export type Node = { [key: string]: JsonLd };

/** A crumb of a page's breadcrumbs: a page's name and its address. */
export type Crumb = { name: string; item: string };

/** The ids every page's nodes link by: the Site (WebSite) and its organisation, once each per Site. */
export function siteIds(main: string): { website: string; organization: string } {
	return { website: `${main}/#website`, organization: `${main}/#organization` };
}

/**
 * The WebSite and the organisation behind it, on every page: the Site's name and home page (in the
 * page's language), how to search it when it has a search results page, and the organisation from
 * the Site's SEO settings and Globals (an Organization, or a LocalBusiness).
 */
export function siteNodes(site: {
	main: string;
	name: string;
	home: string;
	language: string;
	organization: SeoOrganization;
	logo: SocialImage | null;
	/** The search results page's address in the page's language, when the Site has one. */
	search: string | null;
	/** A Global's value, by its path. */
	globals: ValueReader;
}): Node[] {
	const ids = siteIds(site.main);
	const website: Node = {
		"@type": "WebSite",
		"@id": ids.website,
		url: site.home,
		name: site.name,
		inLanguage: site.language,
		publisher: { "@id": ids.organization },
	};
	if (site.search) {
		website.potentialAction = {
			"@type": "SearchAction",
			target: { "@type": "EntryPoint", urlTemplate: `${site.search}?q={search_term_string}` },
			"query-input": "required name=search_term_string",
		};
	}
	const { organization } = site;
	const node: Node = {
		"@type": organization.kind === "localBusiness" ? "LocalBusiness" : "Organization",
		"@id": ids.organization,
		name: organization.name ?? site.name,
		url: `${site.main}/`,
	};
	if (site.logo) node.logo = imageObject(site.logo);
	if (organization.sameAs.length > 0) node.sameAs = [...organization.sameAs];
	for (const key of ["telephone", "email", "address"] as const) {
		const path = organization[key];
		const value = path ? plain(site.globals(path)) : "";
		if (value) node[key] = value;
	}
	return [website, node];
}

/** A page's breadcrumbs, from the Site's home page to the page. */
export function breadcrumbNode(id: string, crumbs: readonly Crumb[]): Node {
	return {
		"@type": "BreadcrumbList",
		"@id": id,
		itemListElement: crumbs.map((crumb, index) => ({
			"@type": "ListItem",
			position: index + 1,
			name: crumb.name,
			item: crumb.item,
		})),
	};
}

/** An image as structured data shows it: its address and size. */
export function imageObject(image: SocialImage): Node {
	const node: Node = { "@type": "ImageObject", url: image.url };
	if (image.width) node.width = image.width;
	if (image.height) node.height = image.height;
	return node;
}

/** What a Schema type's properties are read from on one page. */
export type PropertySources = {
	fields: readonly FieldDefinition[];
	/** What the page's bindings read: its built-in values and Fields (`title`, `author`, `price`, `chef.url`). */
	values: ValueReader;
	/** The page's description and social image, as its SEO fields and their fallbacks give them. */
	description: string | null;
	image: SocialImage | null;
	/** The Media images the properties name, as `imageIdsIn` listed them. */
	images: ReadonlyMap<string, SocialImage>;
	/** A path on the Site (a related Entry's page) as an absolute address. */
	address(path: string): string;
};

/** The Media images a Schema type's mapped properties name, to look up before `mappedProperties`. */
export function imageIdsIn(
	type: SchemaType,
	properties: Readonly<Record<string, string>>,
	sources: Pick<PropertySources, "fields" | "values">,
): string[] {
	const ids: string[] = [];
	for (const property of SCHEMA_PROPERTIES[type]) {
		const source = properties[property.name];
		if (property.kind !== "image" || !source || source === "seo.image") continue;
		const id = imageIdAt(source, sources);
		if (id) ids.push(id);
	}
	return ids;
}

function imageIdAt(source: string, sources: Pick<PropertySources, "fields" | "values">): string | null {
	const located = fieldAt(sources.fields, source);
	if (!located) return null;
	const value = sources.values(located.field.type === "body" ? `${source}.image` : source);
	return typeof value === "string" ? (mediaReference(value) ?? null) : null;
}

/** The schema.org name of a Schema type. */
export function schemaTypeName(type: SchemaType): string {
	return SCHEMA_TYPE_NAMES[type];
}

/**
 * A Schema type's properties as structured data, each read from the source Staff mapped it to and
 * written as plain values: text without markup, ISO dates, numbers, images and people as objects, an
 * offer's price in an Offer, an FAQ's rows as questions with their answers. A property without a
 * value is left out. Mappings that no longer fit the Post Type's Fields are left out too.
 */
export function mappedProperties(
	type: SchemaType,
	properties: Readonly<Record<string, string>>,
	sources: PropertySources,
): Node {
	const node: Node = {};
	const offer: Node = {};
	for (const property of SCHEMA_PROPERTIES[type]) {
		const source = properties[property.name];
		if (!source || !sourceGives(sources.fields, source, property.kind)) continue;
		if (property.kind === "question" || property.kind === "answer") continue;
		const value = propertyValue(property.name, property.kind, source, sources);
		if (value === null) continue;
		if (property.name.startsWith("offers.")) offer[property.name.slice("offers.".length)] = value;
		else node[property.name] = value;
	}
	if (Object.keys(offer).length > 0) node.offers = { "@type": "Offer", ...offer };
	if (type === "faqPage") {
		const questions = faqOf(properties, sources);
		if (questions.length > 0) node.mainEntity = questions;
	}
	return node;
}

/** The schema.org words an offer's availability is written in, from Staff's text (`In stock`, `InStock`). */
const AVAILABILITY = [
	"InStock",
	"OutOfStock",
	"PreOrder",
	"BackOrder",
	"SoldOut",
	"Discontinued",
	"LimitedAvailability",
	"OnlineOnly",
	"InStoreOnly",
	"PreSale",
];

function propertyValue(name: string, kind: PropertyKind, source: string, sources: PropertySources): JsonLd {
	if (source === "seo.description") return sources.description;
	if (source === "seo.image") return sources.image ? imageObject(sources.image) : null;
	const value = sources.values(source);
	switch (kind) {
		case "text": {
			const text = plain(value);
			if (!text) return null;
			if (name === "brand") return { "@type": "Brand", name: text };
			if (name === "location") return { "@type": "Place", name: text };
			if (name === "offers.availability") {
				const word = AVAILABILITY.find((each) => each.toLowerCase() === text.replace(/[\s_-]/g, "").toLowerCase());
				return word ? `https://schema.org/${word}` : text;
			}
			return text;
		}
		case "date":
			return dateText(value, source, sources.fields);
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? value : null;
		case "image": {
			const id = imageIdAt(source, sources);
			const image = id ? sources.images.get(id) : undefined;
			return image ? imageObject(image) : null;
		}
		case "url": {
			const located = fieldAt(sources.fields, source);
			const text = plain(located?.field.type === "link" ? sources.values(`${source}.url`) : value);
			return addressOf(text, sources);
		}
		case "person":
			return personOf(source, value, sources);
		case "textList": {
			const items = listOf(value);
			if (items.length === 0) return null;
			if (name === "keywords") return items.join(", ");
			if (name === "recipeInstructions") return items.map((text) => ({ "@type": "HowToStep", text }));
			return items;
		}
		default:
			return null;
	}
}

/** A value as plain text, on one line: rich text and bodies without their markup. */
function plain(value: TemplateValue): string {
	return textOf(value).replace(/\s+/g, " ").trim();
}

/** A list's values as plain text, the empty ones left out; a single value as a list of one. */
function listOf(value: TemplateValue): string[] {
	const values = isList(value) ? value : [value];
	return values.map(plain).filter((text) => text !== "");
}

/** A date as ISO 8601: a day alone (`2026-03-02`) or a time alone (`09:30`) as kept, else the instant in UTC. */
function dateText(value: TemplateValue, source: string, fields: readonly FieldDefinition[]): string | null {
	const located = fieldAt(fields, source);
	const mode = located?.field.type === "date" ? located.field.mode : "dateTime";
	if (typeof value === "string" && (mode !== "dateTime" || !value.includes("T"))) return value || null;
	const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
	if (!date || Number.isNaN(date.getTime())) return null;
	return mode === "date" ? date.toISOString().slice(0, 10) : date.toISOString();
}

/** An address a property gives: an http(s) address as written, a path on the Site at its address; else nothing. */
function addressOf(text: string, sources: PropertySources): string | null {
	if (text.startsWith("/") && !text.startsWith("//")) return sources.address(text);
	try {
		const url = new URL(text);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * A person a property names: the Entry's author (by name), the Entries a Relationship points at (by
 * their title, with their page), or a name written in a text Field.
 */
function personOf(source: string, value: TemplateValue, sources: PropertySources): JsonLd {
	const located = fieldAt(sources.fields, source);
	if (located?.field.type === "relationship") {
		const names = listOf(sources.values(`${source}.title`));
		const urls = sources.values(`${source}.url`);
		const addresses = isList(urls) ? urls.map(plain) : [plain(urls)];
		const people = names.map((personName, index) => {
			const person: Node = { "@type": "Person", name: personName };
			const address = addresses[index] ? addressOf(addresses[index] ?? "", sources) : null;
			if (address) person.url = address;
			return person;
		});
		if (people.length === 0) return null;
		return people.length === 1 ? (people[0] ?? null) : people;
	}
	const personName = plain(value);
	return personName ? { "@type": "Person", name: personName } : null;
}

/** An FAQ's questions and answers: two Fields of the same Repeater, row by row, rows without both left out. */
function faqOf(properties: Readonly<Record<string, string>>, sources: PropertySources): Node[] {
	const { question, answer } = properties;
	if (!question || !answer) return [];
	if (!sourceGives(sources.fields, question, "question") || !sourceGives(sources.fields, answer, "answer")) return [];
	const questions = sources.values(question);
	const answers = sources.values(answer);
	const asked = isList(questions) ? questions : [questions];
	const answered = isList(answers) ? answers : [answers];
	return asked.flatMap((each, index) => {
		const name = plain(each);
		const text = plain(answered[index] ?? null);
		return name && text ? [{ "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text } }] : [];
	});
}
