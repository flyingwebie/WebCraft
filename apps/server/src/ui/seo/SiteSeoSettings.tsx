import type { ApiClient } from "@webcraft/api";
import { SOCIAL_CARD_LAYOUTS, type SocialCardLayout } from "@webcraft/core/social-card-rules";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { CircleAlertIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useAfterRender } from "../after-render.ts";

import { getApi } from "../api.ts";
import type { FieldDefinition, Problem } from "../content/model.ts";
import { settingProblemText } from "../content/problems.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { MediaPicker } from "../media/MediaPicker.tsx";
import type { MediaItem } from "../media/preview.ts";
import { useSettingsSection } from "../settings/form.tsx";
import { SettingsCard, SettingsRow, SettingsRows, Switch } from "../settings/layout.tsx";

/** A Site's SEO settings, as the Management API answers them. */
export type SiteSeoView = Awaited<ReturnType<ApiClient["seoSettings"]["get"]>>["settings"];

const KINDS = ["organization", "localBusiness"] as const;
const FROM_GLOBALS = ["telephone", "email", "address"] as const;

/** The Globals an organisation's details can come from: text, rich text and email Globals, by path. */
function globalChoices(
	fields: readonly FieldDefinition[],
	prefix = "",
	names: string[] = [],
): { path: string; name: string }[] {
	return fields.flatMap((field) => {
		const path = `${prefix}${field.key}`;
		const name = [...names, field.label || field.key];
		if (field.type === "group") return globalChoices(field.fields, `${path}.`, name);
		return ["text", "richText", "email"].includes(field.type) ? [{ path, name: name.join(" › ") }] : [];
	});
}

/**
 * Site › SEO (a Site setting, Structure: Staff only, applied at once and logged): the Site's name in
 * titles, the separator title patterns use, the social image of pages without one, and the
 * organisation every page's structured data names, with its details from the Globals.
 */
