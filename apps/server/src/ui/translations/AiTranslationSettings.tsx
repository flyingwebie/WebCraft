import { Link, useRouter } from "@tanstack/react-router";
import type { ProtectedTerm, TranslationsOverview } from "@webcraft/core";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { ExternalLinkIcon, KeyRoundIcon, PlusIcon, ShieldIcon, SparklesIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../settings/form.tsx";
import { SettingsCard, SettingsRows, StateBadge } from "../settings/layout.tsx";
import { KeyNotice, MODE_WORDS, Share } from "./TranslationsPage.tsx";

/**
 * Site settings › AI translation: the AI key the Site's translations go through (the Workspace's own,
 * else a shared Install key: a Site never picks its own model in v1), its Protected terms, each
 * language's Translation mode, and what AI translation used this month. Staff and Owners
 * (`translation.manage`); saved at once and logged.
 */
export function AiTranslationSettings({
	siteId,
	workspaceId,
	overview,
	terms,
	permissions,
}: {
	siteId: string;
	workspaceId: string;
	overview: TranslationsOverview;
	terms: ProtectedTerm[];
	permissions: readonly string[];
}) {
	const t = useT();
	const router = useRouter();
	const [running, setRunning] = useState(false);
	const siteTerms = terms.filter((term) => term.site?.id === siteId);
	const workspaceTerms = terms.filter((term) => term.site === null);
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
	const keyWords: Record<string, MessageKey> = {
		own: "aiTranslation.key.own",
		shared: "aiTranslation.key.shared",
	};
	return (
		<>
			<PageHeader
				heading={t("aiTranslation.heading")}
				action={
					<Button variant="outline" onClick={() => void translateNow()} disabled={running || !overview.key.inUse}>
						<SparklesIcon aria-hidden="true" />
						{t("translations.translateNow")}
					</Button>
				}
			>
				{t("aiTranslation.intro")}
			</PageHeader>
			<KeyNotice overview={overview} />
			<SettingsForm>
				<div className="grid gap-6">
					<SettingsCard title={t("aiTranslation.key.heading")} description={t("aiTranslation.key.intro")}>
						<div className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border p-4">
							<KeyRoundIcon className="size-5" aria-hidden="true" />
							<p className="grow text-sm font-medium">
								{overview.key.inUse
									? t(keyWords[overview.key.inUse] ?? "aiTranslation.key.own")
									: t("aiTranslation.key.none")}
							</p>
							{permissions.includes("aiUsage.view") ? (
								<Button
									variant="outline"
									size="sm"
									render={<Link to="/workspaces/$workspaceId/ai-keys" params={{ workspaceId }} />}
								>
									<ExternalLinkIcon aria-hidden="true" />
									{t("aiTranslation.key.manage")}
								</Button>
							) : null}
						</div>
						<p className="text-muted-foreground text-sm">{t("aiTranslation.key.noOverride")}</p>
					</SettingsCard>

					<SiteTerms
						siteId={siteId}
						workspaceId={workspaceId}
						siteTerms={siteTerms}
						workspaceCount={workspaceTerms.length}
						canEdit={permissions.includes("protectedTerms.edit")}
					/>

					<SettingsCard
						title={t("aiTranslation.modes.heading")}
						description={t("aiTranslation.modes.intro", { language: overview.defaultLanguage.name })}
					>
						{overview.languages.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("translations.oneLanguage")}</p>
						) : (
							<SettingsRows>
								{overview.languages.map((language) => (
									<ModeRow
										key={language.code}
										siteId={siteId}
										language={language}
										canManage={permissions.includes("translation.manage")}
									/>
								))}
							</SettingsRows>
						)}
						<dl className="bg-muted/40 grid gap-2 rounded-lg p-4 text-sm">
							{(["automatic", "review", "manual"] as const).map((mode) => (
								<div key={mode} className="flex flex-wrap gap-x-2">
									<dt className="font-semibold">{t(MODE_WORDS[mode].label)}</dt>
									<dd className="text-muted-foreground">{t(MODE_WORDS[mode].help)}</dd>
								</div>
							))}
						</dl>
					</SettingsCard>

					<SettingsCard title={t("aiTranslation.usage.heading")} description={t("aiTranslation.usage.intro")}>
						<dl className="grid gap-4 sm:grid-cols-3">
							<div className="rounded-lg border p-4">
								<dt className="text-muted-foreground text-sm">{t("aiTranslation.usage.tokens")}</dt>
								<dd className="text-2xl font-semibold tabular-nums">{overview.usage.tokens.toLocaleString("en")}</dd>
								<dd className="text-muted-foreground text-sm">
									{t("aiTranslation.usage.calls", { count: overview.usage.calls })}
								</dd>
							</div>
							{overview.usage.cost !== null ? (
								<div className="rounded-lg border p-4">
									<dt className="text-muted-foreground text-sm">{t("aiTranslation.usage.cost")}</dt>
									<dd className="text-2xl font-semibold tabular-nums">{dollars(overview.usage.cost)}</dd>
									<dd className="text-muted-foreground text-sm">{t("aiTranslation.usage.estimate")}</dd>
								</div>
							) : null}
							<div className="rounded-lg border p-4">
								<dt className="text-muted-foreground text-sm">{t("aiTranslation.usage.cacheHits")}</dt>
								<dd className="text-2xl font-semibold tabular-nums">
									{overview.usage.cacheHits === null
										? "—"
										: t("translations.percent", { percent: overview.usage.cacheHits })}
								</dd>
								<dd className="text-muted-foreground text-sm">{t("aiTranslation.usage.cacheHelp")}</dd>
							</div>
						</dl>
						{overview.key.capPercent !== null ? (
							<div className="grid gap-2">
								<p className="text-sm">{t("aiTranslation.usage.cap", { percent: overview.key.capPercent })}</p>
								<Share
									value={overview.key.capPercent}
									label={t("aiTranslation.usage.capLabel")}
									tone={overview.key.capPercent >= 80 ? "warning" : "primary"}
								/>
							</div>
						) : null}
					</SettingsCard>
				</div>
			</SettingsForm>
		</>
	);
}

