import { useRouter } from "@tanstack/react-router";
import {
	BUILT_IN_SOURCES,
	fieldAt,
	givesDescription,
	givesImage,
	guessSchemaProperties,
	SCHEMA_PROPERTIES,
	SCHEMA_TYPES,
	type SchemaType,
	sourcesFor,
	TITLE_TOKENS,
	type TitleToken,
} from "@webcraft/core/seo-rules";
import { SOCIAL_CARD_LAYOUTS, type SocialCardLayout } from "@webcraft/core/social-card-rules";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { CircleAlertIcon, PlusIcon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAfterRender } from "../after-render.ts";

import { getApi } from "../api.ts";
import type { FieldDefinition, PostTypeView, Problem } from "../content/model.ts";
import { settingProblemText } from "../content/problems.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";

type Settings = PostTypeView["seo"];

/** Every Field path of a Post Type with its name as Staff see it ("Venue › City"). */
function fieldNames(fields: readonly FieldDefinition[], prefix = "", names: string[] = []): Map<string, string> {
	const found = new Map<string, string>();
	for (const field of fields) {
		const path = `${prefix}${field.key}`;
		const name = [...names, field.label || field.key];
		found.set(path, name.join(" › "));
		if (field.type === "group" || field.type === "repeater") {
			for (const [inner, innerName] of fieldNames(field.fields, `${path}.`, name)) found.set(inner, innerName);
		}
	}
	return found;
}

/** The message naming a built-in source. */
const SOURCE_NAMES: Readonly<Record<string, MessageKey>> = {
	title: "seo.sources.title",
	author: "seo.sources.author",
	publishedAt: "seo.sources.publishedAt",
	lastPublishedAt: "seo.sources.lastPublishedAt",
	createdAt: "seo.sources.createdAt",
	"seo.description": "seo.sources.seoDescription",
	"seo.image": "seo.sources.seoImage",
};

/**
 * A Post Type's SEO tab (Structure, Staff only): its title pattern, its Summary field (which
 * descriptions, llms.txt and Markdown copies use) and the Field its social image falls back to, its
 * Schema type with each property mapped to a source, and whether the Site's sitemaps and llms.txt
 * list its Entries. Choosing a Schema type maps its properties to WebCraft's guesses, which Staff then
 * change. Like the rest of a Post Type, changes apply once saved.
 */
