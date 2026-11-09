import { fieldAt, SCHEMA_TYPES, SEO_CHECK_LIMITS, SEO_CHECKS, type SeoCheckKind } from "@webcraft/core/seo-rules";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { CircleAlertIcon, CodeXmlIcon, TriangleAlertIcon } from "lucide-react";
import { type EntryView, type PostTypeView, type Problem, problemsAt } from "../content/model.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { MediaPicker } from "../media/MediaPicker.tsx";
import type { MediaItem } from "../media/preview.ts";

/** An Entry's SEO fields as the editor holds them while they are typed. */
export type SeoValues = EntryView["draft"]["seo"];

/**
 * The SEO & sharing card of the Entry editor: the Entry's SEO fields (SEO title, description,
 * canonical URL and social image in the language being written; noindex for every language), each
 * empty one showing what it falls back to (the Draft's preview, from the server), and the SEO check's
 * warnings, which never stop a publish. Authors write them too: they are Content.
 */
export function EntrySeoCard({
	siteId,
	postType,
	entry,
	values,
	problems,
	media,
	onMediaChosen,
	onChange,
}: {
	siteId: string;
	postType: PostTypeView;
	entry: EntryView;
	values: SeoValues;
	problems: readonly Problem[];
	media: Readonly<Record<string, MediaItem>>;
	onMediaChosen(item: MediaItem): void;
	onChange(change: Partial<SeoValues>): void;
}) {
	const t = useT();
	const preview = entry.seoPreview;
	const checks = entry.checks.filter((check) => (SEO_CHECKS as readonly string[]).includes(check.check));
	const titleLength = [...(values.title?.trim() || preview.title)].length;
	const descriptionLength = [...(values.description?.trim() || preview.description || "")].length;
	const imageField = postType.seo.imageField ? fieldAt(postType.fields, postType.seo.imageField) : undefined;
	const fallbackImage =
		preview.image && preview.image.from !== "entry"
			? preview.image.from === "field"
				? t("seo.card.imageFromField", { field: imageField?.field.label ?? postType.seo.imageField ?? "" })
				: t("seo.card.imageFromSite")
			: imageField
				? t("seo.card.imageFromField", { field: imageField.field.label })
				: t("seo.card.imageNone");
	const type = postType.seo.schema.type;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2 id="entry-seo-heading">{t("seo.card.heading")}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-5">
				<SeoText
					id="entry-seo-title"
					label={t("seo.card.title")}
					help={t("seo.card.titleHelp")}
					count={t("seo.card.count", { count: titleLength, max: SEO_CHECK_LIMITS.titleMax })}
					value={values.title ?? ""}
					placeholder={preview.title}
					lang={entry.language}
					problems={problemsAt(problems, "seo.title")}
					onChange={(title) => onChange({ title })}
				/>
				<SeoText
					id="entry-seo-description"
					label={t("seo.card.description")}
					help={t("seo.card.descriptionHelp")}
					count={t("seo.card.count", { count: descriptionLength, max: SEO_CHECK_LIMITS.descriptionMax })}
					value={values.description ?? ""}
					placeholder={preview.description ?? ""}
					lang={entry.language}
					multiline
					problems={problemsAt(problems, "seo.description")}
					onChange={(description) => onChange({ description })}
				/>
				<div className="grid gap-2">
					<span id="entry-seo-image-label" className="text-sm leading-none font-medium">
						{t("seo.card.image")}
					</span>
					<MediaPicker
						siteId={siteId}
						id="entry-seo-image"
						labelledBy="entry-seo-image-label"
						describedBy="entry-seo-image-help"
						invalid={problemsAt(problems, "seo.image").length > 0}
						value={values.image}
						item={values.image ? (media[values.image] ?? null) : null}
						onChange={(next) => {
							if (next) onMediaChosen(next.item);
							onChange({ image: next ? next.id : null });
						}}
					/>
					<p id="entry-seo-image-help" className="text-muted-foreground text-sm">
						{fallbackImage}
					</p>
					<Problems problems={problemsAt(problems, "seo.image")} refused="seo.card.imageRefused" />
				</div>
				<SeoText
					id="entry-seo-canonical"
					label={t("seo.card.canonical")}
					help={t("seo.card.canonicalHelp")}
					value={values.canonical ?? ""}
					placeholder={entry.path ?? ""}
					monospace
					problems={problemsAt(problems, "seo.canonical")}
					refused="seo.card.canonicalRefused"
					onChange={(canonical) => onChange({ canonical })}
				/>
				<div className="flex items-start gap-2">
					<Checkbox
						id="entry-seo-noindex"
						checked={values.noindex}
						onCheckedChange={(value) => onChange({ noindex: value === true })}
						aria-describedby="entry-seo-noindex-help"
						className="mt-0.5"
					/>
					<div className="grid gap-0.5">
						<Label htmlFor="entry-seo-noindex">{t("seo.card.noindex")}</Label>
						<p id="entry-seo-noindex-help" className="text-muted-foreground text-sm">
							{t("seo.card.noindexHelp")}
						</p>
					</div>
				</div>
				{checks.length > 0 ? (
					<section aria-labelledby="entry-seo-checks-heading" className="grid gap-2 border-t pt-4">
						<h3 id="entry-seo-checks-heading" className="text-sm font-medium">
							{t("seo.card.checks")}
						</h3>
						<p className="text-muted-foreground text-xs">{t("seo.card.checksHelp")}</p>
						<ul className="grid gap-1.5 text-sm">
							{checks.map((check) => (
								<li key={`${check.at}:${check.check}`} className="flex items-start gap-1.5">
									<TriangleAlertIcon
										className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
										aria-hidden="true"
									/>
									<span>{t(`seo.checks.${check.check as SeoCheckKind}`, check.params ?? {})}</span>
								</li>
							))}
						</ul>
					</section>
				) : null}
				{(SCHEMA_TYPES as readonly string[]).includes(type) ? (
					<p className="text-muted-foreground flex items-start gap-1.5 border-t pt-4 text-sm">
						<CodeXmlIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<span>{t("seo.card.structuredData", { type: t(`seo.schemaTypes.${type}`) })}</span>
					</p>
				) : null}
			</CardContent>
		</Card>
	);
}

