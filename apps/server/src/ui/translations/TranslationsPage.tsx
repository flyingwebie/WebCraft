import { Link, useRouter } from "@tanstack/react-router";
import type { LanguageTranslations, QueueLine, TranslationMode, TranslationsOverview } from "@webcraft/core";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@webcraft/ui/components/card.tsx";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import {
	CheckCheckIcon,
	CheckIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	LanguagesIcon,
	PencilIcon,
	RefreshCwIcon,
	SettingsIcon,
	SparklesIcon,
	UserIcon,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";

/** The words for each Translation mode, and what it does. */
export const MODE_WORDS: Record<TranslationMode, { label: MessageKey; help: MessageKey }> = {
	automatic: { label: "translations.modes.automatic", help: "translations.modes.automaticHelp" },
	review: { label: "translations.modes.review", help: "translations.modes.reviewHelp" },
	manual: { label: "translations.modes.manual", help: "translations.modes.manualHelp" },
};

const MODES: readonly TranslationMode[] = ["automatic", "review", "manual"];

/** Why work waits, in words. */
export const WAITING_WORDS: Record<string, MessageKey> = {
	noKey: "translations.waiting.noKey",
	cap: "translations.waiting.cap",
	unavailable: "translations.waiting.unavailable",
	refused: "translations.waiting.refused",
	answer: "translations.waiting.answer",
	access: "translations.waiting.access",
	error: "translations.waiting.error",
};

