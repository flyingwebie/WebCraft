import { useRouter } from "@tanstack/react-router";
import type { AiProvider, WorkspaceAiView } from "@webcraft/core";
import { AI_MODELS, AI_PROVIDERS, knownAiPrice } from "@webcraft/core/ai-models";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { CircleCheckIcon, KeyRoundIcon, LockIcon, PlugIcon, TrashIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { dollars } from "../translations/AiTranslationSettings.tsx";
import { Notice, Share } from "../translations/TranslationsPage.tsx";

/** Each provider's name as people know it. */
export const PROVIDER_WORDS: Record<AiProvider, MessageKey> = {
	openai: "aiKeys.providers.openai",
	anthropic: "aiKeys.providers.anthropic",
	google: "aiKeys.providers.google",
	openrouter: "aiKeys.providers.openrouter",
	openaiCompatible: "aiKeys.providers.openaiCompatible",
};

/** A number people typed as dollars, or null when it is empty. */
export function moneyOf(text: string): number | null {
	const value = Number.parseFloat(text.replace(/[$\s,]/g, ""));
	return text.trim() === "" || Number.isNaN(value) ? null : value;
}

/**
 * Workspace › AI keys: the Workspace's own AI key (provider, model, the key itself, an optional
 * monthly cap), the shared Install key the Superadmin assigned (read-only here), and what each Site
 * spent this month. The own key is used first. Keys are write-only: only "set" and the last 4
 * characters ever show. Owners and Staff (`aiKey.manage`).
 */
export function AiKeysPage({ workspaceId, view }: { workspaceId: string; view: WorkspaceAiView }) {
	const t = useT();
	const capInput = useRef<HTMLInputElement>(null);
	const budget = view.inUse === "own" ? view.usage.own : view.inUse === "shared" ? view.usage.shared : null;
	return (
		<>
			<PageHeader heading={t("aiKeys.heading")}>{t("aiKeys.intro")}</PageHeader>
			{budget?.percent !== null && budget?.percent !== undefined && budget.percent >= 80 ? (
				<Notice tone="warning">
					<p className="font-medium">
						{budget.stopped ? t("aiKeys.capReached") : t("aiKeys.capNear", { percent: budget.percent })}
					</p>
					<p>
						{t("aiKeys.capDetail", {
							spent: dollars(budget.spent),
							cap: dollars(budget.cap ?? 0),
							month: view.usage.month,
						})}
					</p>
					{view.inUse === "own" ? (
						<Button size="sm" variant="outline" className="mt-2" onClick={() => capInput.current?.focus()}>
							{t("aiKeys.raiseCap")}
						</Button>
					) : null}
				</Notice>
			) : null}
			<div className="grid max-w-5xl gap-8">
				<OwnKeyCard workspaceId={workspaceId} view={view} capInput={capInput} />
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("aiKeys.shared.heading")}</h2>
						</CardTitle>
						<CardDescription>{t("aiKeys.shared.intro")}</CardDescription>
					</CardHeader>
					<CardContent>
						{view.shared ? (
							<div className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border p-4">
								<LockIcon className="size-5" aria-hidden="true" />
								<div className="grid grow gap-1">
									<p className="flex flex-wrap items-center gap-2 font-medium">
										{view.shared.name}
										<Badge variant="secondary">
											{view.inUse === "shared" ? t("aiKeys.shared.inUse") : t("aiKeys.shared.standby")}
										</Badge>
									</p>
									<p className="text-muted-foreground text-sm">
										{t("aiKeys.shared.detail", {
											provider: t(PROVIDER_WORDS[view.shared.provider]),
											model: view.shared.model,
											cap: dollars(view.shared.monthlyCap),
										})}
									</p>
								</div>
							</div>
						) : (
							<p className="text-muted-foreground text-sm">{t("aiKeys.shared.none")}</p>
						)}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("aiKeys.usage.heading", { month: view.usage.month })}</h2>
						</CardTitle>
						<CardDescription>{t("aiKeys.usage.intro")}</CardDescription>
					</CardHeader>
					<CardContent>
						{view.usage.sites.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("aiKeys.usage.none")}</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("aiKeys.usage.site")}</TableHead>
										<TableHead>{t("aiKeys.usage.key")}</TableHead>
										<TableHead>{t("aiKeys.usage.calls")}</TableHead>
										<TableHead>{t("aiKeys.usage.tokens")}</TableHead>
										<TableHead>{t("aiKeys.usage.cost")}</TableHead>
										<TableHead>{t("aiKeys.usage.share")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{view.usage.sites.map((site) => {
										const cap = budget?.cap ?? null;
										const share = cap ? Math.round((site.cost / cap) * 100) : null;
										return (
											<TableRow key={site.siteId}>
												<TableCell className="font-medium">{site.name}</TableCell>
												<TableCell>
													{site.keys
														.map((key) => (key === "own" ? t("aiKeys.usage.own") : t("aiKeys.usage.shared")))
														.join(", ")}
												</TableCell>
												<TableCell className="tabular-nums">{site.calls}</TableCell>
												<TableCell className="tabular-nums">
													{(site.inputTokens + site.outputTokens).toLocaleString("en")}
												</TableCell>
												<TableCell className="tabular-nums">{dollars(site.cost)}</TableCell>
												<TableCell className="min-w-32">
													{share === null ? (
														"—"
													) : (
														<Share
															value={share}
															label={t("aiKeys.usage.shareOf", { name: site.name, percent: share })}
														/>
													)}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						)}
						<p className="text-muted-foreground mt-4 text-sm">{t("aiKeys.usage.estimates")}</p>
					</CardContent>
				</Card>
			</div>
		</>
	);
}

/** The Workspace's own key: its provider, the key (write-only), model, endpoint, cap and price. */
function OwnKeyCard({
	workspaceId,
	view,
	capInput,
}: {
	workspaceId: string;
	view: WorkspaceAiView;
	capInput: React.RefObject<HTMLInputElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const runSensitive = useSensitiveAction();
	const own = view.own;
	const [provider, setProvider] = useState<AiProvider>(own?.provider ?? "openai");
	const [model, setModel] = useState(own?.model ?? AI_MODELS.openai[0]?.id ?? "");
	const [endpoint, setEndpoint] = useState(own?.endpoint ?? "");
	const [key, setKey] = useState("");
	const [replacing, setReplacing] = useState(!own);
	const [cap, setCap] = useState(
		own?.monthlyCap === null || own?.monthlyCap === undefined ? "" : String(own.monthlyCap),
	);
	const [inputPrice, setInputPrice] = useState(own?.price && !own.price.estimated ? String(own.price.input) : "");
	const [outputPrice, setOutputPrice] = useState(own?.price && !own.price.estimated ? String(own.price.output) : "");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const removeButton = useRef<HTMLButtonElement>(null);
	const estimate = knownAiPrice(provider, model.trim());

	const chooseProvider = (next: AiProvider) => {
		setProvider(next);
		setModel(AI_MODELS[next][0]?.id ?? "");
		if (next !== "openaiCompatible") setEndpoint("");
		// A key never moves to another provider without being typed again.
		if (own && next !== own.provider) setReplacing(true);
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const price =
				inputPrice.trim() !== "" && outputPrice.trim() !== ""
					? { input: moneyOf(inputPrice) ?? 0, output: moneyOf(outputPrice) ?? 0 }
					: null;
			await runSensitive(() =>
				api.aiKeys.setOwn({
					workspaceId,
					provider,
					model: model.trim(),
					endpoint: provider === "openaiCompatible" ? endpoint.trim() : null,
					...(key.trim() ? { key: key.trim() } : {}),
					price,
					monthlyCap: moneyOf(cap),
				}),
			);
			setKey("");
			setReplacing(false);
			toast.success(t("aiKeys.own.saved"));
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const test = async () => {
		setBusy(true);
		try {
			const result = await (await getApi()).aiKeys.testOwn({ workspaceId });
			if (result.ok) toast.success(t("aiKeys.own.testOk"));
			else toast.error(t("aiKeys.own.testFailed", { problem: result.problem ?? "" }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		try {
			const api = await getApi();
			await runSensitive(() => api.aiKeys.removeOwn({ workspaceId }));
			toast.success(t("aiKeys.own.removed"));
			setRemoving(false);
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("aiKeys.own.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("aiKeys.own.intro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={save} noValidate>
					<FieldGroup className="gap-6">
						<FieldSet>
							<FieldLegend variant="label">{t("aiKeys.own.provider")}</FieldLegend>
							<RadioGroup
								value={provider}
								onValueChange={(value) => chooseProvider(value as AiProvider)}
								className="flex flex-wrap gap-x-5 gap-y-2"
							>
								{AI_PROVIDERS.map((option) => (
									<Field key={option} orientation="horizontal" className="w-auto">
										<RadioGroupItem value={option} id={`${id}-${option}`} />
										<FieldLabel htmlFor={`${id}-${option}`}>{t(PROVIDER_WORDS[option])}</FieldLabel>
									</Field>
								))}
							</RadioGroup>
						</FieldSet>
						<div className="grid gap-6 md:grid-cols-2">
							<Field>
								<FieldLabel htmlFor={`${id}-key`}>{t("aiKeys.own.key")}</FieldLabel>
								{own && !replacing ? (
									<div className="flex flex-wrap items-center gap-2">
										<p id={`${id}-key`} className="bg-muted/40 grow rounded-md border px-3 py-2 font-mono text-sm">
											<KeyRoundIcon className="me-2 inline size-4" aria-hidden="true" />
											{own.key.set
												? t("aiKeys.own.keySet", { lastFour: own.key.lastFour ?? "" })
												: t("aiKeys.own.keyNotSet")}
										</p>
										<Button type="button" variant="outline" onClick={() => setReplacing(true)}>
											{t("aiKeys.own.replace")}
										</Button>
										<Button type="button" variant="outline" disabled={busy} onClick={() => void test()}>
											<PlugIcon aria-hidden="true" />
											{t("aiKeys.own.test")}
										</Button>
									</div>
								) : (
									<Input
										id={`${id}-key`}
										type="password"
										autoComplete="off"
										spellCheck={false}
										className="font-mono"
										value={key}
										maxLength={1000}
										onChange={(event) => setKey(event.target.value)}
									/>
								)}
								<FieldDescription>{t("aiKeys.own.keyHelp")}</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-model`}>{t("aiKeys.own.model")}</FieldLabel>
								<Input
									id={`${id}-model`}
									list={`${id}-models`}
									value={model}
									maxLength={200}
									spellCheck={false}
									onChange={(event) => setModel(event.target.value)}
								/>
								<datalist id={`${id}-models`}>
									{AI_MODELS[provider].map((option) => (
										<option key={option.id} value={option.id} />
									))}
								</datalist>
								<FieldDescription>
									{estimate
										? t("aiKeys.own.estimate", { input: estimate.input, output: estimate.output })
										: t("aiKeys.own.noEstimate")}
								</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-cap`}>{t("aiKeys.own.cap")}</FieldLabel>
								<Input
									ref={capInput}
									id={`${id}-cap`}
									inputMode="decimal"
									value={cap}
									placeholder="10.00"
									onChange={(event) => setCap(event.target.value)}
								/>
								<FieldDescription>{t("aiKeys.own.capHelp")}</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-endpoint`}>{t("aiKeys.own.endpoint")}</FieldLabel>
								<Input
									id={`${id}-endpoint`}
									type="url"
									value={endpoint}
									disabled={provider !== "openaiCompatible"}
									placeholder={t("aiKeys.own.endpointPlaceholder")}
									onChange={(event) => setEndpoint(event.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-input-price`}>{t("aiKeys.own.inputPrice")}</FieldLabel>
								<Input
									id={`${id}-input-price`}
									inputMode="decimal"
									value={inputPrice}
									onChange={(event) => setInputPrice(event.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-output-price`}>{t("aiKeys.own.outputPrice")}</FieldLabel>
								<Input
									id={`${id}-output-price`}
									inputMode="decimal"
									value={outputPrice}
									onChange={(event) => setOutputPrice(event.target.value)}
								/>
								<FieldDescription>{t("aiKeys.own.priceHelp")}</FieldDescription>
							</Field>
						</div>
						{error ? <FieldError>{t(error)}</FieldError> : null}
						<div className="flex flex-wrap items-center justify-between gap-3">
							<p className="text-muted-foreground flex items-center gap-2 text-sm">
								{own?.testedAt && own.testResult === "ok" ? (
									<CircleCheckIcon className="size-4 text-green-700 dark:text-green-400" aria-hidden="true" />
								) : null}
								{own
									? t("aiKeys.own.setBy", {
											name: own.setBy?.name ?? "—",
											date: own.setAt ? formatUtc(own.setAt) : "—",
											tested: own.testedAt ? formatUtc(own.testedAt) : t("aiKeys.own.never"),
										})
									: t("aiKeys.own.none")}
							</p>
							<div className="flex flex-wrap gap-2">
								{own ? (
									<Button ref={removeButton} type="button" variant="outline" onClick={() => setRemoving(true)}>
										<TrashIcon aria-hidden="true" />
										{t("aiKeys.own.remove")}
									</Button>
								) : null}
								<Button type="submit" disabled={busy || model.trim() === "" || (replacing && key.trim() === "")}>
									{t("aiKeys.own.save")}
								</Button>
							</div>
						</div>
					</FieldGroup>
				</form>
			</CardContent>
			<Dialog open={removing} onOpenChange={setRemoving}>
				<DialogContent closeLabel={t("aiKeys.close")} finalFocus={removeButton}>
					<DialogHeader>
						<DialogTitle>{t("aiKeys.own.removeTitle")}</DialogTitle>
						<DialogDescription>{t("aiKeys.own.removeBody")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>{t("aiKeys.own.cancel")}</DialogClose>
						<Button variant="destructive" onClick={() => void remove()}>
							{t("aiKeys.own.remove")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
