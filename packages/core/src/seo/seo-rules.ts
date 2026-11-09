// The admin reads this file in the browser (`@webcraft/core/seo-rules`): it imports types only.
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition } from "../content/field-types.ts";

/**
 * A Post Type's SEO settings (the SEO decision): what its Entries' SEO fields fall back to when they
 * are empty, and how its Entries describe themselves to search engines.
 *
 * - `titlePattern`: the page's title without an SEO title, from the tokens in `TITLE_TOKENS`.
 * - `descriptionField`: the Field the description comes from (a text, rich text or Body field, by its
 *   path); null for the start of the Body field. Each cut cleanly to about `DESCRIPTION_CUT` characters.
 * - `imageField`: the Field the social image comes from (a media Field, or a Body field's first image);
 *   null for none. Then the Social card, then the Site's default image.
 * - `schema`: its Schema type (GLOSSARY.md), one of `SCHEMA_TYPES`, with each property mapped to where
 *   its value comes from (`SchemaSource`).
 */
export type PostTypeSeo = {
	titlePattern: string;
	descriptionField: string | null;
	imageField: string | null;
	schema: { type: SchemaType; properties: Readonly<Record<string, string>> };
};

/** What a title pattern may say: the page's own title, the Site's name, the Post Type's name and the separator. */
export const TITLE_TOKENS = ["title", "site", "postType", "separator"] as const;
export type TitleToken = (typeof TITLE_TOKENS)[number];

/** The title pattern until Staff choose another: `{title} · {Site name}`. */
export const DEFAULT_TITLE_PATTERN = "{title} {separator} {site}";

/** The most characters a title pattern has. */
export const TITLE_PATTERN_MAX_LENGTH = 200;

/** The separator until Staff choose another. */
export const DEFAULT_SEPARATOR = "·";

/** The most characters a separator has. */
export const SEPARATOR_MAX_LENGTH = 3;

/** About how many characters a description made from a Field or a body is cut to (at a word). */
export const DESCRIPTION_CUT = 155;

/**
 * What the SEO check (a Check, GLOSSARY.md) warns about in the Entry editor, never stopping a publish:
 * a title or description search engines cut short, a description that says too little or nothing, no
 * social image, and a social image without alt text in the page's language. The Site's list of open
 * Checks (#95) collects them with every other Check.
 */
export const SEO_CHECKS = [
	"seoTitleLong",
	"seoDescriptionMissing",
	"seoDescriptionShort",
	"seoDescriptionLong",
	"seoImageMissing",
	"seoImageAlt",
] as const;
export type SeoCheckKind = (typeof SEO_CHECKS)[number];

/** The lengths the SEO check measures against, in characters. */
export const SEO_CHECK_LIMITS = { titleMax: 60, descriptionMin: 50, descriptionMax: 160 } as const;

// ---------------------------------------------------------------------------------------------------
// Schema types

/** The Schema types of v1 (the SEO decision), each a type of schema.org. */
export const SCHEMA_TYPES = [
	"webPage",
	"article",
	"blogPosting",
	"product",
	"event",
	"person",
	"organization",
	"localBusiness",
	"faqPage",
	"recipe",
	"service",
] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];

/** Each Schema type's name in schema.org. */
export const SCHEMA_TYPE_NAMES: Readonly<Record<SchemaType, string>> = {
	webPage: "WebPage",
	article: "Article",
	blogPosting: "BlogPosting",
	product: "Product",
	event: "Event",
	person: "Person",
	organization: "Organization",
	localBusiness: "LocalBusiness",
	faqPage: "FAQPage",
	recipe: "Recipe",
	service: "Service",
};

/**
 * What a property's value is, which decides the sources it can be mapped to:
 * - `text`: words (a text, rich text, select, email, Body or Relationship Field; the title; the author);
 * - `date`: a date Field, or one of the Entry's dates;
 * - `number`: a number Field;
 * - `image`: a media Field, a Body field's first image, or the page's social image;
 * - `url`: a link Field or a text Field holding an address;
 * - `person`: the author, a Relationship (to the Entries it points at, by their title and page) or text;
 * - `textList`: several words: a Field across a Repeater's rows, a multiple select, a Relationship;
 * - `question`, `answer`: an FAQ's questions and answers, two Fields of the same Repeater.
 */
