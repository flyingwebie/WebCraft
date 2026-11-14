import { Link, useRouter } from "@tanstack/react-router";
import type { LanguageTranslations, QueueLine, TranslationMode, TranslationsOverview } from "@webcraft/core";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@webcraft/ui/components/field.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import {
	CheckCheckIcon,
	CheckIcon,
	CircleAlertIcon,
	FileTextIcon,
	LanguagesIcon,
	LockIcon,
	PencilIcon,
	RefreshCwIcon,
	SettingsIcon,
	SparklesIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { StateBadge } from "../settings/layout.tsx";
import { PageHeader } from "../shell/page.tsx";

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

/** A Protected term, as the Translations screen needs it: its words and whether case counts. */
export type TermToKeep = { term: string; matchCase: boolean };

/** An item of the queue, in one language: its values that wait, AI's to review or Outdated. */
type QueueItem = { key: string; line: QueueLine; lines: QueueLine[] };

function itemKey(line: QueueLine): string {
	return `${line.item.kind}:${line.item.id ?? ""}`;
}

/**
 * Site › Translations (frame "Translations"): one tab per language with where it stands and a bar of
 * how much is translated; then the items that wait in that language (translated by AI and waiting
 * for a person, or Outdated: their source changed after a person wrote them) beside the one chosen,
 * its values side by side with the Default language's, Field by Field, with the Protected terms they
 * keep as written; Translate again, Edit and Approve act on it.
 */
export function TranslationsPage({
	siteId,
	overview,
	lines,
	terms,
	permissions,
	language: asked,
	onLanguage,
}: {
	siteId: string;
	overview: TranslationsOverview;
	lines: QueueLine[];
	/** The Protected terms that apply on the Site. */
	terms: readonly TermToKeep[];
	permissions: readonly string[];
	/** The language whose tab is open (the address keeps it); the first one when none is asked. */
	language?: string;
	onLanguage(code: string): void;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const canManage = permissions.includes("translation.manage");
	const [running, setRunning] = useState(false);
	const languages = overview.languages;
	const current = languages.find((each) => each.code === asked) ?? languages[0];

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
						<>
							<Button variant="outline" render={<Link to="/sites/$siteId/ai-translation" params={{ siteId }} />}>
								<SettingsIcon aria-hidden="true" />
								{t("translations.settings")}
							</Button>
							<Button variant="outline" onClick={() => void translateNow()} disabled={running || !overview.key.inUse}>
								<SparklesIcon aria-hidden="true" />
								{t("translations.translateNow")}
							</Button>
						</>
					) : null
				}
			>
				{t("translations.screen.description")}
			</PageHeader>
			<KeyNotice overview={overview} />
			{!current ? (
				<div className="flex items-center gap-3 rounded-xl border p-6">
					<LanguagesIcon className="text-muted-foreground size-5" aria-hidden="true" />
					<p className="text-muted-foreground text-sm">{t("translations.oneLanguage")}</p>
				</div>
			) : (
				<>
					<LanguageTabs languages={languages} current={current.code} onSelect={onLanguage} panelId={`${id}-panel`} />
					<div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${current.code}`} className="grid gap-0">
						<LanguageState language={current} />
						<LanguageQueue
							key={current.code}
							siteId={siteId}
							defaultLanguage={overview.defaultLanguage}
							language={current}
							lines={lines.filter((line) => line.language === current.code)}
							terms={terms}
							permissions={permissions}
						/>
					</div>
				</>
			)}
		</>
	);
}

/** What a language's tab says beside its name: how many wait, how many are Outdated, or Up to date. */
function tabState(t: ReturnType<typeof useT>, language: LanguageTranslations): { text: string; waiting: boolean } {
	if (language.toReview > 0) return { text: t("translations.toReview", { count: language.toReview }), waiting: true };
	if (language.outdated > 0) return { text: t("translations.outdated", { count: language.outdated }), waiting: true };
	return { text: t("translations.screen.upToDate"), waiting: false };
}

/** The languages as tabs (the ARIA tabs pattern: one tab stop, the arrow keys, Home and End). */
function LanguageTabs({
	languages,
	current,
	onSelect,
	panelId,
}: {
	languages: readonly LanguageTranslations[];
	current: string;
	onSelect(code: string): void;
	panelId: string;
}) {
	const t = useT();
	const prefix = panelId.replace(/-panel$/, "");
	const move = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		const index = languages.findIndex((each) => each.code === current);
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
		let next: number | undefined;
		if (step !== undefined) next = (index + step + languages.length) % languages.length;
		if (event.key === "Home") next = 0;
		if (event.key === "End") next = languages.length - 1;
		const target = next === undefined ? undefined : languages[next];
		if (!target) return;
		event.preventDefault();
		onSelect(target.code);
		event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#${prefix}-tab-${target.code}`)?.focus();
	};
	return (
		<div role="tablist" aria-label={t("translations.screen.languages")} className="flex flex-wrap gap-2 border-b">
			{languages.map((language) => {
				const selected = language.code === current;
				const state = tabState(t, language);
				return (
					<button
						key={language.code}
						id={`${prefix}-tab-${language.code}`}
						type="button"
						role="tab"
						aria-selected={selected}
						aria-controls={panelId}
						tabIndex={selected ? 0 : -1}
						onClick={() => onSelect(language.code)}
						onKeyDown={move}
						className="focus-visible:ring-ring/50 aria-selected:border-primary aria-selected:text-foreground text-muted-foreground -mb-px flex h-10 items-center gap-2 rounded-t-sm border-b-2 border-transparent px-1 text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-3"
					>
						<span lang={language.code}>{language.name}</span>
						<StateBadge tone={state.waiting ? "warning" : "neutral"}>{state.text}</StateBadge>
					</button>
				);
			})}
		</div>
	);
}