/** One text SEO field: its label, control, help, count of characters and the problems saving it met. */
function SeoText({
	id,
	label,
	help,
	count,
	value,
	placeholder,
	lang,
	multiline,
	monospace,
	problems,
	refused,
	onChange,
}: {
	id: string;
	label: string;
	help: string;
	count?: string;
	value: string;
	placeholder: string;
	lang?: string;
	multiline?: boolean;
	monospace?: boolean;
	problems: readonly Problem[];
	refused?: MessageKey;
	onChange(value: string): void;
}) {
	const described = [`${id}-help`, count ? `${id}-count` : null, problems.length > 0 ? `${id}-problems` : null]
		.filter(Boolean)
		.join(" ");
	const common = {
		id,
		value,
		placeholder,
		lang,
		autoComplete: "off",
		"aria-describedby": described,
		"aria-invalid": problems.length > 0 ? true : undefined,
		className: monospace ? "font-mono" : undefined,
	};
	return (
		<div className="grid gap-2">
			<Label htmlFor={id}>{label}</Label>
			{multiline ? (
				<Textarea {...common} rows={3} onChange={(event) => onChange(event.target.value)} />
			) : (
				<Input
					{...common}
					spellCheck={monospace ? false : undefined}
					onChange={(event) => onChange(event.target.value)}
				/>
			)}
			{count ? (
				<p id={`${id}-count`} className="text-muted-foreground text-xs">
					{count}
				</p>
			) : null}
			<p id={`${id}-help`} className="text-muted-foreground text-sm">
				{help}
			</p>
			<div id={`${id}-problems`}>
				<Problems problems={problems} refused={refused} />
			</div>
		</div>
	);
}

/** What saving a value met, in the person's language where WebCraft knows the refusal. */
function Problems({ problems, refused }: { problems: readonly Problem[]; refused?: MessageKey }) {
	const t = useT();
	if (problems.length === 0) return null;
	return (
		<ul className="text-destructive grid gap-1 text-sm">
			{problems.map((problem) => (
				<li key={`${problem.at}:${problem.message}`} className="flex items-start gap-1.5">
					<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<span>{refused ? t(refused) : problem.message}</span>
				</li>
			))}
		</ul>
	);
}