export type PropertyKind = "text" | "date" | "number" | "image" | "url" | "person" | "textList" | "question" | "answer";

/**
 * One property of a Schema type: its schema.org name (dotted for one inside an offer, `offers.price`),
 * what its value is, and how it is guessed when the type is chosen: a built-in source first, then the
 * first Field of the right kind whose key or label holds one of `words`.
 */
export type SchemaProperty = { name: string; kind: PropertyKind; builtIn?: string; words?: readonly string[] };

const name = (builtIn = "title"): SchemaProperty => ({ name: "name", kind: "text", builtIn });
const description: SchemaProperty = { name: "description", kind: "text", builtIn: "seo.description" };
const image: SchemaProperty = { name: "image", kind: "image", builtIn: "seo.image" };
const datePublished: SchemaProperty = { name: "datePublished", kind: "date", builtIn: "publishedAt" };
const dateModified: SchemaProperty = { name: "dateModified", kind: "date", builtIn: "lastPublishedAt" };
const author: SchemaProperty = { name: "author", kind: "person", builtIn: "author", words: ["author", "writer"] };
const price: SchemaProperty = { name: "offers.price", kind: "number", words: ["price", "cost", "prezzo"] };
const currency: SchemaProperty = { name: "offers.priceCurrency", kind: "text", words: ["currency", "valuta"] };
const text = (property: string, words: readonly string[]): SchemaProperty => ({ name: property, kind: "text", words });

const ARTICLE: readonly SchemaProperty[] = [
	{ name: "headline", kind: "text", builtIn: "title" },
	description,
	image,
	author,
	datePublished,
	dateModified,
	text("articleSection", ["section", "category"]),
	{ name: "keywords", kind: "textList", words: ["keyword", "tag"] },
];

const ORGANIZATION: readonly SchemaProperty[] = [
	name(),
	description,
	image,
	{ name: "logo", kind: "image", words: ["logo"] },
	text("telephone", ["phone", "telephone", "tel"]),
	text("email", ["email", "mail"]),
	text("address", ["address", "indirizzo"]),
	{ name: "url", kind: "url", words: ["website", "url", "link"] },
];

/** Each Schema type's properties, in the order the admin shows them. */
export const SCHEMA_PROPERTIES: Readonly<Record<SchemaType, readonly SchemaProperty[]>> = {
	webPage: [name(), description, image, datePublished, dateModified],
	article: ARTICLE,
	blogPosting: ARTICLE,
	product: [
		name(),
		description,
		image,
		text("sku", ["sku", "code"]),
		text("brand", ["brand", "maker"]),
		price,
		currency,
		text("offers.availability", ["availability", "stock"]),
	],
	event: [
		name(),
		description,
		image,
		{ name: "startDate", kind: "date", words: ["start", "begin", "date", "when", "from"] },
		{ name: "endDate", kind: "date", words: ["end", "until", "finish"] },
		text("location", ["location", "venue", "place", "where", "address"]),
		price,
		currency,
	],
	person: [
		name(),
		description,
		image,
		text("jobTitle", ["job", "role", "position"]),
		text("email", ["email", "mail"]),
		text("telephone", ["phone", "telephone", "tel"]),
		{ name: "url", kind: "url", words: ["website", "url"] },
		{ name: "sameAs", kind: "textList", words: ["profile", "social", "sameas"] },
	],
	organization: ORGANIZATION,
	localBusiness: [
		...ORGANIZATION,
		{ name: "openingHours", kind: "textList", words: ["hours", "opening", "orari"] },
		text("priceRange", ["pricerange", "price range", "prices"]),
	],
	faqPage: [
		name(),
		description,
		{ name: "question", kind: "question", words: ["question", "domanda", "q"] },
		{ name: "answer", kind: "answer", words: ["answer", "risposta", "a"] },
	],
	recipe: [
		name(),
		description,
		image,
		author,
		datePublished,
		{ name: "recipeIngredient", kind: "textList", words: ["ingredient", "ingredienti"] },
		{ name: "recipeInstructions", kind: "textList", words: ["step", "instruction", "method", "direction"] },
		text("prepTime", ["prep"]),
		text("cookTime", ["cook"]),
		text("totalTime", ["total"]),
		text("recipeYield", ["yield", "serving", "portion"]),
		text("recipeCategory", ["category", "course"]),
		text("recipeCuisine", ["cuisine"]),
	],
	service: [
		name(),
		description,
		image,
		text("serviceType", ["service", "type"]),
		text("areaServed", ["area", "region", "served"]),
		price,
		currency,
	],
};