/** How much of the language is translated, as a bar and in words, and what else stands out. */
function LanguageState({ language }: { language: LanguageTranslations }) {
	const t = useT();
	const more = [
		language.missing > 0 ? t("translations.missing", { count: language.missing }) : null,
		language.queued > 0 ? t("translations.queuedCount", { count: language.queued }) : null,
		...language.waiting.map((waiting) =>
			t(WAITING_WORDS[waiting.reason] ?? "translations.waiting.error", { count: waiting.count }),
		),
	].filter((part): part is string => part !== null);
	return (
		<div className="grid gap-1 py-5">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<Share value={language.progress} label={t("translations.progressOf", { language: language.name })} />
				</div>
				<p className="text-muted-foreground shrink-0 text-sm tabular-nums">
					{t("translations.screen.translated", { percent: language.progress })}
				</p>
			</div>
			{more.length > 0 ? <p className="text-muted-foreground text-xs">{more.join(" · ")}</p> : null}
		</div>
	);
}

/** The items that wait in one language, beside the one chosen. */
function LanguageQueue({
	siteId,
	defaultLanguage,
	language,
	lines,
	terms,
	permissions,
}: {
	siteId: string;
	defaultLanguage: TranslationsOverview["defaultLanguage"];
	language: LanguageTranslations;
	lines: QueueLine[];
	terms: readonly TermToKeep[];
	permissions: readonly string[];
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const items = useMemo(() => {
		const found = new Map<string, QueueItem>();
		for (const line of lines) {
			const key = itemKey(line);
			const item = found.get(key) ?? { key, line, lines: [] };
			item.lines.push(line);
			found.set(key, item);
		}
		return [...found.values()];
	}, [lines]);
	const [chosen, setChosen] = useState<string | null>(null);
	const open = items.find((item) => item.key === chosen) ?? items[0] ?? null;
	const toReview = lines.filter((line) => line.status === "toReview").length;
	const canPublish = permissions.includes("entry.publish");

	const approveAll = async () => {
		setBusy(true);
		try {
			const { approved } = await (await getApi()).translations.approve({ siteId, language: language.code });
			toast.success(t("translations.approved", { count: approved }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	if (items.length === 0) {
		return (
			<p className="text-muted-foreground rounded-xl border p-6 text-sm">
				{t("translations.screen.nothingWaits", { language: language.name })}
			</p>
		);
	}
	return (
		<div className="grid @4xl/page:-ms-5 @4xl/page:min-h-96 @4xl/page:grid-cols-[19rem_minmax(0,1fr)]">
			<nav
				aria-label={t("translations.screen.waiting", { language: language.name })}
				className="grid content-start gap-1 border-b pb-3 @4xl/page:border-e @4xl/page:border-b-0 @4xl/page:pe-3"
			>
				<ul className="grid gap-1">
					{items.map((item) => {
						const current = item.key === open?.key;
						const outdated = item.lines.every((line) => line.status === "outdated");
						const Icon = item.line.item.kind === "entry" ? FileTextIcon : LanguagesIcon;
						return (
							<li key={item.key}>
								<button
									type="button"
									aria-current={current ? "true" : undefined}
									onClick={() => setChosen(item.key)}
									className="focus-visible:ring-ring/50 hover:bg-accent aria-[current=true]:bg-muted grid w-full gap-1 rounded-lg px-3 py-2.5 text-start transition-colors duration-150 outline-none focus-visible:ring-3"
								>
									<span className="flex items-center gap-2 text-sm font-medium">
										<Icon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
										{item.line.item.title || t("translations.queue.untitled")}
									</span>
									<span className="text-muted-foreground ps-6 text-[13px]">
										{outdated
											? t("translations.screen.outdatedLine", { language: defaultLanguage.name })
											: t("translations.screen.aiLine")}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
				{canPublish && toReview > 1 ? (
					<div className="px-1 pt-2">
						<Button variant="ghost" size="sm" onClick={() => void approveAll()} disabled={busy}>
							<CheckCheckIcon aria-hidden="true" />
							{t("translations.queue.approveAll", { count: toReview })}
						</Button>
					</div>
				) : null}
			</nav>
			{open ? (
				<ItemTranslationView
					key={open.key}
					siteId={siteId}
					defaultLanguage={defaultLanguage}
					language={language}
					item={open}
					terms={terms}
					permissions={permissions}
				/>
			) : null}
		</div>
	);
}

/** Which Protected terms a source holds, as the translation keeps them. */
function termsIn(source: string, terms: readonly TermToKeep[]): string[] {
	return terms
		.filter((term) =>
			term.matchCase ? source.includes(term.term) : source.toLocaleLowerCase().includes(term.term.toLocaleLowerCase()),
		)
		.map((term) => term.term);
}

/** The item chosen: its values side by side, Field by Field, and what can be done with it. */
function ItemTranslationView({
	siteId,
	defaultLanguage,
	language,
	item,
	terms,
	permissions,
}: {
	siteId: string;
	defaultLanguage: TranslationsOverview["defaultLanguage"];
	language: LanguageTranslations;
	item: QueueItem;
	terms: readonly TermToKeep[];
	permissions: readonly string[];
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const { line: first, lines } = item;
	const ref =
		first.item.kind === "globals"
			? ({ kind: "globals" } as const)
			: ({ kind: first.item.kind, id: first.item.id ?? "" } as const);
	const toReview = lines.some((line) => line.status === "toReview");
	const byAi = lines.some((line) => line.writtenBy.kind === "ai");
	const canPublish = permissions.includes("entry.publish");
	const canEdit = permissions.includes("entry.edit");

	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		try {
			await work();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const approve = () =>
		run(async () => {
			await (await getApi()).translations.approve({ siteId, language: language.code, items: [ref] });
			toast.success(t("translations.approved", { count: 1 }));
		});
	const translateAgain = () =>
		run(async () => {
			const api = await getApi();
			for (const line of lines)
				await api.translations.retranslate({
					siteId,
					item: ref,
					language: language.code,
					at: line.at,
					block: line.block,
				});
			toast.success(t("translations.retranslated"));
		});
	const confirm = (line: QueueLine) =>
		run(async () => {
			await (await getApi()).translations.confirm({
				siteId,
				item: ref,
				language: language.code,
				at: line.at,
				block: line.block,
			});
			toast.success(t("translations.confirmed"));
		});
	const edit =
		first.item.kind === "entry" && first.item.postTypeId ? (
			<Link
				to="/sites/$siteId/entries/$postTypeId/$entryId"
				params={{ siteId, postTypeId: first.item.postTypeId, entryId: first.item.id ?? "" }}
				search={{ language: language.code }}
			/>
		) : first.item.kind === "popupContent" ? (
			<Link
				to="/sites/$siteId/popups"
				params={{ siteId }}
				search={{ popup: first.item.id ?? "", language: language.code }}
			/>
		) : first.item.kind === "globals" ? (
			<Link to="/sites/$siteId/globals" params={{ siteId }} search={{ language: language.code }} />
		) : null;

	return (
		<section
			aria-labelledby="translation-item-heading"
			className="grid content-start gap-4 pt-4 @4xl/page:ps-8 @4xl/page:pt-2"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="grid gap-1">
					<h2 id="translation-item-heading" className="text-base font-semibold">
						{first.item.title || t("translations.queue.untitled")}
					</h2>
					<p className="text-muted-foreground text-[13px]">
						{byAi ? t("translations.screen.byAi") : t("translations.screen.byPerson")}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					{canEdit ? (
						<Button variant="outline" disabled={busy} onClick={() => void translateAgain()}>
							<RefreshCwIcon aria-hidden="true" />
							{t("translations.screen.translateAgain")}
						</Button>
					) : null}
					{canEdit && edit ? (
						<Button variant="outline" render={edit}>
							<PencilIcon aria-hidden="true" />
							{t("translations.queue.edit")}
						</Button>
					) : null}
					{toReview && canPublish ? (
						<Button disabled={busy} onClick={() => void approve()}>
							<CheckIcon aria-hidden="true" />
							{t("translations.queue.approve")}
						</Button>
					) : null}
				</div>
			</div>
			<div className="grid">
				<div aria-hidden="true" className="hidden gap-4 pb-1 @2xl/page:grid @2xl/page:grid-cols-2">
					<p className="text-muted-foreground text-xs font-medium">{defaultLanguage.name}</p>
					<p className="text-muted-foreground text-xs font-medium">{language.name}</p>
				</div>
				{lines.map((line) => {
					const kept = termsIn(line.source, terms);
					return (
						<div key={`${line.at}:${line.block ?? ""}`} className="grid gap-2 border-b py-4">
							<h3 className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs font-medium">
								{line.labels.join(" › ")}
								{line.status === "outdated" ? (
									<StateBadge tone="warning">{t("translations.queue.statusOutdated")}</StateBadge>
								) : null}
							</h3>
							<div className="grid items-start gap-2 @2xl/page:grid-cols-2 @2xl/page:gap-4">
								<div className="grid gap-1 text-sm">
									<span className="sr-only">{defaultLanguage.name}: </span>
									{line.oldSource !== null ? (
										<>
											<p className="text-muted-foreground text-xs">{t("translations.queue.oldSource")}</p>
											<p className="text-muted-foreground line-through decoration-1">{line.oldSource}</p>
											<p className="text-muted-foreground text-xs">{t("translations.queue.newSource")}</p>
										</>
									) : null}
									<p className="whitespace-pre-line" lang={defaultLanguage.code}>
										{line.source}
									</p>
								</div>
								<div className="grid gap-1 text-sm">
									<span className="sr-only">{language.name}: </span>
									<p className="whitespace-pre-line" lang={language.code}>
										{line.translation}
									</p>
									{kept.map((term) => (
										<p key={term} className="text-muted-foreground flex items-center gap-1.5 text-xs">
											<LockIcon aria-hidden="true" className="size-3 shrink-0" />
											{t("translations.screen.protected", { term })}
										</p>
									))}
									{line.status === "outdated" && canEdit ? (
										<div>
											<Button size="sm" variant="outline" disabled={busy} onClick={() => void confirm(line)}>
												<CheckIcon aria-hidden="true" />
												{t("translations.queue.confirm")}
											</Button>
										</div>
									) : null}
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}