/**
 * One language's Translation mode, saved with the foot bar, and where its translations stand.
 * People without `translation.manage` see the mode only.
 */
function ModeRow({
	siteId,
	language,
	canManage,
}: {
	siteId: string;
	language: TranslationsOverview["languages"][number];
	canManage: boolean;
}) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: { mode: language.mode },
		save: async ({ mode }) => (await getApi()).translations.setMode({ siteId, language: language.code, mode }),
	});
	const upToDate = language.toReview === 0 && language.outdated === 0 && language.missing === 0;
	return (
		<div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-center gap-2 text-sm font-medium">
				<StateBadge className="font-mono uppercase">{language.code}</StateBadge>
				<span>{language.name}</span>
				<StateBadge tone={upToDate ? "success" : "warning"}>
					{upToDate
						? t("aiTranslation.modes.upToDate")
						: t("aiTranslation.modes.counts", {
								toReview: language.toReview,
								outdated: language.outdated,
								missing: language.missing,
							})}
				</StateBadge>
			</div>
			{canManage ? (
				<FieldSet>
					<FieldLegend variant="label" className="sr-only">
						{t("translations.modeOf", { language: language.name })}
					</FieldLegend>
					<RadioGroup
						value={section.values.mode}
						onValueChange={(value) => section.set({ mode: value as typeof language.mode })}
						className="flex flex-wrap gap-x-5 gap-y-2"
					>
						{(["automatic", "review", "manual"] as const).map((option) => (
							<Field key={option} orientation="horizontal" className="w-auto">
								<RadioGroupItem value={option} id={`${id}-${option}`} />
								<FieldLabel htmlFor={`${id}-${option}`}>{t(MODE_WORDS[option].label)}</FieldLabel>
							</Field>
						))}
					</RadioGroup>
				</FieldSet>
			) : (
				<p className="text-sm">{t(MODE_WORDS[language.mode].label)}</p>
			)}
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</div>
	);
}

/** Dollars as people read an estimate: `$0.21`, or more digits for less than a cent. */
export function dollars(amount: number): string {
	const digits = amount > 0 && amount < 0.01 ? 4 : 2;
	return `$${amount.toFixed(digits)}`;
}

/** The Site's own Protected terms, with a way to add one, and how many the Workspace keeps for all its Sites. */
function SiteTerms({
	siteId,
	workspaceId,
	siteTerms,
	workspaceCount,
	canEdit,
}: {
	siteId: string;
	workspaceId: string;
	siteTerms: ProtectedTerm[];
	workspaceCount: number;
	canEdit: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [term, setTerm] = useState("");
	const [matchCase, setMatchCase] = useState(true);
	const [error, setError] = useState<MessageKey | null>(null);
	const add = async (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		try {
			await (await getApi()).protectedTerms.add({ workspaceId, siteId, terms: [{ term, matchCase }] });
			setTerm("");
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		}
	};
	return (
		<SettingsCard
			title={t("aiTranslation.terms.heading")}
			description={t("aiTranslation.terms.intro")}
			action={
				<Button
					variant="outline"
					size="sm"
					render={<Link to="/workspaces/$workspaceId/protected-terms" params={{ workspaceId }} />}
				>
					<ShieldIcon aria-hidden="true" />
					{t("aiTranslation.terms.workspace", { count: workspaceCount })}
				</Button>
			}
		>
			{siteTerms.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("aiTranslation.terms.none")}</p>
			) : (
				<ul className="flex flex-wrap gap-2" aria-label={t("aiTranslation.terms.siteList")}>
					{siteTerms.map((siteTerm) => (
						<li key={siteTerm.id}>
							<StateBadge>{siteTerm.term}</StateBadge>
						</li>
					))}
				</ul>
			)}
			{canEdit ? (
				<form onSubmit={add} className="flex flex-wrap items-end gap-3" noValidate>
					<Field className="w-auto grow" data-invalid={error ? true : undefined}>
						<FieldLabel htmlFor={`${id}-term`}>{t("protectedTerms.term")}</FieldLabel>
						<Input
							id={`${id}-term`}
							value={term}
							maxLength={200}
							required
							onChange={(event) => setTerm(event.target.value)}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? `${id}-error` : undefined}
						/>
					</Field>
					<Field orientation="horizontal" className="w-auto pb-2">
						<Checkbox
							id={`${id}-case`}
							checked={matchCase}
							onCheckedChange={(checked) => setMatchCase(checked === true)}
						/>
						<FieldLabel htmlFor={`${id}-case`}>{t("protectedTerms.matchCase")}</FieldLabel>
					</Field>
					<Button type="submit" variant="outline" disabled={term.trim() === ""}>
						<PlusIcon aria-hidden="true" />
						{t("aiTranslation.terms.add")}
					</Button>
					{error ? <FieldError id={`${id}-error`}>{t(error)}</FieldError> : null}
				</form>
			) : null}
		</SettingsCard>
	);
}
