import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { publicProcedure } from "@webcraft/api";
import type { ApiClientUse, InstallServices } from "@webcraft/core";
import { DATE_STYLES, FORMATTER_NAMES, RESERVED_COMMANDS, TEMPLATE_COMMANDS } from "@webcraft/renderer";

import type { ProcedureOutcome } from "./server.ts";
import { placesOf } from "./session.ts";

/**
 * What AI clients read before they write (spec › MCP server): the Template markup reference, a
 * Site's schema (its languages, Post Types and their Fields, the Globals' Fields, Components, Loops
 * and Forms) and its Protected terms. Each is a resource and a topic of the hand-written
 * `guide_get` tool, which gathers in one call what would take many.
 *
 * A Site's schema and Protected terms are read through the same procedures, with the same checks,
 * as the tools: the client sees only what its Toolsets and its person's Permissions let it read.
 */

/** Calls a public procedure as the client, with its limits: what the guides read through. */
export type CallProcedure = (
	path: readonly string[],
	input: Record<string, unknown>,
	files: readonly string[],
) => Promise<ProcedureOutcome>;

const TOPICS = ["template-markup", "site-schema", "protected-terms"] as const;
type Topic = (typeof TOPICS)[number];

/** The hand-written tool reading a guide. */
export const GUIDE_TOOL = {
	name: "guide_get",
	title: "Read a guide",
	description:
		"Reads a guide in one call: `template-markup`, the reference of Template markup (how Templates and Components are written); `site-schema`, a Site's languages, Post Types and their Fields, the Globals' Fields, Components, Loops and Forms (give `siteId`); `protected-terms`, the words a Site never translates (give `siteId`). The same guides are resources.",
	inputSchema: {
		type: "object" as const,
		properties: {
			topic: { type: "string", enum: [...TOPICS] },
			siteId: { type: "string", format: "uuid", description: "The Site, for `site-schema` and `protected-terms`." },
		},
		required: ["topic"],
		additionalProperties: false,
	},
	annotations: { title: "Read a guide", readOnlyHint: true, openWorldHint: false },
	_meta: { "webcraft/toolsets": "always" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MARKUP_URI = "webcraft://guides/template-markup";
const SITE_URI = /^webcraft:\/\/sites\/([0-9a-f-]{36})\/(schema|protected-terms)$/;

/** Runs `guide_get`. */
export async function runGuide(
	services: InstallServices,
	use: ApiClientUse,
	args: Record<string, unknown>,
	call: CallProcedure,
): Promise<CallToolResult> {
	const topic = args.topic as Topic;
	if (!TOPICS.includes(topic)) {
		return refusal("GUIDE_UNKNOWN", `The topic is one of ${TOPICS.join(", ")}.`);
	}
	if (topic === "template-markup") return { content: [{ type: "text", text: templateMarkupReference() }] };
	const siteId = typeof args.siteId === "string" ? args.siteId : "";
	if (!UUID.test(siteId)) return refusal("SITE_REQUIRED", `Give the Site's id (siteId) for ${topic}.`);
	const guide =
		topic === "site-schema" ? await siteSchema(call, siteId) : await protectedTerms(services, use, call, siteId);
	if ("refusal" in guide) return refusal(guide.refusal.code, guide.refusal.message);
	return {
		content: [{ type: "text", text: JSON.stringify(guide.answer, null, 2) }],
		structuredContent: guide.answer,
	};
}

/** The guides as resources: the reference, then each Site the client reaches' schema and Protected terms. */
export async function guideResources(services: InstallServices, use: ApiClientUse) {
	const { sites } = await placesOf(services, use);
	return [
		{
			uri: MARKUP_URI,
			name: "template-markup",
			title: "Template markup reference",
			description: "How Templates and Components are written as Template markup.",
			mimeType: "text/markdown",
		},
		...sites.flatMap((site) => [
			{
				uri: `webcraft://sites/${site.id}/schema`,
				name: `${site.slug}-schema`,
				title: `${site.name}: Site schema`,
				description:
					"The Site's languages, Post Types and their Fields, the Globals' Fields, Components, Loops and Forms.",
				mimeType: "application/json",
			},
			{
				uri: `webcraft://sites/${site.id}/protected-terms`,
				name: `${site.slug}-protected-terms`,
				title: `${site.name}: Protected terms`,
				description: "The words the Site never translates.",
				mimeType: "application/json",
			},
		]),
	];
}

/** The guides of any Site, as resource templates. */
export function guideTemplates() {
	return [
		{
			uriTemplate: "webcraft://sites/{siteId}/schema",
			name: "site-schema",
			title: "Site schema",
			description: "A Site's languages, Post Types and their Fields, the Globals' Fields, Components, Loops and Forms.",
			mimeType: "application/json",
		},
		{
			uriTemplate: "webcraft://sites/{siteId}/protected-terms",
			name: "protected-terms",
			title: "Protected terms",
			description: "The words a Site never translates.",
			mimeType: "application/json",
		},
	];
}

/** Reads a guide resource. */
export async function readGuide(
	services: InstallServices,
	use: ApiClientUse,
	uri: string,
	call: CallProcedure,
): Promise<ReadResourceResult> {
	if (uri === MARKUP_URI) return { contents: [{ uri, mimeType: "text/markdown", text: templateMarkupReference() }] };
	const match = SITE_URI.exec(uri);
	if (!match?.[1]) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `There is no resource ${uri}.`);
	const siteId = match[1];
	const guide =
		match[2] === "schema" ? await siteSchema(call, siteId) : await protectedTerms(services, use, call, siteId);
	if ("refusal" in guide) throw new ProtocolError(ProtocolErrorCode.InvalidParams, guide.refusal.message);
	return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(guide.answer, null, 2) }] };
}

