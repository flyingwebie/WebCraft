import { AI_CRAWLER_SETTINGS, AI_CRAWLERS, type AiCrawlerSetting } from "@webcraft/core/ai-crawlers";
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { CircleAlertIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useRef } from "react";

import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import type { Problem } from "../content/model.ts";
import { settingProblemText } from "../content/problems.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSettingsSection } from "../settings/form.tsx";
import { SettingsCard } from "../settings/layout.tsx";
import type { SiteSeoView } from "./SiteSeoSettings.tsx";

/** Each choice of the AI crawler setting, as people read it. */
const CHOICES: Readonly<Record<AiCrawlerSetting, { label: MessageKey; help: MessageKey }>> = {
	allowAll: { label: "seo.crawlers.allowAll", help: "seo.crawlers.allowAllHelp" },
	allowSearch: { label: "seo.crawlers.allowSearch", help: "seo.crawlers.allowSearchHelp" },
	blockAll: { label: "seo.crawlers.blockAll", help: "seo.crawlers.blockAllHelp" },
};

/**
 * Site settings › Crawlers: what search engines and AI crawlers may read. The AI crawler setting (spec
 * story 119) is Staff's and Owners' (`aiCrawlers.manage`); Staff also write their own robots.txt
 * lines (`structure.edit`). Both apply at once. Links open the files crawlers read on the Site's
 * Primary domain, once it has one.
 */
export function CrawlersSettings({
	siteId,
	settings,
	origin,
	canEditLines,
}: {
	siteId: string;
	settings: SiteSeoView;
	/** The Site's Primary domain's origin, where crawlers read its files; null while it has none. */
	origin: string | null;
	canEditLines: boolean;
}) {
	const t = useT();
	const id = useId();
	const problem = useRef<HTMLParagraphElement>(null);
	const afterRender = useAfterRender();
	const training = AI_CRAWLERS.filter((crawler) => crawler.purpose === "training").map((crawler) => crawler.agent);
	const search = AI_CRAWLERS.filter((crawler) => crawler.purpose === "search").map((crawler) => crawler.agent);
	const choiceSection = useSettingsSection({
		saved: { choice: settings.aiCrawlers },
		save: async ({ choice }) => (await getApi()).seoSettings.setAiCrawlers({ siteId, aiCrawlers: choice }),
	});
	const choice = choiceSection.values.choice;
	const linesSection = useSettingsSection({
		saved: { lines: settings.robotsLines },
		save: async ({ lines }) => {
			try {
				await (await getApi()).seoSettings.update({ siteId, robotsLines: lines });
			} catch (error) {
				afterRender(() => problem.current?.focus());
				throw error;
			}
		},
	});
	const lines = linesSection.values.lines;
	const failure = linesSection.failure;
	const found = (failure as { data?: { problems?: Problem[] } } | null)?.data?.problems?.[0];
	const linesProblem = failure
		? errorCode(failure) === "SEO_SETTINGS_INVALID" && found
			? settingProblemText(t, found)
			: t(errorMessage(failure))
		: null;

	return (
		<div className="grid gap-6">
			<SettingsCard title={t("seo.crawlers.aiHeading")} description={t("seo.crawlers.aiIntro")}>
				<form {...choiceSection.formProps} className="grid gap-6">
					<FieldSet>
						<FieldLegend className="sr-only">{t("seo.crawlers.aiHeading")}</FieldLegend>
						<RadioGroup
							value={choice}
							onValueChange={(value) => choiceSection.set({ choice: value as AiCrawlerSetting })}
						>
							{AI_CRAWLER_SETTINGS.map((setting) => (
								<Field key={setting} orientation="horizontal">
									<RadioGroupItem value={setting} id={`${id}-${setting}`} aria-describedby={`${id}-${setting}-help`} />
									<FieldContent>
										<FieldLabel htmlFor={`${id}-${setting}`}>{t(CHOICES[setting].label)}</FieldLabel>
										<FieldDescription id={`${id}-${setting}-help`}>{t(CHOICES[setting].help)}</FieldDescription>
									</FieldContent>
								</Field>
							))}
						</RadioGroup>
					</FieldSet>
					<details className="text-sm">
						<summary className="cursor-pointer font-medium">{t("seo.crawlers.which")}</summary>
						<div className="text-muted-foreground mt-3 grid gap-3 sm:grid-cols-2">
							<div>
								<h3 className="text-foreground font-medium">{t("seo.crawlers.training")}</h3>
								<ul className="mt-1 font-mono text-xs">
									{training.map((agent) => (
										<li key={agent}>{agent}</li>
									))}
								</ul>
							</div>
							<div>
								<h3 className="text-foreground font-medium">{t("seo.crawlers.search")}</h3>
								<ul className="mt-1 font-mono text-xs">
									{search.map((agent) => (
										<li key={agent}>{agent}</li>
									))}
								</ul>
							</div>
						</div>
					</details>
					{choiceSection.error ? <FieldError>{t(choiceSection.error)}</FieldError> : null}
				</form>
			</SettingsCard>

			{canEditLines ? (
				<SettingsCard title={t("seo.crawlers.linesHeading")} description={t("seo.crawlers.linesIntro")}>
					<form {...linesSection.formProps} className="grid gap-3">
						<Label htmlFor={`${id}-lines`}>{t("seo.crawlers.lines")}</Label>
						<Textarea
							id={`${id}-lines`}
							value={lines}
							rows={8}
							className="font-mono"
							spellCheck={false}
							aria-invalid={linesProblem ? true : undefined}
							aria-describedby={`${id}-lines-help${linesProblem ? ` ${id}-lines-problem` : ""}`}
							onChange={(event) => linesSection.set({ lines: event.target.value })}
							placeholder={"User-agent: *\nDisallow: /private"}
						/>
						<p id={`${id}-lines-help`} className="text-muted-foreground text-sm">
							{t("seo.crawlers.linesHelp")}
						</p>
						{linesProblem ? (
							<p
								ref={problem}
								id={`${id}-lines-problem`}
								tabIndex={-1}
								role="alert"
								className="text-destructive flex items-center gap-2 text-sm outline-none"
							>
								<CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
								{linesProblem}
							</p>
						) : null}
					</form>
				</SettingsCard>
			) : null}

			<SettingsCard title={t("seo.crawlers.filesHeading")} description={t("seo.crawlers.filesIntro")}>
				{origin ? (
					<ul className="grid gap-2 text-sm">
						{["/robots.txt", "/sitemap.xml", "/llms.txt"].map((path) => (
							<li key={path}>
								<a
									href={`${origin}${path}`}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-1 font-mono underline underline-offset-4"
								>
									{path}
									<ExternalLinkIcon className="size-3.5" aria-hidden="true" />
									<span className="sr-only">{t("seo.crawlers.opensInNewTab")}</span>
								</a>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">{t("seo.crawlers.noDomain")}</p>
				)}
			</SettingsCard>
		</div>
	);
}
