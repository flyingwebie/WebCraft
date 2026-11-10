import { accessibilityStatements, entries } from "@webcraft/db/schema";
import { type ElementTree, escapeAttribute, escapeText } from "@webcraft/renderer";
import { eq, sql } from "drizzle-orm";
import { type ComponentSources, createComponent, saveComponentMarkup } from "../content/components.ts";
import { createEntry, type DraftChange, type Entry } from "../content/entries.ts";
import { EntryInvalidError } from "../content/errors.ts";
import { canonicalLanguage, siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { isPagePostType } from "../content/pages.ts";
import { listPostTypes, updatePostType } from "../content/post-types.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

export type StatementForm = {
	organisation: string;
	website: string;
	standard: string;
	status: "notAssessed" | "full" | "partial" | "notCompliant";
	limitations: string;
	burden: string;
	excluded: string;
	alternatives: string;
	preparedOn: string;
	reviewedOn: string;
	method: string;
	feedback: string;
	feedbackUrl: string;
	enforcement: string;
	enforcementUrl: string;
};
export type StatementSettings = {
	pageId: string;
	postTypeId: string;
	componentId: string;
	fieldKey: string;
	enabled: boolean;
	forms: Record<string, StatementForm>;
};
export const STATEMENT_MODEL = "https://eur-lex.europa.eu/eli/dec_impl/2018/1523/oj";
export function createAccessibilityStatement(options: {
	sources: ComponentSources;
	saveDraft(scope: SiteScope, id: string, change: DraftChange): Promise<Entry>;
}) {
	const get = async (scope: SiteScope): Promise<StatementSettings | null> => {
		const row = await scope.first(accessibilityStatements);
		const page = row ? await scope.first(entries, eq(entries.id, row.pageId)) : undefined;
		return row && page
			? {
					pageId: row.pageId,
					postTypeId: page.postTypeId,
					componentId: row.componentId,
					fieldKey: row.fieldKey,
					enabled: row.enabled,
					forms: row.forms as Record<string, StatementForm>,
				}
			: null;
	};
	return {
		get,
		async setEnabled(scope: SiteScope, enabled: boolean) {
			await scope.transaction(async (tx) => {
				await tx.update(accessibilityStatements, { enabled });
				await clearPageCache(tx);
				await tx.audit("accessibilityStatement.change", { enabled });
			});
			return get(scope);
		},
		async generate(scope: SiteScope, form: StatementForm, language?: string) {
			const site = await siteLanguages(scope);
			const code = language === undefined ? site.defaultLanguage : canonicalLanguage(language);
			if (!code || !site.languages.some((l) => l.code === code))
				throw new EntryInvalidError([{ at: "language", message: "Choose a language of this Site." }]);
			// Serialise creation so two Staff cannot create different statement Pages for one Site.
			return scope.transaction(async (tx) => {
				await tx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`accessibility:${scope.site.id}`}))`);
				let settings = await get(tx);
				const pages = (await listPostTypes(tx)).find(isPagePostType);
				if (!pages) throw new Error("The Site has no Page Post Type.");
				if (!settings) {
					let fieldKey = "accessibilityStatement";
					while (pages.fields.some((f) => f.key === fieldKey)) fieldKey += "Text";
					await updatePostType(tx, pages.id, {
						fields: [
							...pages.fields,
							{ key: fieldKey, label: "Accessibility statement", type: "group", fields: statementFields() },
						],
					});
					const component = await createComponent(
						tx,
						{
							name: `AccessibilityStatement${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
							props: [{ key: "title", label: "Title", type: "text" }, ...statementFields()],
						},
						options.sources,
					);
					await saveComponentMarkup(tx, component.id, { markup: statementMarkup() }, options.sources);
					const page = await createEntry(tx, { postTypeId: pages.id, title: statementTitle(site.defaultLanguage) });
					settings = {
						pageId: page.id,
						postTypeId: pages.id,
						componentId: component.id,
						fieldKey,
						enabled: true,
						forms: {},
					};
					const { postTypeId: _, ...stored } = settings;
					await tx.insert(accessibilityStatements, stored);
				}
				const page = await options.saveDraft(tx, settings.pageId, {
					language: code,
					title: statementTitle(code),
					fields: { [settings.fieldKey]: statementText(form, code) },
				});
				const forms = { ...settings.forms, [code]: form };
				await tx.update(accessibilityStatements, { forms });
				await tx.audit("accessibilityStatement.generate", { pageId: page.id, language: code });
				return { page, settings: { ...settings, forms } };
			});
		},
	};
}
export type AccessibilityStatementService = ReturnType<typeof createAccessibilityStatement>;