type Guide = { answer: Record<string, unknown> } | { refusal: { code: string; message: string } };

/**
 * A Site's schema, gathered from the procedures the client may call: the Site itself must be
 * readable; each other part is left out (named in `unavailable`) when the client may not read it.
 */
async function siteSchema(call: CallProcedure, siteId: string): Promise<Guide> {
	const site = await call(["sites", "get"], { siteId }, []);
	if (!site.ok) return { refusal: site.refusal };
	const unavailable: string[] = [];
	const read = async (part: string, path: string[], input: Record<string, unknown> = { siteId }) => {
		const outcome = await call(path, input, []);
		if (outcome.ok) return outcome.answer as Record<string, unknown>;
		unavailable.push(part);
		return null;
	};
	const [languages, postTypeList, globals, components, loops, forms] = await Promise.all([
		read("languages", ["languages", "list"]),
		read("postTypes", ["postTypes", "list"]),
		read("globals", ["globals", "get"]),
		read("components", ["components", "list"]),
		read("loops", ["loops", "list"]),
		read("forms", ["forms", "list"]),
	]);
	const listed = (postTypeList?.postTypes ?? []) as { id: string }[];
	const postTypes = postTypeList
		? (
				await Promise.all(
					listed.map((postType) => read("postTypes", ["postTypes", "get"], { siteId, postTypeId: postType.id })),
				)
			).map((answer, index) => answer?.postType ?? listed[index])
		: null;
	return {
		answer: {
			site: (site.answer as { site?: unknown }).site ?? site.answer,
			languages: languages ?? null,
			postTypes,
			globals: globals
				? { fields: (globals.globals as { fields?: unknown } | undefined)?.fields ?? globals.fields ?? null }
				: null,
			components: components?.components ?? null,
			loops: loops?.loops ?? null,
			forms: forms?.forms ?? null,
			unavailable: [...new Set(unavailable)],
		},
	};
}

/**
 * A Site's Protected terms (and its Workspace's), read through the Translation procedures where the
 * Install has them; an Install without them keeps none.
 */
async function protectedTerms(
	services: InstallServices,
	use: ApiClientUse,
	call: CallProcedure,
	siteId: string,
): Promise<Guide> {
	const site = await call(["sites", "get"], { siteId }, []);
	if (!site.ok) return { refusal: site.refusal };
	if (!publicProcedure(services, ["protectedTerms", "list"])) return { answer: { terms: [] } };
	const { actor } = use.access;
	const workspaceId = actor.kind === "token" || actor.kind === "grant" ? actor.workspaceId : "";
	const terms = await call(["protectedTerms", "list"], { workspaceId, siteId }, []);
	if (!terms.ok) return { refusal: terms.refusal };
	return { answer: terms.answer as Record<string, unknown> };
}

function refusal(code: string, message: string): CallToolResult {
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }, null, 2) }] };
}

let reference: string | undefined;