/**
 * Where a property's value can come from besides the Post Type's Fields (which are named by their
 * path: `price`, `venue.city`, `steps.text` across a Repeater's rows): the Entry's title, author and
 * dates, and the page's description and social image as the SEO fields and their fallbacks give them.
 */
export const BUILT_IN_SOURCES: Readonly<Record<string, readonly PropertyKind[]>> = {
	title: ["text", "person"],
	author: ["text", "person"],
	publishedAt: ["date"],
	lastPublishedAt: ["date"],
	createdAt: ["date"],
	"seo.description": ["text"],
	"seo.image": ["image"],
};

/** A Field a source path names: the Fields on the way, and whether it is read across a Repeater's rows. */
type Located = { field: FieldDefinition; repeater: FieldDefinition | null };

/** The Field a path names (`summary`, `venue.city`, `steps.text`); undefined for none or a Group itself. */
export function fieldAt(fields: readonly FieldDefinition[], path: string): Located | undefined {
	const names = path.split(".");
	let list: readonly FieldDefinition[] = fields;
	let repeater: FieldDefinition | null = null;
	for (const [index, key] of names.entries()) {
		const field = list.find((candidate) => candidate.key === key);
		if (!field) return undefined;
		const last = index === names.length - 1;
		if (field.type === "group" || field.type === "repeater") {
			if (last) return undefined;
			if (field.type === "repeater") {
				// One Repeater deep: a list of rows' values, never a list of lists.
				if (repeater) return undefined;
				repeater = field;
			}
			list = field.fields;
			continue;
		}
		return last ? { field, repeater } : undefined;
	}
	return undefined;
}

const TEXT_TYPES: ReadonlySet<string> = new Set(["text", "richText", "select", "email", "body", "relationship"]);

/** Whether a Field (read once, or across a Repeater's rows) can give a property of a kind. */
function fieldGives(located: Located, kind: PropertyKind): boolean {
	const { field, repeater } = located;
	const listed = repeater !== null;
	switch (kind) {
		case "text":
			return !listed && TEXT_TYPES.has(field.type) && !(field.type === "select" && field.multiple);
		case "date":
			return !listed && field.type === "date";
		case "number":
			return !listed && field.type === "number";
		case "image":
			return !listed && (field.type === "media" || field.type === "body");
		case "url":
			return !listed && (field.type === "link" || field.type === "text");
		case "person":
			return !listed && (field.type === "relationship" || field.type === "text");
		case "textList":
			return listed
				? ["text", "richText", "select", "link"].includes(field.type)
				: field.type === "relationship" || (field.type === "select" && field.multiple) || field.type === "text";
		case "question":
		case "answer":
			return listed && (field.type === "text" || field.type === "richText");
	}
}

/** Whether a source can give a property of a kind: a built-in source, or a Field of the Post Type. */
export function sourceGives(fields: readonly FieldDefinition[], source: string, kind: PropertyKind): boolean {
	const builtIn = BUILT_IN_SOURCES[source];
	if (builtIn) return builtIn.includes(kind);
	const located = fieldAt(fields, source);
	return located !== undefined && fieldGives(located, kind);
}

/** The sources a property of a kind can be mapped to, built-in ones first, then Fields in order. */
export function sourcesFor(fields: readonly FieldDefinition[], kind: PropertyKind): string[] {
	const sources = Object.keys(BUILT_IN_SOURCES).filter((source) => BUILT_IN_SOURCES[source]?.includes(kind));
	const walk = (list: readonly FieldDefinition[], prefix: string, inRepeater: boolean) => {
		for (const field of list) {
			const path = `${prefix}${field.key}`;
			if (field.type === "group") walk(field.fields, `${path}.`, inRepeater);
			else if (field.type === "repeater") {
				if (!inRepeater) walk(field.fields, `${path}.`, true);
			} else if (sourceGives(fields, path, kind)) sources.push(path);
		}
	};
	walk(fields, "", false);
	return sources;
}

/** Whether a Field's key or label says one of the words. */
function says(field: FieldDefinition, words: readonly string[]): boolean {
	const said = `${field.key} ${field.label}`.toLowerCase();
	return words.some((word) =>
		word.length <= 2 ? new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(said) : said.includes(word),
	);
}