/** Stored Component + ordinary Page Field, until the general Page layout editor is available. */
export async function statementLayout(
	scope: Pick<SiteScope, "first">,
	pageId: string,
): Promise<ElementTree | undefined> {
	const settings = await scope.first(accessibilityStatements);
	if (settings?.pageId !== pageId) return undefined;
	return {
		version: 1,
		nodes: [
			{
				type: "component",
				id: "accessibility-statement",
				component: settings.componentId,
				props: [
					{ name: "title", value: [{ type: "value", path: "title" }] },
					...statementFields().map((field) => ({
						name: field.key,
						value: [{ type: "value" as const, path: `${settings.fieldKey}.${field.key}` }],
					})),
				],
			},
		],
	};
}
export function statementTitle(language: string): string {
	return language.split("-")[0] === "it" ? "Dichiarazione di accessibilità" : "Accessibility statement";
}

const SECTIONS = {
	status: ["Compliance status", "Stato di conformità"],
	limitations: ["Non-accessible content", "Contenuti non accessibili"],
	burden: ["Disproportionate burden", "Onere sproporzionato"],
	excluded: ["Content outside the legislation’s scope", "Contenuti esclusi dall’ambito della normativa"],
	alternatives: ["Accessible alternatives", "Alternative accessibili"],
	preparation: ["Preparation and review", "Preparazione e riesame"],
	feedback: ["Feedback and contact information", "Feedback e contatti"],
	enforcement: ["Enforcement procedure", "Procedura di attuazione"],
} as const;
function statementFields() {
	return [
		{ key: "introduction", label: "Introduction", type: "richText" as const, translatable: true },
		...Object.entries(SECTIONS).flatMap(([key, labels]) => [
			{ key: `${key}Heading`, label: `${labels[0]} heading`, type: "text" as const, translatable: true },
			{ key, label: labels[0], type: "richText" as const, translatable: true },
		]),
		{ key: "model", label: "About this statement", type: "richText" as const, translatable: true },
	];
}
function statementMarkup() {
	return `<article><h1>{{ props.title }}</h1>{{ props.introduction }}${Object.keys(SECTIONS)
		.map((key) => `<section><h2>{{ props.${key}Heading }}</h2>{{ props.${key} }}</section>`)
		.join("")}{{ props.model }}</article>`;
}
/** EU model 2018/1523, Annex section 1. Facts are supplied by Staff, never inferred from Checks. */
function statementText(f: StatementForm, language: string): Record<string, string> {
	const it = language.split("-")[0] === "it";
	const p = (text: string) => `<p>${escapeText(text)}</p>`;
	const link = (url: string, text: string) => `<p><a href="${escapeAttribute(url)}">${escapeText(text)}</a></p>`;
	const status = {
		notAssessed: it
			? "Questo sito mira a WCAG 2.2 AA; la verifica manuale non è ancora stata completata. La conformità non è stata accertata."
			: "This website aims for WCAG 2.2 AA; a manual audit is pending. Compliance has not been established.",
		full: it
			? "Secondo la valutazione indicata di seguito, questo sito è pienamente conforme a:"
			: "According to the assessment below, this website is fully compliant with:",
		partial: it
			? "Secondo la valutazione indicata di seguito, questo sito è parzialmente conforme a:"
			: "According to the assessment below, this website is partially compliant with:",
		notCompliant: it
			? "Secondo la valutazione indicata di seguito, questo sito non è conforme a:"
			: "According to the assessment below, this website is not compliant with:",
	};
	return {
		...Object.fromEntries(Object.entries(SECTIONS).map(([key, labels]) => [`${key}Heading`, labels[it ? 1 : 0]])),
		introduction:
			p(
				it
					? `${f.organisation} si impegna a rendere accessibile il proprio sito.`
					: `${f.organisation} is committed to making its website accessible.`,
			) + link(f.website, f.website),
		status: p(status[f.status]) + p(f.standard),
		limitations: p(f.limitations),
		burden: p(f.burden),
		excluded: p(f.excluded),
		alternatives: p(f.alternatives),
		preparation:
			p(
				`${it ? "Preparata il" : "Prepared on"}: ${f.preparedOn}. ${it ? "Ultimo riesame" : "Last reviewed"}: ${f.reviewedOn}.`,
			) + p(f.method),
		feedback:
			p(f.feedback) +
			link(
				f.feedbackUrl,
				it ? "Segnala un problema o richiedi contenuti accessibili" : "Report a problem or request accessible content",
			),
		enforcement:
			p(f.enforcement) +
			link(f.enforcementUrl, it ? "Contatta l’organismo di controllo" : "Contact the enforcement body"),
		model: p(
			it
				? "I controlli automatici non certificano la conformità. Questa dichiarazione segue il modello UE per i siti del settore pubblico; non è una dichiarazione di conformità ai sensi dell’Atto europeo sull’accessibilità."
				: "Automated Checks do not certify compliance. This statement follows the EU model for public-sector websites; it is not a declaration of conformity under the European Accessibility Act.",
		),
	};
}