/** A language's Translation mode: radio buttons for people who may change it, its name for everyone else. */
export function ModeChoice({
	siteId,
	language,
	canManage,
	label,
}: {
	siteId: string;
	language: Pick<LanguageTranslations, "code" | "name" | "mode">;
	canManage: boolean;
	label: string;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [mode, setMode] = useState(language.mode);
	if (!canManage) return <p className="text-sm font-medium">{t(MODE_WORDS[language.mode].label)}</p>;
	const choose = async (next: TranslationMode) => {
		const before = mode;
		setMode(next);
		try {
			await (await getApi()).translations.setMode({ siteId, language: language.code, mode: next });
			toast.success(t("translations.modeSaved", { language: language.name, mode: t(MODE_WORDS[next].label) }));
			await router.invalidate();
		} catch (failure) {
			setMode(before);
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<FieldSet>
			<FieldLegend variant="label" className="sr-only">
				{label}
			</FieldLegend>
			<RadioGroup
				value={mode}
				onValueChange={(value) => void choose(value as TranslationMode)}
				className="flex flex-wrap gap-x-5 gap-y-2"
			>
				{MODES.map((option) => (
					<Field key={option} orientation="horizontal" className="w-auto">
						<RadioGroupItem value={option} id={`${id}-${option}`} />
						<FieldLabel htmlFor={`${id}-${option}`}>{t(MODE_WORDS[option].label)}</FieldLabel>
					</Field>
				))}
			</RadioGroup>
		</FieldSet>
	);
}

/** A share as a bar people can read: `<progress>` with its label. */
export function Share({
	value,
	label,
	tone = "primary",
}: {
	value: number;
	label: string;
	tone?: "primary" | "warning";
}) {
	return (
		<progress
			value={Math.min(value, 100)}
			max={100}
			aria-label={label}
			className={`[&::-webkit-progress-bar]:bg-muted h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:rounded-full [&::-webkit-progress-value]:rounded-full ${
				tone === "warning"
					? "[&::-moz-progress-bar]:bg-amber-600 [&::-webkit-progress-value]:bg-amber-600"
					: "[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary"
			} bg-muted`}
		/>
	);
}

/** A notice about the Workspace's AI key: none set, its cap reached, or 80% of it used. */
export function KeyNotice({ overview }: { overview: Pick<TranslationsOverview, "key"> }) {
	const t = useT();
	const { key } = overview;
	if (!key.inUse) return <Notice tone="warning">{t("translations.notices.noKey")}</Notice>;
	if (key.capReached) return <Notice tone="warning">{t("translations.notices.capReached")}</Notice>;
	if (key.capPercent !== null && key.capPercent >= 80) {
		return <Notice tone="warning">{t("translations.notices.capNear", { percent: key.capPercent })}</Notice>;
	}
	return null;
}

export function Notice({ tone, children }: { tone: "warning" | "info"; children: React.ReactNode }) {
	return (
		<div
			role="status"
			className={`mb-6 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
				tone === "warning"
					? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
					: "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
			}`}
		>
			<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div>{children}</div>
		</div>
	);
}

/**
 * Site › Translations: how each of the Site's languages is kept up to date (its Translation mode and
 * progress), and the Review queue: AI translations waiting in the Draft for a person to publish, and
 * Outdated translations, whose Default-language source changed after a person wrote them.
 */
export function TranslationsPage({
	siteId,
	overview,
	lines,
	permissions,
}: {
	siteId: string;
	overview: TranslationsOverview;
	lines: QueueLine[];
	permissions: readonly string[];
}) {
	const t = useT();
	const router = useRouter();
	const canManage = permissions.includes("translation.manage");
	const [running, setRunning] = useState(false);

	const translateNow = async () => {
		setRunning(true);
		try {
			const { queued } = await (await getApi()).translations.translateNow({ siteId });
			toast.success(t("translations.queued", { count: queued }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setRunning(false);
		}
	};

	return (
		<>
			<PageHeader
				heading={t("translations.heading")}
				action={
					canManage ? (
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" render={<Link to="/sites/$siteId/ai-translation" params={{ siteId }} />}>
								<SettingsIcon aria-hidden="true" />
								{t("translations.settings")}
							</Button>
							<Button onClick={() => void translateNow()} disabled={running || !overview.key.inUse}>
								<SparklesIcon aria-hidden="true" />
								{t("translations.translateNow")}
							</Button>
						</div>
					) : null
				}
			>
				{t("translations.intro", { language: overview.defaultLanguage.name })}
			</PageHeader>
			<KeyNotice overview={overview} />
			{overview.languages.length === 0 ? (
				<Card>
					<CardContent className="flex items-center gap-3 py-6">
						<LanguagesIcon className="text-muted-foreground size-5" aria-hidden="true" />
						<p className="text-muted-foreground text-sm">{t("translations.oneLanguage")}</p>
					</CardContent>
				</Card>
			) : (
				<div className="grid max-w-6xl gap-8">
					<ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{overview.languages.map((language) => (
							<li key={language.code}>
								<LanguageCard siteId={siteId} language={language} canManage={canManage} />
							</li>
						))}
					</ul>
					<ReviewQueue siteId={siteId} lines={lines} languages={overview.languages} permissions={permissions} />
				</div>
			)}
		</>
	);
}

function LanguageCard({
	siteId,
	language,
	canManage,
}: {
	siteId: string;
	language: LanguageTranslations;
	canManage: boolean;
}) {
	const t = useT();
	return (
		<Card className="h-full">
			<CardHeader>
				<CardTitle>
					<h2 className="flex items-center gap-2">
						<Badge variant="outline" className="font-mono uppercase">
							{language.code}
						</Badge>
						<span>{language.name}</span>
					</h2>
				</CardTitle>
				<CardAction>
					<span className="text-sm font-semibold tabular-nums">
						{t("translations.percent", { percent: language.progress })}
					</span>
				</CardAction>
			</CardHeader>
			<CardContent className="grid gap-4">
				<Share value={language.progress} label={t("translations.progressOf", { language: language.name })} />
				<div className="grid gap-2">
					<p className="text-muted-foreground text-sm">{t("translations.mode")}</p>
					<ModeChoice
						siteId={siteId}
						language={language}
						canManage={canManage}
						label={t("translations.modeOf", { language: language.name })}
					/>
					<p className="text-muted-foreground text-sm">{t(MODE_WORDS[language.mode].help)}</p>
				</div>
				<ul className="flex flex-wrap gap-2" aria-label={t("translations.countsOf", { language: language.name })}>
					<li>
						<Badge variant={language.toReview > 0 ? "default" : "secondary"}>
							{t("translations.toReview", { count: language.toReview })}
						</Badge>
					</li>
					<li>
						<Badge variant={language.outdated > 0 ? "destructive" : "secondary"}>
							{t("translations.outdated", { count: language.outdated })}
						</Badge>
					</li>
					<li>
						<Badge variant="secondary">{t("translations.missing", { count: language.missing })}</Badge>
					</li>
					{language.queued > 0 ? (
						<li>
							<Badge variant="outline">{t("translations.queuedCount", { count: language.queued })}</Badge>
						</li>
					) : null}
					{language.waiting.map((waiting) => (
						<li key={waiting.reason}>
							<Badge variant="destructive">
								{t(WAITING_WORDS[waiting.reason] ?? "translations.waiting.error", { count: waiting.count })}
							</Badge>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

function lineKey(line: QueueLine): string {
	return `${line.item.kind}:${line.item.id ?? ""}:${line.language}:${line.at}:${line.block ?? ""}`;
}

/** The Review queue: AI translations waiting for a person, and Outdated translations, by language. */
function ReviewQueue({
	siteId,
	lines,
	languages,
	permissions,
}: {
	siteId: string;
	lines: QueueLine[];
	languages: readonly LanguageTranslations[];
	permissions: readonly string[];
}) {
	const t = useT();
	const router = useRouter();
	const filterId = useId();
	const [language, setLanguage] = useState("");
	const [open, setOpen] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const shown = lines.filter((line) => !language || line.language === language);
	const toReview = shown.filter((line) => line.status === "toReview");
	const canPublish = permissions.includes("entry.publish");

	const approveAll = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			let approved = 0;
			for (const code of new Set(toReview.map((line) => line.language))) {
				approved += (await api.translations.approve({ siteId, language: code })).approved;
			}
			toast.success(t("translations.approved", { count: approved }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("translations.queue.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("translations.queue.intro", { language: languages[0]?.name ?? "" })}</CardDescription>
				<CardAction className="flex flex-wrap items-center gap-2">
					<label htmlFor={filterId} className="sr-only">
						{t("translations.queue.language")}
					</label>
					<NativeSelect id={filterId} value={language} onChange={(event) => setLanguage(event.target.value)}>
						<NativeSelectOption value="">{t("translations.queue.allLanguages")}</NativeSelectOption>
						{languages.map((option) => (
							<NativeSelectOption key={option.code} value={option.code}>
								{option.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
					{canPublish ? (
						<Button variant="outline" onClick={() => void approveAll()} disabled={busy || toReview.length === 0}>
							<CheckCheckIcon aria-hidden="true" />
							{t("translations.queue.approveAll", { count: toReview.length })}
						</Button>
					) : null}
				</CardAction>
			</CardHeader>
			<CardContent>
				{shown.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("translations.queue.empty")}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("translations.queue.item")}</TableHead>
								<TableHead>{t("translations.queue.field")}</TableHead>
								<TableHead>{t("translations.queue.language")}</TableHead>
								<TableHead>{t("translations.queue.writtenBy")}</TableHead>
								<TableHead>{t("translations.queue.status")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{shown.map((line) => {
								const key = lineKey(line);
								const expanded = open === key;
								const panelId = `queue-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
								return (
									<Fragment key={key}>
										<TableRow>
											<TableCell>
												<button
													type="button"
													aria-expanded={expanded}
													aria-controls={panelId}
													onClick={() => setOpen(expanded ? null : key)}
													className="focus-visible:ring-ring/50 flex items-center gap-2 rounded-sm text-start font-medium outline-none focus-visible:ring-3"
												>
													<ChevronRightIcon
														className={`size-4 shrink-0 transition-transform rtl:rotate-180 ${expanded ? "rotate-90 rtl:rotate-90" : ""}`}
														aria-hidden="true"
													/>
													<span>{line.item.title || t("translations.queue.untitled")}</span>
												</button>
											</TableCell>
											<TableCell>{line.labels.join(" › ")}</TableCell>
											<TableCell>
												<Badge variant="outline" className="font-mono uppercase">
													{line.language}
												</Badge>
											</TableCell>
											<TableCell>
												<span className="flex items-center gap-1.5">
													{line.writtenBy.kind === "ai" ? (
														<SparklesIcon className="size-4" aria-hidden="true" />
													) : (
														<UserIcon className="size-4" aria-hidden="true" />
													)}
													{line.writtenBy.kind === "ai"
														? t("translations.queue.ai")
														: (line.writtenBy.name ?? t("translations.queue.aPerson"))}
												</span>
											</TableCell>
											<TableCell>
												<Badge variant={line.status === "toReview" ? "default" : "destructive"}>
													{line.status === "toReview"
														? t("translations.queue.statusToReview")
														: t("translations.queue.statusOutdated")}
												</Badge>
											</TableCell>
										</TableRow>
										{expanded ? (
											<TableRow>
												<TableCell colSpan={5} className="whitespace-normal">
													<QueueDetails id={panelId} siteId={siteId} line={line} permissions={permissions} />
												</TableCell>
											</TableRow>
										) : null}
									</Fragment>
								);
							})}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}

/** One line opened: its source and its translation side by side, and what can be done with it. */
function QueueDetails({
	id,
	siteId,
	line,
	permissions,
}: {
	id: string;
	siteId: string;
	line: QueueLine;
	permissions: readonly string[];
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const item =
		line.item.kind === "globals"
			? ({ kind: "globals" } as const)
			: ({ kind: line.item.kind, id: line.item.id ?? "" } as const);
	const act = async (action: "approve" | "confirm" | "retranslate") => {
		setBusy(true);
		try {
			const api = await getApi();
			if (action === "approve") {
				await api.translations.approve({ siteId, language: line.language, items: [item] });
				toast.success(t("translations.approved", { count: 1 }));
			} else if (action === "confirm") {
				await api.translations.confirm({ siteId, item, language: line.language, at: line.at, block: line.block });
				toast.success(t("translations.confirmed"));
			} else {
				await api.translations.retranslate({ siteId, item, language: line.language, at: line.at, block: line.block });
				toast.success(t("translations.retranslated"));
			}
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const canPublish = permissions.includes("entry.publish");
	const canEdit = permissions.includes("entry.edit");
	return (
		<div id={id} className="grid gap-4 py-2 md:grid-cols-2">
			<section
				aria-label={t("translations.queue.source")}
				className="bg-muted/40 grid content-start gap-2 rounded-lg border p-4"
			>
				<h3 className="text-muted-foreground text-sm font-medium">{t("translations.queue.source")}</h3>
				{line.oldSource !== null ? (
					<>
						<p className="text-muted-foreground text-xs">{t("translations.queue.oldSource")}</p>
						<p className="text-sm line-through decoration-1">{line.oldSource}</p>
						<p className="text-muted-foreground text-xs">{t("translations.queue.newSource")}</p>
					</>
				) : null}
				<p className="text-sm whitespace-pre-line">{line.source}</p>
			</section>
			<section
				aria-label={t("translations.queue.translation")}
				className="border-primary/60 grid content-start gap-3 rounded-lg border p-4"
			>
				<h3 className="text-muted-foreground text-sm font-medium">
					{line.writtenBy.kind === "ai"
						? t("translations.queue.aiTranslation")
						: t("translations.queue.personTranslation")}
				</h3>
				<p className="text-sm whitespace-pre-line" lang={line.language}>
					{line.translation}
				</p>
				<div className="flex flex-wrap gap-2">
					{line.status === "toReview" && canPublish ? (
						<Button size="sm" disabled={busy} onClick={() => void act("approve")}>
							<CheckIcon aria-hidden="true" />
							{t("translations.queue.approve")}
						</Button>
					) : null}
					{line.status === "outdated" && canEdit ? (
						<Button size="sm" disabled={busy} onClick={() => void act("confirm")}>
							<CheckIcon aria-hidden="true" />
							{t("translations.queue.confirm")}
						</Button>
					) : null}
					{line.item.kind === "entry" && line.item.postTypeId && canEdit ? (
						<Button
							size="sm"
							variant="outline"
							render={
								<Link
									to="/sites/$siteId/entries/$postTypeId/$entryId"
									params={{ siteId, postTypeId: line.item.postTypeId, entryId: line.item.id ?? "" }}
									search={{ language: line.language }}
								/>
							}
						>
							<PencilIcon aria-hidden="true" />
							{t("translations.queue.edit")}
						</Button>
					) : null}
					{canEdit ? (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void act("retranslate")}>
							<RefreshCwIcon aria-hidden="true" />
							{t("translations.queue.retranslate")}
						</Button>
					) : null}
				</div>
			</section>
		</div>
	);
}
