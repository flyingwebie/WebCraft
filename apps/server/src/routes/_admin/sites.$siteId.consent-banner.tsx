import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { type ConsentBannerView, ConsentBannerWords } from "../../ui/consent/ConsentBannerWords.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { HistoryLink } from "../../ui/history/HistoryLink.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";

/** Which language the words show in; the Site's Default language when none is given. */
const search = z.object({ language: z.string().min(2).max(35).optional().catch(undefined) });

export const Route = createFileRoute("/_admin/sites/$siteId/consent-banner")({
	staticData: { crumb: "consentBanner.pageTitle", wide: true },
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
				<BannerSettings
					key={`${banner.mode}-${banner.layout}`}
					siteId={siteId}
					banner={banner}
					canChange={place.permissions.includes("structure.edit")}
				/>
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
	const router = useRouter();
	const id = useId();
	const [mode, setMode] = useState<Mode>(banner.mode);
	const [layout, setLayout] = useState<Layout>(banner.layout);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await getApi();
			await api.consentBanner.setSettings({ siteId, mode, layout });
			toast.success(t("consentBanner.saved"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card className="max-w-4xl">
			<CardHeader>
				<CardTitle>
					<h2>{t("consentBanner.settingsTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("consentBanner.settingsIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				{canChange ? (
					<form onSubmit={save} className="grid gap-6">
						<FieldSet>
							<FieldLegend variant="label">{t("consentBanner.mode")}</FieldLegend>
							<RadioGroup value={mode} onValueChange={(value) => setMode(value as Mode)}>
								{MODES.map((candidate) => (
									<Field key={candidate} orientation="horizontal">
										<RadioGroupItem
											value={candidate}
											id={`${id}-mode-${candidate}`}
											aria-describedby={`${id}-mode-${candidate}-help`}
										/>
										<FieldContent>
											<FieldLabel htmlFor={`${id}-mode-${candidate}`}>
												{t(`consentBanner.modes.${candidate}`)}
											</FieldLabel>
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
							<RadioGroup value={layout} onValueChange={(value) => setLayout(value as Layout)}>
								{LAYOUTS.map((candidate) => (
									<Field key={candidate} orientation="horizontal">
										<RadioGroupItem
											value={candidate}
											id={`${id}-layout-${candidate}`}
											aria-describedby={`${id}-layout-${candidate}-help`}
										/>
										<FieldContent>
											<FieldLabel htmlFor={`${id}-layout-${candidate}`}>
												{t(`consentBanner.layouts.${candidate}`)}
											</FieldLabel>
											<FieldDescription id={`${id}-layout-${candidate}-help`}>
												{t(`consentBanner.layoutHelp.${candidate}`)}
											</FieldDescription>
										</FieldContent>
									</Field>
								))}
							</RadioGroup>
						</FieldSet>
						<div className="flex flex-wrap items-center gap-3">
							<Button
								type="submit"
								variant="outline"
								disabled={busy || (mode === banner.mode && layout === banner.layout)}
							>
								{t("consentBanner.save")}
							</Button>
							<Badge variant="secondary">{t("consentBanner.version", { version: banner.version })}</Badge>
						</div>
					</form>
				) : (
					<div className="flex flex-wrap items-center gap-3">
						<p>
							{t("consentBanner.current", {
								mode: t(`consentBanner.modes.${banner.mode}`),
								layout: t(`consentBanner.layouts.${banner.layout}`),
							})}
						</p>
						<Badge variant="secondary">{t("consentBanner.version", { version: banner.version })}</Badge>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