/**
 * The guesses WebCraft makes when a Schema type is chosen: each property mapped to its built-in source
 * (the title to the name or headline, the author, the dates, the page's description and image), or to
 * the first Field of the right kind whose key or label names it (`price`, `startDate`, a Repeater of
 * ingredients). An FAQ takes the first Repeater with two text Fields: its questions and answers.
 */
export function guessSchemaProperties(type: SchemaType, fields: readonly FieldDefinition[]): Record<string, string> {
	const guessed: Record<string, string> = {};
	for (const property of SCHEMA_PROPERTIES[type]) {
		if (property.kind === "question" || property.kind === "answer") continue;
		if (property.builtIn && sourceGives(fields, property.builtIn, property.kind)) {
			guessed[property.name] = property.builtIn;
			continue;
		}
		const words = property.words;
		if (!words) continue;
		const match = sourcesFor(fields, property.kind).find((source) => {
			if (BUILT_IN_SOURCES[source]) return false;
			const parts = source.split(".");
			const chain: FieldDefinition[] = [];
			let list: readonly FieldDefinition[] = fields;
			for (const key of parts) {
				const field = list.find((candidate) => candidate.key === key);
				if (!field) return false;
				chain.push(field);
				list = field.type === "group" || field.type === "repeater" ? field.fields : [];
			}
			return chain.some((field) => says(field, words));
		});
		if (match) guessed[property.name] = match;
	}
	if (type === "faqPage") Object.assign(guessed, guessFaq(fields));
	return guessed;
}

/** An FAQ's questions and answers: the first Repeater holding two text Fields, by their names or their order. */
function guessFaq(fields: readonly FieldDefinition[]): Record<string, string> {
	for (const field of fields) {
		if (field.type !== "repeater") continue;
		const texts = field.fields.filter((inner) => inner.type === "text" || inner.type === "richText");
		if (texts.length < 2) continue;
		const question = texts.find((inner) => says(inner, ["question", "domanda", "q"])) ?? texts[0];
		const answer =
			texts.find((inner) => inner !== question && says(inner, ["answer", "risposta", "a"])) ??
			texts.find((inner) => inner !== question);
		if (!question || !answer) continue;
		return { question: `${field.key}.${question.key}`, answer: `${field.key}.${answer.key}` };
	}
	return {};
}

// ---------------------------------------------------------------------------------------------------
// Reading and checking a Post Type's SEO settings

/**
 * A Post Type's SEO settings until Staff set them: the default title pattern, the start of its Body
 * field as description, its first media Field (else its Body field's first image) as social image,
 * and the Web page Schema type with WebCraft's guesses.
 */
export function defaultPostTypeSeo(fields: readonly FieldDefinition[]): PostTypeSeo {
	const media = fields.find((field) => field.type === "media");
	const body = fields.find((field) => field.type === "body");
	return {
		titlePattern: DEFAULT_TITLE_PATTERN,
		descriptionField: null,
		imageField: media?.key ?? body?.key ?? null,
		schema: { type: "webPage", properties: guessSchemaProperties("webPage", fields) },
	};
}

/** Whether a Field can give a description: a text, rich text or Body field, not across a Repeater's rows. */
export function givesDescription(fields: readonly FieldDefinition[], path: string): boolean {
	const located = fieldAt(fields, path);
	return (
		located !== undefined && located.repeater === null && ["text", "richText", "body"].includes(located.field.type)
	);
}

/** Whether a Field can give a social image: a media Field or a Body field (its first image), not across a Repeater's rows. */
export function givesImage(fields: readonly FieldDefinition[], path: string): boolean {
	const located = fieldAt(fields, path);
	return located !== undefined && located.repeater === null && ["media", "body"].includes(located.field.type);
}

/**
 * A Post Type's stored SEO settings as they apply to its Fields now: the defaults until Staff set
 * them; a Field that went (or changed into one that can't give the value) leaves its place empty.
 */
