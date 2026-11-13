import { CONTENT_API_ERRORS, type ContentApiErrorCode } from "./errors.ts";
import { CONTENT_API_LIMITS, CONTENT_KEY_PREFIX } from "./keys.ts";
import { BODY_FORMATS, CONTENT_API_PAGE, CONTENT_API_QUERY_PROBLEMS } from "./params.ts";

/**
 * The Content API's own OpenAPI 3.1 document (ADR 0029), separate from the Management API's: the same
 * for every Site, served at `/_content/v1/openapi.json` on each Site that has the API on, and checked
 * in at `docs/api/content-api.openapi.json` (`bun run content-api:document` writes it again). Its error
 * codes, query problems, limits and formats are read from the code that applies them, so the document
 * can't say other than what the API does.
 */
export function contentApiDocument(): Record<string, unknown> {
	return {
		openapi: "3.1.0",
		info: {
			title: "WebCraft Content API",
			version: "1",
			description: [
				"A Site's read-only API for frontends built elsewhere: its published content only, never Drafts.",
				"It answers on each of the Site's domains and its Staging address under `/_content/v1`, once Staff switch it on (Site settings › Content API).",
				`Every request carries one of the Site's Content keys in the Authorization header (\`Authorization: Bearer ${CONTENT_KEY_PREFIX}…\`), never in the address. A key reads published content only, so it may sit in browser code; browsers on other sites may send it only from the origins it lists (CORS, with preflights).`,
				`Limits: ${CONTENT_API_LIMITS.key.limit} requests a minute per Content key and ${CONTENT_API_LIMITS.address.limit} per client address, then 429 with Retry-After. Every answer carries RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset (seconds) of the limit closest to running out.`,
				"Caching: answers carry a strong ETag and `Cache-Control: public, max-age=0, must-revalidate`; `If-None-Match` gets 304. Every publish (Publish all, Scheduled publishes and unpublishes, AI translation's publishes included) gives new answers at once.",
				"Languages: `lang` reads one of the Site's languages (on a language's own domain, that language unless given). A value with none of its own falls back one Field at a time through `fallback` (the Default language unless given; `none` for none), and `fallbacks` names each value read from another language. An Entry hidden in the language never appears there.",
				"Versioning: changes within v1 are additive only; a breaking change ships as a new major version beside this one for at least 12 months, with a Deprecation header meanwhile.",
			].join("\n\n"),
			license: { name: "AGPL-3.0-or-later" },
		},
		servers: [{ url: "/_content/v1", description: "On each of the Site's domains and its Staging address." }],
		security: [{ contentKey: [] }],
		"x-webcraft-errors": Object.fromEntries(
			Object.entries(CONTENT_API_ERRORS).map(([code, { status, meaning }]) => [code, { status, meaning }]),
		),
		"x-webcraft-query-problems": CONTENT_API_QUERY_PROBLEMS,
		paths: {
			"/entries/{postType}": {
				get: operation(
					"entries.list",
					"A Post Type's published Entries",
					`Newest published first unless \`sort\` asks otherwise, ${CONTENT_API_PAGE.default} at a time (\`limit\`, up to ${CONTENT_API_PAGE.max}); \`next\` is a cursor for the rest, to send as \`cursor\` with the same query.\n\nFilters: \`filter.<field>=<value>\` (equality), \`filter.<field>.in=<a>,<b>\` (one of, up to 50), and for numbers and days \`filter.<field>.gt|gte|lt|lte=<value>\`; a Relationship by the id of what it points at. Which Fields take which is each Field's \`filters\` in the schema; \`publishedAt\` and \`lastPublishedAt\` take the ranges. Several filters must all hold.\n\nOne sort Field: \`sort=<field>\`, \`-<field>\` for descending (Fields whose \`sortable\` is true, \`title\`, \`publishedAt\`, \`lastPublishedAt\`); Entries without a value come last, then the Entry's id breaks ties, so pages never repeat or skip one.`,
					[
						{ $ref: "#/components/parameters/postType" },
						...readingParameters(),
						{ $ref: "#/components/parameters/sort" },
						{ $ref: "#/components/parameters/limit" },
						{ $ref: "#/components/parameters/cursor" },
					],
					"EntryList",
					["QUERY_INVALID", "POST_TYPE_NOT_FOUND"],
				),
			},
			"/entries/{postType}/{id}": {
				get: operation(
					"entries.get",
					"One published Entry, by id",
					"An Entry unpublished since answers 410 ENTRY_GONE.",
					[
						{ $ref: "#/components/parameters/postType" },
						{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
						...readingParameters(),
					],
					"OneEntry",
					["QUERY_INVALID", "POST_TYPE_NOT_FOUND", "ENTRY_NOT_FOUND", "ENTRY_GONE"],
				),
			},
			"/entries/{postType}/slug/{slug}": {
				get: operation(
					"entries.bySlug",
					"One published Entry, by its slug in the language",
					"Not for Pages, whose slugs repeat under different parents: find them by path.",
					[
						{ $ref: "#/components/parameters/postType" },
						{ name: "slug", in: "path", required: true, schema: { type: "string" } },
						...readingParameters(),
					],
					"OneEntry",
					["QUERY_INVALID", "POST_TYPE_NOT_FOUND", "ENTRY_NOT_FOUND", "ENTRY_GONE"],
				),
			},
			"/entry": {
				get: operation(
					"entries.atPath",
					"The published Entry at a path on the Site",
					"`path` is the Entry's `path` as answered: under its language's prefix (`/fr/blog/pain-frais`), which names the language read; `/` is the home page.",
					[
						{ name: "path", in: "query", required: true, schema: { type: "string", example: "/blog/fresh-bread" } },
						...readingParameters().filter((parameter) => parameter.$ref !== "#/components/parameters/lang"),
					],
					"OneEntry",
					["QUERY_INVALID", "ENTRY_NOT_FOUND", "ENTRY_GONE"],
				),
			},
			"/globals": {
				get: operation(
					"globals.get",
					"The Globals' published values",
					"Every exposed Global (`fields` names some), null for one never published.",
					[
						{ $ref: "#/components/parameters/lang" },
						{ $ref: "#/components/parameters/fallback" },
						{ $ref: "#/components/parameters/fields" },
					],
					"Globals",
					["QUERY_INVALID"],
				),
			},
			"/media/{id}": {
				get: operation(
					"media.get",
					"A Media item's details",
					"A ready Media item of the Site, not in the Trash: its addresses on the Site's domain, its resized copies, and its title, alt text and caption in the language.",
					[
						{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
						{ $ref: "#/components/parameters/lang" },
						{ $ref: "#/components/parameters/fallback" },
					],
					"OneMedia",
					["QUERY_INVALID", "MEDIA_NOT_FOUND"],
				),
			},
			"/search": {
				get: operation(
					"search",
					"Searches the Site's published Entries",
					"Through Site search: the published Entries of searchable Post Types whose Searched fields are all exposed, in the language, best match first, each with a snippet (escaped text, matches in `<mark>`). Never kept in the page cache; its first 1,000 hits.",
					[
						{ name: "q", in: "query", required: true, schema: { type: "string", maxLength: 200 } },
						{
							name: "postType",
							in: "query",
							schema: { type: "string" },
							description: "Post Type keys, comma-separated.",
						},
						{ $ref: "#/components/parameters/lang" },
						{ $ref: "#/components/parameters/fallback" },
						{ $ref: "#/components/parameters/limit" },
						{ $ref: "#/components/parameters/cursor" },
					],
					"SearchHits",
					["QUERY_INVALID"],
				),
			},
			"/languages": {
				get: operation("languages.list", "The Site's languages", "The Default language first.", [], "Languages", []),
			},
			"/schema": {
				get: operation(
					"schema.get",
					"What the Site exposes",
					"Its languages, the built-in values, each exposed Post Type with its exposed Fields (how lists filter and sort by each), and the Globals' exposed Fields.",
					[],
					"Schema",
					[],
				),
			},
			"/openapi.json": {
				get: {
					operationId: "openapi",
					summary: "This document",
					description: "Needs no key.",
					security: [],
					responses: {
						"200": { description: "This document.", content: { "application/json": { schema: { type: "object" } } } },
					},
				},
			},
		},
		components: {
			securitySchemes: {
				contentKey: {
					type: "http",
					scheme: "bearer",
					description: `One of the Site's Content keys (\`${CONTENT_KEY_PREFIX}…\`), made by Staff under Site settings › Content API.`,
				},
			},
			parameters: {
				postType: {
					name: "postType",
					in: "path",
					required: true,
					schema: { type: "string" },
					description: "The Post Type's key.",
				},
				lang: {
					name: "lang",
					in: "query",
					schema: { type: "string", example: "fr" },
					description: "The language read.",
				},
				fallback: {
					name: "fallback",
					in: "query",
					schema: { type: "string", example: "de,en" },
					description:
						"Languages a missing value falls back through, in order, comma-separated; `none` for none. The Default language unless given.",
				},
				body: {
					name: "body",
					in: "query",
					schema: { type: "string", enum: [...BODY_FORMATS], default: "html" },
					description:
						"How Body fields are answered: semantic HTML, the Blocks as stored (with their ids), or Markdown.",
				},
				fields: {
					name: "fields",
					in: "query",
					schema: { type: "string", example: "summary,category.title,category.colour" },
					description:
						"The Fields to answer, comma-separated (every exposed one unless given; built-in values always come). `<relationship>.<field>` answers the Entries a Relationship points at with those Fields of theirs, one level deep.",
				},
				sort: { name: "sort", in: "query", schema: { type: "string", example: "-price", default: "-publishedAt" } },
				limit: {
					name: "limit",
					in: "query",
					schema: { type: "integer", minimum: 1, maximum: CONTENT_API_PAGE.max, default: CONTENT_API_PAGE.default },
				},
				cursor: {
					name: "cursor",
					in: "query",
					schema: { type: "string" },
					description: "A list's `next`, with the same query.",
				},
			},
			schemas: SCHEMAS,
		},
	};
}

/** The parameters every Entry is read with. */
function readingParameters(): { $ref: string }[] {
	return ["lang", "fallback", "body", "fields"].map((name) => ({ $ref: `#/components/parameters/${name}` }));
}

/** Refusals every request may get: the API off, no working key, another site's page, past a limit. */
const ALWAYS: readonly ContentApiErrorCode[] = [
	"CONTENT_API_OFF",
	"CONTENT_KEY_INVALID",
	"CONTENT_KEY_IN_QUERY",
	"ORIGIN_NOT_ALLOWED",
	"TOO_MANY_REQUESTS",
];

function operation(
	operationId: string,
	summary: string,
	description: string,
	parameters: unknown[],
	schema: string,
	refusals: readonly ContentApiErrorCode[],
) {
	const byStatus = new Map<number, ContentApiErrorCode[]>();
	for (const code of [...refusals, ...ALWAYS]) {
		const { status } = CONTENT_API_ERRORS[code];
		byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
	}
	return {
		operationId,
		summary,
		description,
		parameters,
		responses: {
			"200": {
				description: "Published content, with a strong ETag.",
				headers: { ETag: { schema: { type: "string" } } },
				content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
			},
			"304": { description: "Unchanged since the ETag sent in If-None-Match." },
			...Object.fromEntries(
				[...byStatus].map(([status, codes]) => [
					String(status),
					{
						description: codes.map((code) => `${code}: ${CONTENT_API_ERRORS[code].meaning}`).join(" "),
						content: {
							"application/json": {
								schema: {
									allOf: [{ $ref: "#/components/schemas/Error" }, { properties: { code: { enum: codes } } }],
								},
							},
						},
					},
				]),
			),
		},
	};
}

const nullableString = { type: ["string", "null"] };

const SCHEMAS = {
	Error: {
		type: "object",
		required: ["code", "status", "message"],
		properties: {
			code: { type: "string", enum: Object.keys(CONTENT_API_ERRORS) },
			status: { type: "integer" },
			message: { type: "string" },
			data: {
				type: "object",
				description: "`problem` (CONTENT_KEY_INVALID), `origin`, `limit`, or `problems` (QUERY_INVALID).",
				properties: { problems: { type: "array", items: { $ref: "#/components/schemas/QueryProblem" } } },
			},
		},
	},
	QueryProblem: {
		type: "object",
		required: ["parameter", "problem", "message"],
		properties: {
			parameter: { type: "string" },
			problem: { type: "string", enum: Object.keys(CONTENT_API_QUERY_PROBLEMS) },
			message: { type: "string" },
		},
	},
	Entry: {
		type: "object",
		required: [
			"id",
			"postType",
			"language",
			"title",
			"slug",
			"path",
			"url",
			"publishedAt",
			"lastPublishedAt",
			"seo",
			"fields",
			"fallbacks",
		],
		properties: {
			id: { type: "string", format: "uuid" },
			postType: { type: "string" },
			language: { type: "string" },
			title: { type: "string" },
			slug: nullableString,
			path: { ...nullableString, description: "Where visitors find it on the Site, under its language's prefix." },
			url: {
				...nullableString,
				description: "Its absolute address for visitors (a language's own domain when it has one).",
			},
			parent: { type: ["string", "null"], format: "uuid", description: "Pages only: the parent Page." },
			publishedAt: { type: ["string", "null"], format: "date-time" },
			lastPublishedAt: { type: ["string", "null"], format: "date-time" },
			seo: {
				type: "object",
				properties: {
					title: nullableString,
					description: nullableString,
					canonical: nullableString,
					image: { oneOf: [{ $ref: "#/components/schemas/Media" }, { type: "null" }] },
					noindex: { type: "boolean" },
				},
			},
			fields: {
				type: "object",
				description:
					"The exposed Fields' values by key: text, numbers, true/false, days and times as text, a choice's value (or a list), Media as their details, a link as `{ url, text }`, a Relationship as Entry ids (or, asked through `fields`, those Entries), a Group's values by key, a Repeater's rows (`{ id, …}`), a Body field as `body` asks.",
				additionalProperties: true,
			},
			fallbacks: {
				type: "object",
				description:
					"Each value read from another language than the one asked, by its path (`summary`, `origin.city`, `steps[1].text`), with that language.",
				additionalProperties: { type: "string" },
			},
		},
	},
	EntryList: {
		type: "object",
		required: ["items", "total", "next"],
		properties: {
			items: { type: "array", items: { $ref: "#/components/schemas/Entry" } },
			total: { type: "integer" },
			next: { ...nullableString, description: "A cursor for the next page; null on the last." },
		},
	},
	OneEntry: { type: "object", required: ["entry"], properties: { entry: { $ref: "#/components/schemas/Entry" } } },
	Media: {
		type: "object",
		properties: {
			id: { type: "string", format: "uuid" },
			kind: { type: "string", enum: ["image", "document", "video", "audio"] },
			contentType: { type: "string" },
			fileName: { type: "string" },
			size: { type: "integer" },
			width: { type: ["integer", "null"] },
			height: { type: ["integer", "null"] },
			url: { type: "string", format: "uri" },
			alt: nullableString,
			title: nullableString,
			caption: nullableString,
			focalPoint: { type: ["object", "null"], properties: { x: { type: "integer" }, y: { type: "integer" } } },
			variants: {
				type: "array",
				items: {
					type: "object",
					properties: {
						type: { type: "string" },
						width: { type: "integer" },
						height: { type: "integer" },
						url: { type: "string", format: "uri" },
					},
				},
			},
		},
	},
	OneMedia: {
		type: "object",
		properties: { media: { $ref: "#/components/schemas/Media" }, language: { type: "string" } },
	},
	Globals: {
		type: "object",
		properties: {
			language: { type: "string" },
			publishedAt: { type: ["string", "null"], format: "date-time" },
			lastPublishedAt: { type: ["string", "null"], format: "date-time" },
			fields: { type: "object", additionalProperties: true },
			fallbacks: { type: "object", additionalProperties: { type: "string" } },
		},
	},
	SearchHits: {
		type: "object",
		properties: {
			items: {
				type: "array",
				items: {
					type: "object",
					description: "An Entry's built-in values, with `snippet`.",
					properties: { snippet: { type: "string" } },
					additionalProperties: true,
				},
			},
			total: { type: "integer" },
			next: nullableString,
		},
	},
	Languages: {
		type: "object",
		properties: {
			defaultLanguage: { type: "string" },
			languages: {
				type: "array",
				items: {
					type: "object",
					properties: {
						code: { type: "string" },
						name: { type: "string" },
						direction: { type: "string", enum: ["ltr", "rtl"] },
						default: { type: "boolean" },
						url: { type: "string", format: "uri" },
					},
				},
			},
		},
	},
	Schema: {
		type: "object",
		properties: {
			defaultLanguage: { type: "string" },
			languages: { type: "array", items: { type: "string" } },
			builtInFields: { type: "array", items: { type: "object", additionalProperties: true } },
			postTypes: {
				type: "array",
				items: {
					type: "object",
					properties: {
						key: { type: "string" },
						name: { type: "string" },
						pages: { type: "boolean" },
						urlPattern: nullableString,
						searchable: { type: "boolean" },
						fields: {
							type: "array",
							items: {
								type: "object",
								description:
									"A Field: its key, label, type, whether it is translatable and required, its type's settings (options, multiple, postTypes, mode, integer, fields), and at the top level `filters` (operators) and `sortable`.",
								additionalProperties: true,
							},
						},
					},
				},
			},
			globals: {
				type: "object",
				properties: { fields: { type: "array", items: { type: "object", additionalProperties: true } } },
			},
		},
	},
};