export function SiteSeoSettings({
	siteId,
	siteName,
	settings,
	globals,
	media: known,
}: {
	siteId: string;
	siteName: string;
	settings: SiteSeoView;
	globals: readonly FieldDefinition[];
	media: Readonly<Record<string, MediaItem>>;
}) {
	const t = useT();
	const id = useId();
	const [media, setMedia] = useState(known);
	const summary = useRef<HTMLDivElement>(null);
	const afterRender = useAfterRender();
	const choices = globalChoices(globals);
	const chosen = (item: MediaItem) => setMedia((before) => ({ ...before, [item.id]: item }));
	const section = useSettingsSection({
		saved: {
			name: settings.siteName ?? "",
			separator: settings.separator,
			socialCards: settings.socialCards,
			defaultImage: settings.defaultImage,
			organization: settings.organization,
			profiles: settings.organization.sameAs.join("\n"),
		},
		save: async ({ name, separator, socialCards, defaultImage, organization, profiles }) => {
			try {
				await (
					await getApi()
				).seoSettings.update({
					siteId,
					siteName: name.trim() || null,
					separator,
					defaultImage,
					socialCards,
					organization: {
						...organization,
						sameAs: profiles
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean),
					},
				});
			} catch (error) {
				afterRender(() => summary.current?.focus());
				throw error;
			}
		},
	});
	const { name, separator, socialCards, defaultImage, organization, profiles } = section.values;
	const set = section.set;
	const setOrganization = (patch: Partial<typeof organization>) => set({ organization: { ...organization, ...patch } });
	const failure = section.failure;
	const problems = failure
		? errorCode(failure) === "SEO_SETTINGS_INVALID" && (failure as { data?: { problems?: Problem[] } }).data?.problems
			? (failure as { data: { problems: Problem[] } }).data.problems.map((problem) => settingProblemText(t, problem))
			: [t(errorMessage(failure))]
		: null;

	return (
		<form {...section.formProps} className="grid gap-6">
			{problems ? (
				<div
					ref={summary}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 text-destructive grid gap-2 rounded-lg border p-4 text-sm outline-none"
				>
					<p className="flex items-center gap-2 font-medium">
						<CircleAlertIcon className="size-4" aria-hidden="true" />
						{t("seo.site.notSaved")}
					</p>
					<ul className="grid list-disc gap-1 ps-6">
						{problems.map((problem) => (
							<li key={problem}>{problem}</li>
						))}
					</ul>
				</div>
			) : null}

			<SettingsCard title={t("seo.site.titlesCard")} description={t("seo.site.titlesCardIntro")}>
				<div className="grid gap-6 @2xl/page:grid-cols-[minmax(0,1fr)_10rem]">
					<div className="grid content-start gap-2">
						<Label htmlFor={`${id}-name`}>{t("seo.site.siteName")}</Label>
						<Input
							id={`${id}-name`}
							value={name}
							placeholder={siteName}
							autoComplete="off"
							aria-describedby={`${id}-name-help`}
							onChange={(event) => set({ name: event.target.value })}
						/>
						<p id={`${id}-name-help`} className="text-muted-foreground text-sm">
							{t("seo.site.siteNameHelp", { name: siteName })}
						</p>
					</div>
					<div className="grid content-start gap-2">
						<Label htmlFor={`${id}-separator`}>{t("seo.site.separator")}</Label>
						<Input
							id={`${id}-separator`}
							value={separator}
							maxLength={3}
							autoComplete="off"
							aria-describedby={`${id}-separator-help`}
							onChange={(event) => set({ separator: event.target.value })}
						/>
						<p id={`${id}-separator-help`} className="text-muted-foreground text-sm">
							{t("seo.site.separatorHelp")}
						</p>
					</div>
				</div>

				<div className="grid gap-2">
					<span id={`${id}-image-label`} className="text-sm leading-none font-medium">
						{t("seo.site.defaultImage")}
					</span>
					<MediaPicker
						siteId={siteId}
						id={`${id}-image`}
						labelledBy={`${id}-image-label`}
						describedBy={`${id}-image-help`}
						value={defaultImage}
						item={defaultImage ? (media[defaultImage] ?? null) : null}
						onChange={(next) => {
							if (next) chosen(next.item);
							set({ defaultImage: next ? next.id : null });
						}}
					/>
					<p id={`${id}-image-help`} className="text-muted-foreground text-sm">
						{t("seo.site.defaultImageHelp")}
					</p>
				</div>
			</SettingsCard>

			<SettingsCard title={t("seo.socialCards.title")} description={t("seo.socialCards.help")}>
				<SettingsRows>
					<SettingsRow label={t("seo.socialCards.enabled")} htmlFor={`${id}-social-enabled`}>
						<Switch
							id={`${id}-social-enabled`}
							checked={socialCards.enabled}
							onCheckedChange={(checked) => set({ socialCards: { ...socialCards, enabled: checked } })}
						/>
					</SettingsRow>
					<SettingsRow label={t("seo.socialCards.layout")} htmlFor={`${id}-social-layout`}>
						<NativeSelect
							id={`${id}-social-layout`}
							value={socialCards.layout}
							onChange={(event) =>
								set({ socialCards: { ...socialCards, layout: event.target.value as SocialCardLayout } })
							}
						>
							{SOCIAL_CARD_LAYOUTS.map((layout) => (
								<NativeSelectOption key={layout} value={layout}>
									{t(`seo.socialCards.layouts.${layout}`)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</SettingsRow>
				</SettingsRows>
			</SettingsCard>
			<SettingsCard title={t("seo.site.organization")} description={t("seo.site.organizationHelp")}>
				<div className="grid gap-6 @2xl/page:grid-cols-2">
					<div className="grid content-start gap-2">
						<Label htmlFor={`${id}-kind`}>{t("seo.site.kind")}</Label>
						<NativeSelect
							id={`${id}-kind`}
							className="w-full"
							value={organization.kind}
							onChange={(event) => setOrganization({ kind: event.target.value as (typeof KINDS)[number] })}
						>
							{KINDS.map((kind) => (
								<NativeSelectOption key={kind} value={kind}>
									{t(`seo.site.kinds.${kind}`)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div className="grid content-start gap-2">
						<Label htmlFor={`${id}-organization-name`}>{t("seo.site.organizationName")}</Label>
						<Input
							id={`${id}-organization-name`}
							value={organization.name ?? ""}
							placeholder={name.trim() || siteName}
							autoComplete="organization"
							aria-describedby={`${id}-organization-name-help`}
							onChange={(event) => setOrganization({ name: event.target.value || null })}
						/>
						<p id={`${id}-organization-name-help`} className="text-muted-foreground text-sm">
							{t("seo.site.organizationNameHelp")}
						</p>
					</div>
				</div>
				<div className="grid gap-2">
					<span id={`${id}-logo-label`} className="text-sm leading-none font-medium">
						{t("seo.site.logo")}
					</span>
					<MediaPicker
						siteId={siteId}
						id={`${id}-logo`}
						labelledBy={`${id}-logo-label`}
						value={organization.logo}
						item={organization.logo ? (media[organization.logo] ?? null) : null}
						onChange={(next) => {
							if (next) chosen(next.item);
							setOrganization({ logo: next ? next.id : null });
						}}
					/>
				</div>
				<div className="grid gap-2">
					<Label htmlFor={`${id}-same-as`}>{t("seo.site.sameAs")}</Label>
					<Textarea
						id={`${id}-same-as`}
						value={profiles}
						rows={3}
						spellCheck={false}
						className="font-mono"
						aria-describedby={`${id}-same-as-help`}
						onChange={(event) => set({ profiles: event.target.value })}
					/>
					<p id={`${id}-same-as-help`} className="text-muted-foreground text-sm">
						{t("seo.site.sameAsHelp")}
					</p>
				</div>
				<fieldset className="grid gap-4" aria-describedby={`${id}-globals-help`}>
					<legend className="sr-only">{t("seo.site.globalsHelp")}</legend>
					<p id={`${id}-globals-help`} className="text-muted-foreground text-sm">
						{t("seo.site.globalsHelp")}
					</p>
					<div className="grid gap-4 @2xl/page:grid-cols-3">
						{FROM_GLOBALS.map((key) => (
							<div key={key} className="grid content-start gap-2">
								<Label htmlFor={`${id}-${key}`}>{t(`seo.site.${key}`)}</Label>
								<NativeSelect
									id={`${id}-${key}`}
									className="w-full"
									value={organization[key] ?? ""}
									onChange={(event) => setOrganization({ [key]: event.target.value || null })}
								>
									<NativeSelectOption value="">{t("seo.site.noGlobal")}</NativeSelectOption>
									{choices.map((choice) => (
										<NativeSelectOption key={choice.path} value={choice.path}>
											{choice.name}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</div>
						))}
					</div>
				</fieldset>
			</SettingsCard>
		</form>
	);
}