/** The Template markup reference, in WebCraft's words, with the names it lists taken from the renderer. */
export function templateMarkupReference(): string {
	reference ??= [
		"# Template markup",
		"",
		"Templates and Components are element trees. Template markup is their text form: strict HTML with values, commands and Components. Reading markup and writing it back gives the same tree, so a pulled, edited and saved file shows only your changes.",
		"",
		"## Elements",
		"",
		"- Every element needs its end tag (`<br>` and other void elements have none). Nothing a browser would repair is accepted.",
		"- Each element carries its id as `data-wc-id`, written last. Leave ids as they are; an element without one gets a new one.",
		"- `class` names Classes of the Site's Design system by name; a name the Site doesn't have is refused. An inline `style` becomes a generated Class.",
		"- Refused: doctypes, `<script>`, `<style>`, `<meta>`, `on…` attributes, and values inside tag names, attribute names, `style`, `class` or `srcdoc`.",
		'- Media: `src="media:<id>"` points at a file of the Site\'s Media library.',
		"",
		"## Values",
		"",
		"- `{{ path }}` shows a value, in text and inside attribute values: a built-in Field or one of the Post Type's (`{{ title }}`, `{{ price }}`), a part of one (`{{ address.city }}`, `{{ link.url }}`), what a Relationship points at, one level deep (`{{ category.title }}`), or the Globals as `site.x` (`{{ site.phone }}`). `site.language` is the page's language and `site.name` the Site's name.",
		`- Formatters: \`{{ path | formatter }}\`, one of ${FORMATTER_NAMES.map((name) => `\`${name}\``).join(", ")}. \`date\` takes a style (${DATE_STYLES.map((style) => `\`${style}\``).join(", ")}), \`number\` the decimals (\`number: 2\`), \`truncate\` a length (\`truncate: 80\`).`,
		'- Fixed text in other languages: `{{ "Read more" fr: "Lire la suite" }}`.',
		"- `\\{{` writes a literal `{{`.",
		"",
		"## Commands",
		"",
		`Blocks written \`{{@name …}} … {{/name}}\`; the commands are ${TEMPLATE_COMMANDS.map((command) => `\`{{@${command.name}}}\``).join(", ")}${RESERVED_COMMANDS.size > 0 ? ` (${[...RESERVED_COMMANDS].map((name) => `\`${name}\``).join(", ")} are reserved for later)` : ""}.`,
		"",
		'- `{{@if test}} … {{@else if test}} … {{@else}} … {{/if}}`: a Condition. Tests: a value on its own (not empty), `not x`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `site.language`, `now` against a date, `loop.first`, `loop.last`, `loop.odd`, `loop.even`, `loop.index`, `loop.count`, with `and`, `or`, `not` and brackets, and literals `"text"`, numbers, `true`, `false`.',
		"- `{{@loop latest-posts as post}} … {{@empty}} … {{/loop}}`: repeats its content for each item of a Loop of the Site (by name) or of a list the place reads (`gallery`, `post.tags`); items read as `post.x` (`item` without `as`), their position as `loop.x`. `{{@empty}}` shows when there are none. `<loop name>.count`, `.empty`, `.total`, `.page` and `.pages` read a Loop anywhere.",
		"- `{{@pagination latest-posts}}`: the page links of a Loop that paginates.",
		"- `{{@outlet}}`: where the Site template shows each page's content (the Site template only, once).",
		"- `{{@form <key>}}`: one of the Site's Forms, by its key. `{{@search}}`: the search box. `{{@languageSwitcher}}`, `{{@themeToggle}}` and `{{@consentSettings}}` take nothing.",
		"",
		"## Components",
		"",
		'- A PascalCase tag places a Component by name: `<PriceCard plan="Pro" price="{{ price }}"></PriceCard>`, its Props as attributes. Inside a Component, its Props read as `props.x`.',
		"",
		"## Saving",
		"",
		"- Saving markup saves the Draft; publishing makes it what visitors see. A save made from an older version than the Draft's (`basedOn`) is refused with `CHANGED_MEANWHILE`.",
		"- A refusal lists each problem with its line and column (`TEMPLATE_MARKUP_INVALID`, `data.problems`); a save that works answers `notices` the same way.",
		"- Read a Site's schema (`guide_get` with `site-schema`) for the Fields, Components and Loops a Template can use.",
	].join("\n");
	return reference;
}