export function keptPostTypeSeo(stored: unknown, fields: readonly FieldDefinition[]): PostTypeSeo {
	const record =
		stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
	if (Object.keys(record).length === 0) return defaultPostTypeSeo(fields);
	const defaults = defaultPostTypeSeo(fields);
	const pattern = typeof record.titlePattern === "string" ? record.titlePattern : defaults.titlePattern;
	const descriptionField =
		typeof record.descriptionField === "string" && givesDescription(fields, record.descriptionField)
			? record.descriptionField
			: null;
	const imageField =
		typeof record.imageField === "string" && givesImage(fields, record.imageField) ? record.imageField : null;
	const schemaRecord =
		record.schema && typeof record.schema === "object" ? (record.schema as Record<string, unknown>) : {};
	const type = isSchemaType(schemaRecord.type) ? schemaRecord.type : "webPage";
	const properties: Record<string, string> = {};
	const given =
		schemaRecord.properties && typeof schemaRecord.properties === "object"
			? (schemaRecord.properties as Record<string, unknown>)
			: {};
	for (const property of SCHEMA_PROPERTIES[type]) {
		const source = given[property.name];
		if (typeof source === "string" && sourceGives(fields, source, property.kind)) properties[property.name] = source;
	}
	return { titlePattern: pattern, descriptionField, imageField, schema: { type, properties: faqKept(properties) } };
}

/** An FAQ's questions and answers come from the same Repeater, or neither is kept. */
function faqKept(properties: Record<string, string>): Record<string, string> {
	const { question, answer } = properties;
	if (
		(question === undefined) === (answer === undefined) &&
		(!question || repeaterOf(question) === repeaterOf(answer ?? ""))
	) {
		return properties;
	}
	const { question: _q, answer: _a, ...rest } = properties;
	return rest;
}

function repeaterOf(path: string): string {
	return path.split(".").slice(0, -1).join(".");
}

export function isSchemaType(value: unknown): value is SchemaType {
	return typeof value === "string" && (SCHEMA_TYPES as readonly string[]).includes(value);
}

/** A change to a Post Type's SEO settings: each part given replaces that part. */
export type PostTypeSeoChange = {
	titlePattern?: unknown;
	descriptionField?: unknown;
	imageField?: unknown;
	/** A Schema type and its mapping; a type given without `properties` takes WebCraft's guesses. */
	schema?: { type?: unknown; properties?: unknown };
};

/**
 * Checks a change to a Post Type's SEO settings against its Fields, adding a problem for each part
 * that is wrong, where it is (`seo.schema.properties.startDate`), and answers the settings with the
 * change applied.
 */
export function parsePostTypeSeo(
	change: PostTypeSeoChange,
	current: PostTypeSeo,
	fields: readonly FieldDefinition[],
	problems: ContentProblem[],
): PostTypeSeo {
	const next: PostTypeSeo = { ...current, schema: { ...current.schema } };
	if (change.titlePattern !== undefined) {
		const problem = titlePatternProblem(change.titlePattern);
		if (problem) problems.push({ at: "seo.titlePattern", ...problem });
		else next.titlePattern = (change.titlePattern as string).trim();
	}
	if (change.descriptionField !== undefined) {
		const path = change.descriptionField;
		if (path === null || path === "") next.descriptionField = null;
		else if (typeof path === "string" && givesDescription(fields, path)) next.descriptionField = path;
		else {
			problems.push({
				at: "seo.descriptionField",
				message: "A description comes from a text, rich text or Body field of the Post Type.",
				rule: "seoDescriptionField",
				params: { field: String(path) },
			});
		}
	}
	if (change.imageField !== undefined) {
		const path = change.imageField;
		if (path === null || path === "") next.imageField = null;
		else if (typeof path === "string" && givesImage(fields, path)) next.imageField = path;
		else {
			problems.push({
				at: "seo.imageField",
				message: "A social image comes from a media Field or a Body field of the Post Type.",
				rule: "seoImageField",
				params: { field: String(path) },
			});
		}
	}
	if (change.schema !== undefined) {
		const type = change.schema.type ?? next.schema.type;
		if (!isSchemaType(type)) {
			problems.push({
				at: "seo.schema.type",
				message: `A Schema type is one of ${SCHEMA_TYPES.join(", ")}.`,
				rule: "schemaTypeUnknown",
				params: { type: String(type) },
			});
			return next;
		}
		const given = change.schema.properties;
		if (given === undefined) {
			next.schema = type === next.schema.type ? next.schema : { type, properties: guessSchemaProperties(type, fields) };
			return next;
		}
		if (!given || typeof given !== "object" || Array.isArray(given)) {
			problems.push({
				at: "seo.schema.properties",
				message: "Properties are mapped by name.",
				rule: "schemaPropertyUnknown",
				params: { property: "" },
			});
			return next;
		}
		const properties: Record<string, string> = {};
		for (const [property, source] of Object.entries(given as Record<string, unknown>)) {
			const at = `seo.schema.properties.${property}`;
			const spec = SCHEMA_PROPERTIES[type].find((candidate) => candidate.name === property);
			if (!spec) {
				problems.push({
					at,
					message: `A ${SCHEMA_TYPE_NAMES[type]} has no property ${property}.`,
					rule: "schemaPropertyUnknown",
					params: { property },
				});
				continue;
			}
			if (source === null || source === "") continue;
			if (typeof source !== "string" || !sourceGives(fields, source, spec.kind)) {
				problems.push({
					at,
					message: `${String(source)} can't give ${property}: choose a Field of the right kind.`,
					rule: "schemaSource",
					params: { property, source: String(source) },
				});
				continue;
			}
			properties[property] = source;
		}
		const { question, answer } = properties;
		if (
			(question === undefined) !== (answer === undefined) ||
			(question && repeaterOf(question) !== repeaterOf(answer ?? ""))
		) {
			problems.push({
				at: "seo.schema.properties.answer",
				message: "An FAQ's questions and answers are two Fields of the same Repeater.",
				rule: "schemaFaqRepeater",
			});
		}
		next.schema = { type, properties };
	}
	return next;
}

