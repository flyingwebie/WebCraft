import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { SOCIAL_CARD_LAYOUTS, type SocialCardLayout } from "@webcraft/core/social-card-rules";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { CircleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useAfterRender } from "../after-render.ts";

import { getApi } from "../api.ts";
import type { FieldDefinition, Problem } from "../content/model.ts";
import { settingProblemText } from "../content/problems.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { MediaPicker } from "../media/MediaPicker.tsx";
import type { MediaItem } from "../media/preview.ts";

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
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(settings.siteName ?? "");
	const [separator, setSeparator] = useState(settings.separator);
	const [socialCards, setSocialCards] = useState(settings.socialCards);
	const [defaultImage, setDefaultImage] = useState(settings.defaultImage);
	const [organization, setOrganization] = useState(settings.organization);
	const [profiles, setProfiles] = useState(settings.organization.sameAs.join("\n"));
	const [media, setMedia] = useState(known);
	const [problems, setProblems] = useState<string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const summary = useRef<HTMLDivElement>(null);
	const afterRender = useAfterRender();
	const choices = globalChoices(globals);
	const chosen = (item: MediaItem) => setMedia((before) => ({ ...before, [item.id]: item }));

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblems(null);
		try {
			const api = await getApi();
			await api.seoSettings.update({
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
			toast.success(t("seo.site.saved"));
			await router.invalidate();
		} catch (error) {
			const data = (error as { data?: { problems?: Problem[] } }).data;
			setProblems(
				errorCode(error) === "SEO_SETTINGS_INVALID" && data?.problems
					? data.problems.map((problem) => settingProblemText(t, problem))
					: [t(errorMessage(error))],
			);
			afterRender(() => summary.current?.focus());
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={save} className="grid max-w-3xl gap-8">
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

			<div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_10rem]">
				<div className="grid content-start gap-2">
					<Label htmlFor={`${id}-name`}>{t("seo.site.siteName")}</Label>
					<Input
						id={`${id}-name`}
						value={name}
						placeholder={siteName}
						autoComplete="off"
						aria-describedby={`${id}-name-help`}
						onChange={(event) => setName(event.target.value)}
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
						onChange={(event) => setSeparator(event.target.value)}
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
						setDefaultImage(next ? next.id : null);
					}}
				/>
				<p id={`${id}-image-help`} className="text-muted-foreground text-sm">
					{t("seo.site.defaultImageHelp")}
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("seo.socialCards.title")}</h2>
					</CardTitle>
					<CardDescription>{t("seo.socialCards.help")}</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-5">
					<div className="flex items-center gap-3">
						<Checkbox
							id={`${id}-social-enabled`}
							checked={socialCards.enabled}
							onCheckedChange={(checked) => setSocialCards({ ...socialCards, enabled: checked === true })}
						/>
						<Label htmlFor={`${id}-social-enabled`}>{t("seo.socialCards.enabled")}</Label>
					</div>
					<div className="grid gap-2">
						<Label htmlFor={`${id}-social-layout`}>{t("seo.socialCards.layout")}</Label>
						<NativeSelect
							id={`${id}-social-layout`}
							value={socialCards.layout}
							onChange={(event) => setSocialCards({ ...socialCards, layout: event.target.value as SocialCardLayout })}
						>
							{SOCIAL_CARD_LAYOUTS.map((layout) => (
								<NativeSelectOption key={layout} value={layout}>
									{t(`seo.socialCards.layouts.${layout}`)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("seo.site.organization")}</h2>
					</CardTitle>
					<CardDescription>{t("seo.site.organizationHelp")}</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-6">
					<div className="grid gap-6 sm:grid-cols-2">
						<div className="grid content-start gap-2">
							<Label htmlFor={`${id}-kind`}>{t("seo.site.kind")}</Label>
							<NativeSelect
								id={`${id}-kind`}
								className="w-full"
								value={organization.kind}
								onChange={(event) =>
									setOrganization((before) => ({ ...before, kind: event.target.value as (typeof KINDS)[number] }))
								}
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
								onChange={(event) => setOrganization((before) => ({ ...before, name: event.target.value || null }))}
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
								setOrganization((before) => ({ ...before, logo: next ? next.id : null }));
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
							onChange={(event) => setProfiles(event.target.value)}
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
						<div className="grid gap-4 sm:grid-cols-3">
							{FROM_GLOBALS.map((key) => (
								<div key={key} className="grid content-start gap-2">
									<Label htmlFor={`${id}-${key}`}>{t(`seo.site.${key}`)}</Label>
									<NativeSelect
										id={`${id}-${key}`}
										className="w-full"
										value={organization[key] ?? ""}
										onChange={(event) =>
											setOrganization((before) => ({ ...before, [key]: event.target.value || null }))
										}
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
				</CardContent>
			</Card>

			<div>
				<Button type="submit" disabled={busy}>
					{t("seo.site.save")}
				</Button>
			</div>
		</form>
	);
}
