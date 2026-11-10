import { useRouter } from "@tanstack/react-router";
import { AI_CRAWLER_SETTINGS, AI_CRAWLERS, type AiCrawlerSetting } from "@webcraft/core/ai-crawlers";
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
import { Label } from "@webcraft/ui/components/label.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { CircleAlertIcon, ExternalLinkIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import type { Problem } from "../content/model.ts";
import { settingProblemText } from "../content/problems.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
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
	const router = useRouter();
	const id = useId();
	// What is saved now: the buttons stay off until something differs, without waiting for a reload.
	const [savedChoice, setSavedChoice] = useState<AiCrawlerSetting>(settings.aiCrawlers);
	const [choice, setChoice] = useState<AiCrawlerSetting>(settings.aiCrawlers);
	const [busy, setBusy] = useState(false);
	const [savedLines, setSavedLines] = useState(settings.robotsLines);
	const [lines, setLines] = useState(settings.robotsLines);
	const [linesProblem, setLinesProblem] = useState<string | null>(null);
	const [savingLines, setSavingLines] = useState(false);
	const problem = useRef<HTMLParagraphElement>(null);
	const afterRender = useAfterRender();
	const training = AI_CRAWLERS.filter((crawler) => crawler.purpose === "training").map((crawler) => crawler.agent);
	const search = AI_CRAWLERS.filter((crawler) => crawler.purpose === "search").map((crawler) => crawler.agent);

	const saveChoice = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await getApi();
			const { settings: saved } = await api.seoSettings.setAiCrawlers({ siteId, aiCrawlers: choice });
			setSavedChoice(saved.aiCrawlers);
			toast.success(t("seo.crawlers.saved"));
			await router.invalidate();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};

	const saveLines = async (event: FormEvent) => {
		event.preventDefault();
		setSavingLines(true);
		setLinesProblem(null);
		try {
			const api = await getApi();
			const { settings: saved } = await api.seoSettings.update({ siteId, robotsLines: lines });
			setLines(saved.robotsLines);
			setSavedLines(saved.robotsLines);
			toast.success(t("seo.crawlers.linesSaved"));
			await router.invalidate();
		} catch (error) {
			const found = (error as { data?: { problems?: Problem[] } }).data?.problems?.[0];
			setLinesProblem(
				errorCode(error) === "SEO_SETTINGS_INVALID" && found ? settingProblemText(t, found) : t(errorMessage(error)),
			);
			afterRender(() => problem.current?.focus());
		} finally {
			setSavingLines(false);
		}
	};

	return (
		<div className="grid max-w-3xl gap-8">
			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("seo.crawlers.aiHeading")}</h2>
					</CardTitle>
					<CardDescription>{t("seo.crawlers.aiIntro")}</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={saveChoice} className="grid gap-6">
						<FieldSet>
							<FieldLegend className="sr-only">{t("seo.crawlers.aiHeading")}</FieldLegend>
							<RadioGroup value={choice} onValueChange={(value) => setChoice(value as AiCrawlerSetting)}>
								{AI_CRAWLER_SETTINGS.map((setting) => (
									<Field key={setting} orientation="horizontal">
										<RadioGroupItem
											value={setting}
											id={`${id}-${setting}`}
											aria-describedby={`${id}-${setting}-help`}
										/>
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
						<div>
							<Button type="submit" disabled={busy || choice === savedChoice}>
								{t("seo.crawlers.save")}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>

			{canEditLines ? (
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("seo.crawlers.linesHeading")}</h2>
						</CardTitle>
						<CardDescription>{t("seo.crawlers.linesIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						<form onSubmit={saveLines} className="grid gap-3">
							<Label htmlFor={`${id}-lines`}>{t("seo.crawlers.lines")}</Label>
							<Textarea
								id={`${id}-lines`}
								value={lines}
								rows={8}
								className="font-mono"
								spellCheck={false}
								aria-invalid={linesProblem ? true : undefined}
								aria-describedby={`${id}-lines-help${linesProblem ? ` ${id}-lines-problem` : ""}`}
								onChange={(event) => setLines(event.target.value)}
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
							<div>
								<Button type="submit" disabled={savingLines || lines === savedLines}>
									{t("seo.crawlers.saveLines")}
								</Button>
							</div>
						</form>
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("seo.crawlers.filesHeading")}</h2>
					</CardTitle>
					<CardDescription>{t("seo.crawlers.filesIntro")}</CardDescription>
				</CardHeader>
				<CardContent>
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
				</CardContent>
			</Card>
		</div>
	);
}