export function PostTypeSeoSettings({ postType, siteId }: { postType: PostTypeView; siteId: string }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const names = useMemo(() => fieldNames(postType.fields), [postType.fields]);
	const [saved, setSaved] = useState<Settings>(postType.seo);
	const [settings, setSettings] = useState<Settings>(postType.seo);
	const [savedSitemap, setSavedSitemap] = useState(postType.sitemap);
	const [sitemap, setSitemap] = useState(postType.sitemap);
	const [problems, setProblems] = useState<string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const summary = useRef<HTMLDivElement>(null);
	const afterRender = useAfterRender();
	const pattern = useRef<HTMLInputElement>(null);
	const dirty = JSON.stringify(settings) !== JSON.stringify(saved) || sitemap !== savedSitemap;
	const hasBody = postType.fields.some((field) => field.type === "body");
	const descriptionChoices = [...names.keys()].filter((path) => givesDescription(postType.fields, path));
	const imageChoices = [...names.keys()].filter((path) => givesImage(postType.fields, path));
	const sourceName = (source: string) =>
		BUILT_IN_SOURCES[source] ? t(SOURCE_NAMES[source] ?? "seo.sources.title") : (names.get(source) ?? source);

	/** Puts a token where the caret was in the title pattern (at its end otherwise), and the caret after it. */
	const addToken = (token: TitleToken) => {
		const input = pattern.current;
		const text = `{${token}}`;
		const current = settings.titlePattern;
		const at = input?.selectionStart ?? current.length;
		const end = input?.selectionEnd ?? at;
		setSettings({ ...settings, titlePattern: `${current.slice(0, at)}${text}${current.slice(end)}` });
		requestAnimationFrame(() => {
			input?.focus();
			input?.setSelectionRange(at + text.length, at + text.length);
		});
	};

	const chooseType = (type: SchemaType) =>
		setSettings((before) => ({
			...before,
			schema: {
				type,
				properties: type === saved.schema.type ? saved.schema.properties : guessSchemaProperties(type, postType.fields),
			},
		}));

	const map = (property: string, source: string) =>
		setSettings((before) => {
			const properties: Record<string, string> = { ...before.schema.properties };
			if (source) properties[property] = source;
			else delete properties[property];
			return { ...before, schema: { ...before.schema, properties } };
		});

	const save = async () => {
		setBusy(true);
		setProblems(null);
		try {
			const api = await getApi();
			const { postType: updated } = await api.postTypes.update({
				siteId,
				postTypeId: postType.id,
				summaryField: settings.descriptionField,
				sitemap,
				seo: {
					socialCardLayout: settings.socialCardLayout,
					titlePattern: settings.titlePattern,
					imageField: settings.imageField,
					schema: { type: settings.schema.type, properties: { ...settings.schema.properties } },
				},
			});
			setSaved(updated.seo);
			setSettings(updated.seo);
			setSavedSitemap(updated.sitemap);
			setSitemap(updated.sitemap);
			toast.success(t("seo.postType.saved"));
			await router.invalidate();
		} catch (error) {
			const data = (error as { data?: { problems?: Problem[] } }).data;
			setProblems(
				errorCode(error) === "POST_TYPE_INVALID" && data?.problems
					? data.problems.map((problem) => settingProblemText(t, problem))
					: [t(errorMessage(error))],
			);
			afterRender(() => summary.current?.focus());
		} finally {
			setBusy(false);
		}
	};

	return (
		<section aria-labelledby={`${id}-heading`} className="grid min-w-0 content-start gap-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="grid max-w-prose gap-1">
					<h2 id={`${id}-heading`} className="text-lg font-semibold">
						{t("seo.postType.heading")}
					</h2>
					<p className="text-muted-foreground">{t("seo.postType.intro")}</p>
				</div>
				<div className="flex items-center gap-3">
					<p role="status" className="text-muted-foreground text-sm">
						{dirty ? t("seo.postType.unsaved") : ""}
					</p>
					<Button
						type="button"
						variant="outline"
						disabled={!dirty || busy}
						onClick={() => {
							setSettings(saved);
							setSitemap(savedSitemap);
							setProblems(null);
						}}
					>
						{t("seo.postType.discard")}
					</Button>
					<Button type="button" disabled={!dirty || busy} onClick={save}>
						{t("seo.postType.save")}
					</Button>
				</div>
			</div>

			{problems ? (
				<div
					ref={summary}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 text-destructive grid gap-2 rounded-lg border p-4 text-sm outline-none"
				>
					<p className="flex items-center gap-2 font-medium">
						<CircleAlertIcon className="size-4" aria-hidden="true" />
						{t("seo.postType.notSaved")}
					</p>
					<ul className="grid list-disc gap-1 ps-6">
						{problems.map((problem) => (
							<li key={problem}>{problem}</li>
						))}
					</ul>
				</div>
			) : null}

			<div className="grid max-w-3xl gap-2">
				<Label htmlFor={`${id}-social-layout`}>{t("seo.socialCards.layout")}</Label>
				<NativeSelect
					id={`${id}-social-layout`}
					value={settings.socialCardLayout ?? ""}
					aria-describedby={`${id}-social-help`}
					onChange={(event) =>
						setSettings({ ...settings, socialCardLayout: (event.target.value || null) as SocialCardLayout | null })
					}
				>
					<NativeSelectOption value="">{t("seo.socialCards.inherit")}</NativeSelectOption>
					{SOCIAL_CARD_LAYOUTS.map((layout) => (
						<NativeSelectOption key={layout} value={layout}>
							{t(`seo.socialCards.layouts.${layout}`)}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<p id={`${id}-social-help`} className="text-muted-foreground text-sm">
					{t("seo.socialCards.overrideHelp")}
				</p>
			</div>
			<div className="grid max-w-3xl gap-2">
				<Label htmlFor={`${id}-pattern`}>{t("seo.postType.titlePattern")}</Label>
				<Input
					ref={pattern}
					id={`${id}-pattern`}
					value={settings.titlePattern}
					className="font-mono"
					autoComplete="off"
					spellCheck={false}
					aria-describedby={`${id}-pattern-help`}
					onChange={(event) => setSettings((before) => ({ ...before, titlePattern: event.target.value }))}
				/>
				<div id={`${id}-pattern-help`} className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
					<span>{t("seo.postType.titlePatternHelp")}</span>
					{TITLE_TOKENS.map((token) => (
						<Button
							key={token}
							type="button"
							variant="outline"
							size="sm"
							aria-label={t("seo.postType.addToken", { token: `{${token}}` })}
							onClick={() => addToken(token)}
						>
							<PlusIcon aria-hidden="true" />
							<code>{`{${token}}`}</code>
						</Button>
					))}
				</div>
			</div>

			<div className="grid max-w-3xl gap-6 sm:grid-cols-2">
				<div className="grid content-start gap-2">
					<Label htmlFor={`${id}-description`}>{t("seo.postType.descriptionField")}</Label>
					<NativeSelect
						id={`${id}-description`}
						className="w-full"
						value={settings.descriptionField ?? ""}
						aria-describedby={`${id}-description-help`}
						onChange={(event) => setSettings((before) => ({ ...before, descriptionField: event.target.value || null }))}
					>
						<NativeSelectOption value="">
							{hasBody ? t("seo.postType.bodyStart") : t("seo.postType.noBody")}
						</NativeSelectOption>
						{descriptionChoices.map((path) => (
							<NativeSelectOption key={path} value={path}>
								{names.get(path) ?? path}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<p id={`${id}-description-help`} className="text-muted-foreground text-sm">
						{t("seo.postType.descriptionHelp")}
					</p>
				</div>
				<div className="grid content-start gap-2">
					<Label htmlFor={`${id}-image`}>{t("seo.postType.imageField")}</Label>
					<NativeSelect
						id={`${id}-image`}
						className="w-full"
						value={settings.imageField ?? ""}
						aria-describedby={`${id}-image-help`}
						onChange={(event) => setSettings((before) => ({ ...before, imageField: event.target.value || null }))}
					>
						<NativeSelectOption value="">{t("seo.postType.noImage")}</NativeSelectOption>
						{imageChoices.map((path) => (
							<NativeSelectOption key={path} value={path}>
								{names.get(path) ?? path}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<p id={`${id}-image-help`} className="text-muted-foreground text-sm">
						{t("seo.postType.imageHelp")}
					</p>
				</div>
			</div>

			<div className="flex max-w-3xl items-start gap-3">
				<Checkbox
					id={`${id}-sitemap`}
					checked={sitemap}
					onCheckedChange={(checked) => setSitemap(checked === true)}
					aria-describedby={`${id}-sitemap-help`}
				/>
				<div className="grid gap-1">
					<Label htmlFor={`${id}-sitemap`}>{t("seo.postType.sitemap")}</Label>
					<p id={`${id}-sitemap-help`} className="text-muted-foreground text-sm">
						{t("seo.postType.sitemapHelp")}
					</p>
				</div>
			</div>

			<div className="grid max-w-3xl gap-2">
				<Label htmlFor={`${id}-type`}>{t("seo.postType.schemaType")}</Label>
				<NativeSelect
					id={`${id}-type`}
					className="w-full sm:w-80"
					value={settings.schema.type}
					aria-describedby={`${id}-type-help`}
					onChange={(event) => chooseType(event.target.value as SchemaType)}
				>
					{SCHEMA_TYPES.map((type) => (
						<NativeSelectOption key={type} value={type}>
							{t(`seo.schemaTypes.${type}`)}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<p id={`${id}-type-help`} className="text-muted-foreground text-sm">
					{t("seo.postType.schemaTypeHelp")}
				</p>
			</div>

			<div className="grid gap-3">
				<div className="grid max-w-prose gap-1">
					<h3 className="font-medium">{t("seo.postType.properties")}</h3>
					<p className="text-muted-foreground text-sm">{t("seo.postType.propertiesHelp")}</p>
				</div>
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-sm">
						<thead className="text-muted-foreground">
							<tr className="border-b">
								<th scope="col" className="px-4 py-2 text-start font-medium">
									{t("seo.postType.property")}
								</th>
								<th scope="col" className="px-4 py-2 text-start font-medium">
									{t("seo.postType.from")}
								</th>
							</tr>
						</thead>
						<tbody>
							{SCHEMA_PROPERTIES[settings.schema.type].map((property, index) => {
								const sources = sourcesFor(postType.fields, property.kind);
								const current = settings.schema.properties[property.name] ?? "";
								return (
									<tr key={property.name} className="border-b last:border-b-0">
										<th scope="row" className="px-4 py-2 text-start font-normal">
											<code>{property.name}</code>
										</th>
										<td className="px-4 py-2">
											<NativeSelect
												id={`${id}-property-${index}`}
												className="w-full sm:w-72"
												aria-label={t("seo.postType.fromOf", { property: property.name })}
												value={sources.includes(current) ? current : ""}
												onChange={(event) => map(property.name, event.target.value)}
											>
												<NativeSelectOption value="">{t("seo.postType.notMapped")}</NativeSelectOption>
												{sources.map((source) => (
													<NativeSelectOption key={source} value={source}>
														{sourceName(source)}
														{fieldAt(postType.fields, source)?.repeater ? " …" : ""}
													</NativeSelectOption>
												))}
											</NativeSelect>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</div>
		</section>
	);
}