/** What is wrong with a title pattern, if anything: its length, or a token WebCraft doesn't know. */
function titlePatternProblem(input: unknown): Omit<ContentProblem, "at"> | undefined {
	const pattern = typeof input === "string" ? input.trim() : "";
	if (pattern === "" || pattern.length > TITLE_PATTERN_MAX_LENGTH) {
		return {
			message: `A title pattern has 1 to ${TITLE_PATTERN_MAX_LENGTH} characters.`,
			rule: "seoTitlePatternLength",
			params: { max: TITLE_PATTERN_MAX_LENGTH },
		};
	}
	for (const match of pattern.matchAll(/\{([^{}]*)\}|[{}]/g)) {
		const token = match[1];
		if (token === undefined || !(TITLE_TOKENS as readonly string[]).includes(token)) {
			return {
				message: `A title pattern uses ${TITLE_TOKENS.map((each) => `{${each}}`).join(", ")}.`,
				rule: "seoTitleToken",
				params: { token: match[0] },
			};
		}
	}
	return undefined;
}

/**
 * A title pattern filled in: each token's value in its place. A token without a value goes, with the
 * separator and spaces next to it, so `{title} {separator} {site}` on a page without a title is the
 * Site's name alone. Text inside the values (a separator in an Entry's title) is never touched.
 */
export function applyTitlePattern(pattern: string, values: Readonly<Record<TitleToken, string>>): string {
	const separator = values.separator.trim();
	type Segment = { value: string; token: TitleToken | null; gone?: boolean };
	const segments: Segment[] = pattern
		.split(/(\{[a-zA-Z]+\})/)
		.filter((part) => part !== "")
		.map((part) => {
			const token = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1];
			return token !== undefined && (TITLE_TOKENS as readonly string[]).includes(token)
				? { value: values[token as TitleToken].trim(), token: token as TitleToken }
				: { value: part, token: null };
		});
	// What joins two parts: the separator, or text of nothing but spaces and punctuation between them.
	const joins = (segment: Segment) =>
		segment.token === "separator" ||
		(segment.token === null && (segment.value.trim() === separator || /^[\s|·•:/\\–—-]*$/.test(segment.value)));
	segments.forEach((segment, index) => {
		if (segment.token === null || segment.token === "separator" || segment.value !== "") return;
		segment.gone = true;
		let after = index + 1;
		while (after < segments.length && joins(segments[after] as Segment)) (segments[after++] as Segment).gone = true;
		if (after < segments.length && after > index + 1) return;
		for (let before = index - 1; before >= 0 && joins(segments[before] as Segment); before--) {
			(segments[before] as Segment).gone = true;
		}
	});
	const kept = segments.filter((segment) => !segment.gone);
	while (kept.length > 0 && joins(kept[0] as Segment)) kept.shift();
	while (kept.length > 0 && joins(kept[kept.length - 1] as Segment)) kept.pop();
	return kept
		.map((segment) => segment.value)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}
