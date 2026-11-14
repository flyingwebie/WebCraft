import { createFileRoute } from "@tanstack/react-router";
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { useId } from "react";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { type ConsentBannerView, ConsentBannerWords } from "../../ui/consent/ConsentBannerWords.tsx";
import { HistoryLink } from "../../ui/history/HistoryLink.tsx";
import { useLeaveOnClose } from "../../ui/history/leave.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import { SettingsCard, StateBadge } from "../../ui/settings/layout.tsx";
import { PageColumn } from "../../ui/shell/page.tsx";

/** Which language the words show in; the Site's Default language when none is given. */
const search = z.object({ language: z.string().min(2).max(35).optional().catch(undefined) });

export const Route = createFileRoute("/_admin/sites/$siteId/consent-banner")({
	staticData: { crumb: "consentBanner.pageTitle", width: "wide" },
	validateSearch: search,
	loaderDeps: ({ search: { language } }) => ({ language }),
	loader: async ({ params, deps }) => {
		const api = await getApi();
		const { banner } = await api.consentBanner.get({ siteId: params.siteId, language: deps.language });
		return { banner };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "consentBanner.pageTitle") }],
	}),
	component: ConsentBannerPage,
});

type Mode = ConsentBannerView["mode"];
type Layout = ConsentBannerView["layout"];
const MODES: readonly Mode[] = ["optIn", "optOut", "none", "outside"];
const LAYOUTS: readonly Layout[] = ["bar", "box", "dialog"];

/**
 * Site › Consent banner (ADR 0020): how the Site asks visitors which Consent categories they accept
 * (a Site setting, Staff only, applied at once) and what the banner says (Content, written per
 * language in a Draft and published, like the Globals).
 */
function ConsentBannerPage() {
	const t = useT();
	const { banner } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	// Closing the editor keeps the words' Draft as a Checkpoint when it changed.
	useLeaveOnClose(siteId, { kind: "consentBanner" });
	if (place.level !== "site") return null;
	return (
		<>
			<PageHeader
				heading={t("consentBanner.heading")}
				action={<HistoryLink siteId={siteId} item={{ kind: "consentBanner" }} />}
			>
				{t("consentBanner.intro")}
			</PageHeader>
			<div className="grid gap-10">
				<SettingsForm>
					<PageColumn width="form">
						<BannerSettings siteId={siteId} banner={banner} canChange={place.permissions.includes("structure.edit")} />
					</PageColumn>
				</SettingsForm>
				<ConsentBannerWords
					key={banner.text.language}
					siteId={siteId}
					banner={banner}
					permissions={place.permissions}
					languages={place.languages}
				/>
			</div>
		</>
	);
}

/** How visitors are asked: the mode and the layout. Staff change it; everyone else reads it. */
function BannerSettings({
	siteId,
	banner,
	canChange,
}: {
	siteId: string;
	banner: ConsentBannerView;
	canChange: boolean;
}) {
	const t = useT();
	return (
		<SettingsCard
			title={t("consentBanner.settingsTitle")}
			description={t("consentBanner.settingsIntro")}
			action={<StateBadge>{t("consentBanner.version", { version: banner.version })}</StateBadge>}
		>
			{canChange ? (
				<BannerSettingsForm siteId={siteId} banner={banner} />
			) : (
				<p>
					{t("consentBanner.current", {
						mode: t(`consentBanner.modes.${banner.mode}`),
						layout: t(`consentBanner.layouts.${banner.layout}`),
					})}
				</p>
			)}
		</SettingsCard>
	);
}

/** Staff choose the mode and the layout; saved with the foot bar. */
function BannerSettingsForm({ siteId, banner }: { siteId: string; banner: ConsentBannerView }) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: { mode: banner.mode, layout: banner.layout },
		save: async ({ mode, layout }) => (await getApi()).consentBanner.setSettings({ siteId, mode, layout }),
	});
	const { mode, layout } = section.values;
	return (
		<form {...section.formProps} className="grid gap-6">
			<FieldSet>
				<FieldLegend variant="label">{t("consentBanner.mode")}</FieldLegend>
				<RadioGroup value={mode} onValueChange={(value) => section.set({ mode: value as Mode })}>
					{MODES.map((candidate) => (
						<Field key={candidate} orientation="horizontal">
							<RadioGroupItem
								value={candidate}
								id={`${id}-mode-${candidate}`}
								aria-describedby={`${id}-mode-${candidate}-help`}
							/>
							<FieldContent>
								<FieldLabel htmlFor={`${id}-mode-${candidate}`}>{t(`consentBanner.modes.${candidate}`)}</FieldLabel>
								<FieldDescription id={`${id}-mode-${candidate}-help`}>
									{t(`consentBanner.modeHelp.${candidate}`)}
								</FieldDescription>
							</FieldContent>
						</Field>
					))}
				</RadioGroup>
			</FieldSet>
			<FieldSet>
				<FieldLegend variant="label">{t("consentBanner.layout")}</FieldLegend>
				<RadioGroup value={layout} onValueChange={(value) => section.set({ layout: value as Layout })}>
					{LAYOUTS.map((candidate) => (
						<Field key={candidate} orientation="horizontal">
							<RadioGroupItem
								value={candidate}
								id={`${id}-layout-${candidate}`}
								aria-describedby={`${id}-layout-${candidate}-help`}
							/>
							<FieldContent>
								<FieldLabel htmlFor={`${id}-layout-${candidate}`}>{t(`consentBanner.layouts.${candidate}`)}</FieldLabel>
								<FieldDescription id={`${id}-layout-${candidate}-help`}>
									{t(`consentBanner.layoutHelp.${candidate}`)}
								</FieldDescription>
							</FieldContent>
						</Field>
					))}
				</RadioGroup>
			</FieldSet>
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</form>
	);
}
