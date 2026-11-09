import { Link, useRouter } from "@tanstack/react-router";
import type { ProtectedTerm, TranslationsOverview } from "@webcraft/core";
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
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { ExternalLinkIcon, KeyRoundIcon, PlusIcon, ShieldIcon, SparklesIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { KeyNotice, MODE_WORDS, ModeChoice, Share } from "./TranslationsPage.tsx";

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
			<div className="grid max-w-5xl gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("aiTranslation.key.heading")}</h2>
						</CardTitle>
						<CardDescription>{t("aiTranslation.key.intro")}</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-4">
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
					</CardContent>
				</Card>

				<SiteTerms
					siteId={siteId}
					workspaceId={workspaceId}
					siteTerms={siteTerms}
					workspaceCount={workspaceTerms.length}
					canEdit={permissions.includes("protectedTerms.edit")}
				/>

				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("aiTranslation.modes.heading")}</h2>
						</CardTitle>
						<CardDescription>
							{t("aiTranslation.modes.intro", { language: overview.defaultLanguage.name })}
						</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-4">
						{overview.languages.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("translations.oneLanguage")}</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("aiTranslation.modes.language")}</TableHead>
										<TableHead>{t("aiTranslation.modes.mode")}</TableHead>
										<TableHead>{t("aiTranslation.modes.status")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{overview.languages.map((language) => (
										<TableRow key={language.code}>
											<TableCell>
												<span className="flex items-center gap-2">
													<Badge variant="outline" className="font-mono uppercase">
														{language.code}
													</Badge>
													{language.name}
												</span>
											</TableCell>
											<TableCell>
												<ModeChoice
													siteId={siteId}
													language={language}
													canManage={permissions.includes("translation.manage")}
													label={t("translations.modeOf", { language: language.name })}
												/>
											</TableCell>
											<TableCell className="whitespace-normal">
												{language.toReview === 0 && language.outdated === 0 && language.missing === 0 ? (
													<Badge variant="secondary">{t("aiTranslation.modes.upToDate")}</Badge>
												) : (
													<span className="text-sm">
														{t("aiTranslation.modes.counts", {
															toReview: language.toReview,
															outdated: language.outdated,
															missing: language.missing,
														})}
													</span>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
						<dl className="bg-muted/40 grid gap-2 rounded-lg p-4 text-sm">
							{(["automatic", "review", "manual"] as const).map((mode) => (
								<div key={mode} className="flex flex-wrap gap-x-2">
									<dt className="font-semibold">{t(MODE_WORDS[mode].label)}</dt>
									<dd className="text-muted-foreground">{t(MODE_WORDS[mode].help)}</dd>
								</div>
							))}
						</dl>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("aiTranslation.usage.heading")}</h2>
						</CardTitle>
						<CardDescription>{t("aiTranslation.usage.intro")}</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-4">
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
					</CardContent>
				</Card>
			</div>
		</>
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
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("aiTranslation.terms.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("aiTranslation.terms.intro")}</CardDescription>
				<CardAction>
					<Button
						variant="outline"
						size="sm"
						render={<Link to="/workspaces/$workspaceId/protected-terms" params={{ workspaceId }} />}
					>
						<ShieldIcon aria-hidden="true" />
						{t("aiTranslation.terms.workspace", { count: workspaceCount })}
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent className="grid gap-4">
				{siteTerms.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("aiTranslation.terms.none")}</p>
				) : (
					<ul className="flex flex-wrap gap-2" aria-label={t("aiTranslation.terms.siteList")}>
						{siteTerms.map((siteTerm) => (
							<li key={siteTerm.id}>
								<Badge variant="outline">{siteTerm.term}</Badge>
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
						<Button type="submit" disabled={term.trim() === ""}>
							<PlusIcon aria-hidden="true" />
							{t("aiTranslation.terms.add")}
						</Button>
						{error ? <FieldError id={`${id}-error`}>{t(error)}</FieldError> : null}
					</form>
				) : null}
			</CardContent>
		</Card>
	);
}
