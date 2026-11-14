import { useRouter } from "@tanstack/react-router";
import type { AiProvider, WorkspaceAiView } from "@webcraft/core";
import { AI_MODELS, AI_PROVIDERS, knownAiPrice } from "@webcraft/core/ai-models";
import { Button } from "@webcraft/ui/components/button.tsx";
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
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../settings/form.tsx";
import { SettingsCard, StateBadge } from "../settings/layout.tsx";
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
			<SettingsForm>
				<div className="grid gap-6">
					<OwnKeyCard workspaceId={workspaceId} view={view} capInput={capInput} />
					<SettingsCard title={t("aiKeys.shared.heading")} description={t("aiKeys.shared.intro")}>
						{view.shared ? (
							<div className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border p-4">
								<LockIcon className="size-5" aria-hidden="true" />
								<div className="grid grow gap-1">
									<p className="flex flex-wrap items-center gap-2 font-medium">
										{view.shared.name}
										<StateBadge tone={view.inUse === "shared" ? "success" : "neutral"}>
											{view.inUse === "shared" ? t("aiKeys.shared.inUse") : t("aiKeys.shared.standby")}
										</StateBadge>
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
					</SettingsCard>
					<SettingsCard
						title={t("aiKeys.usage.heading", { month: view.usage.month })}
						description={t("aiKeys.usage.intro")}
					>
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
						<p className="text-muted-foreground text-sm">{t("aiKeys.usage.estimates")}</p>
					</SettingsCard>
				</div>
			</SettingsForm>
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
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const removeButton = useRef<HTMLButtonElement>(null);
	const section = useSettingsSection({
		saved: {
			provider: own?.provider ?? ("openai" as AiProvider),
			model: own?.model ?? AI_MODELS.openai[0]?.id ?? "",
			endpoint: own?.endpoint ?? "",
			key: "",
			replacing: !own,
			cap: own?.monthlyCap === null || own?.monthlyCap === undefined ? "" : String(own.monthlyCap),
			inputPrice: own?.price && !own.price.estimated ? String(own.price.input) : "",
			outputPrice: own?.price && !own.price.estimated ? String(own.price.output) : "",
			// When the key is set again, the form starts again from it.
			setAt: own?.setAt ?? null,
		},
		check: ({ model, replacing, key }) =>
			model.trim() === "" ? "aiKeys.own.modelNeeded" : replacing && key.trim() === "" ? "aiKeys.own.keyNeeded" : null,
		save: async ({ provider, model, endpoint, key, cap, inputPrice, outputPrice }) => {
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
		},
	});
	const { provider, model, endpoint, key, replacing, cap, inputPrice, outputPrice } = section.values;
	const set = section.set;
	const error = section.error;
	const estimate = knownAiPrice(provider, model.trim());

	const chooseProvider = (next: AiProvider) =>
		set({
			provider: next,
			model: AI_MODELS[next][0]?.id ?? "",
			...(next !== "openaiCompatible" ? { endpoint: "" } : {}),
			// A key never moves to another provider without being typed again.
			...(own && next !== own.provider ? { replacing: true } : {}),
		});

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
		<SettingsCard title={t("aiKeys.own.heading")} description={t("aiKeys.own.intro")}>
			<form {...section.formProps}>
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
									<Button type="button" variant="outline" onClick={() => set({ replacing: true })}>
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
									onChange={(event) => set({ key: event.target.value })}
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
								onChange={(event) => set({ model: event.target.value })}
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
								onChange={(event) => set({ cap: event.target.value })}
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
								onChange={(event) => set({ endpoint: event.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-input-price`}>{t("aiKeys.own.inputPrice")}</FieldLabel>
							<Input
								id={`${id}-input-price`}
								inputMode="decimal"
								value={inputPrice}
								onChange={(event) => set({ inputPrice: event.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-output-price`}>{t("aiKeys.own.outputPrice")}</FieldLabel>
							<Input
								id={`${id}-output-price`}
								inputMode="decimal"
								value={outputPrice}
								onChange={(event) => set({ outputPrice: event.target.value })}
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
						</div>
					</div>
				</FieldGroup>
			</form>
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
		</SettingsCard>
	);
}
