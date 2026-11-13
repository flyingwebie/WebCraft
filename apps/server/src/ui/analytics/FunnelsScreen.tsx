import { useRouter } from "@tanstack/react-router";
import type { ModuleApi } from "@webcraft/module-sdk";
import type siteAnalytics from "@webcraft/module-site-analytics";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent } from "@webcraft/ui/components/card.tsx";
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
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useAfterRender } from "../after-render.ts";

import { getApi } from "../api.ts";
import { Announcer } from "../content/reorder.tsx";
import { type MessageKey, useT } from "../i18n.tsx";
import type { ModulePageProps } from "../modules/pages.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { analyticsApi, analyticsProblem, DeleteDialog, type GoalView, RowMenu } from "./GoalsScreen.tsx";

type Answer<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;
type FunnelView = Answer<ModuleApi<typeof siteAnalytics>["funnels"]["list"]>["funnels"][number];

/** What Site › Funnels shows: the Site's Funnels, and its Goals (a step can be one). */
export type FunnelsData = { funnels: FunnelView[]; goals: GoalView[] };

export async function funnelsData(siteId: string): Promise<FunnelsData> {
	const api = analyticsApi(await getApi());
	const [{ funnels }, { goals }] = await Promise.all([api.funnels.list({ siteId }), api.goals.list({ siteId })]);
	return { funnels, goals };
}

/**
 * Site › Funnels (Site analytics' page, Staff only: Funnels are Structure): two to five steps, each
 * one of the Site's Goals or a page visit, counted per visitor within one day.
 */
export function FunnelsScreen({ place, data }: ModulePageProps) {
	const t = useT();
	const siteId = place.level === "site" ? place.site.id : "";
	const shown = (data ?? null) as FunnelsData | null;
	const addButton = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState<{ funnel: FunnelView | null; from: RefObject<HTMLElement | null> } | null>(
		null,
	);
	const [deleting, setDeleting] = useState<{ funnel: FunnelView; from: RefObject<HTMLElement | null> } | null>(null);
	if (!shown)
		return <PageHeader heading={t("analyticsGoals.funnelsHeading")}>{t("analyticsGoals.funnelsIntro")}</PageHeader>;
	return (
		<>
			<PageHeader
				heading={t("analyticsGoals.funnelsHeading")}
				action={
					<Button ref={addButton} onClick={() => setEditing({ funnel: null, from: addButton })}>
						<PlusIcon aria-hidden="true" />
						{t("analyticsGoals.addFunnel")}
					</Button>
				}
			>
				{t("analyticsGoals.funnelsIntro")}
			</PageHeader>
			<Card className="max-w-5xl">
				<CardContent className="grid gap-4">
					{shown.funnels.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("analyticsGoals.noFunnels")}</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("analyticsGoals.name")}</TableHead>
									<TableHead>{t("analyticsGoals.steps")}</TableHead>
									<TableHead>
										<span className="sr-only">{t("analyticsGoals.actions")}</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{shown.funnels.map((funnel) => (
									<TableRow key={funnel.id}>
										<TableCell className="font-medium break-words whitespace-normal">{funnel.name}</TableCell>
										<TableCell className="text-sm whitespace-normal">
											<ol className="flex flex-wrap gap-x-2 gap-y-1">
												{funnel.steps.map((step, index) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: a Funnel's steps are in a fixed order.
													<li key={index} className="break-all">
														{index > 0 ? (
															<span aria-hidden="true" className="text-muted-foreground me-2 rtl:rotate-180">
																→
															</span>
														) : null}
														{step.label}
													</li>
												))}
											</ol>
										</TableCell>
										<TableCell className="text-end">
											<RowMenu
												label={t("analyticsGoals.actionsOf", { name: funnel.name })}
												onEdit={(from) => setEditing({ funnel, from })}
												onDelete={(from) => setDeleting({ funnel, from })}
											/>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					<p className="text-muted-foreground text-sm">{t("analyticsGoals.formStepNote")}</p>
				</CardContent>
			</Card>
			{editing ? (
				<FunnelDialog
					siteId={siteId}
					funnel={editing.funnel}
					goals={shown.goals}
					onClose={() => setEditing(null)}
					finalFocus={editing.from}
				/>
			) : null}
			{deleting ? (
				<DeleteDialog
					name={deleting.funnel.name}
					finalFocus={deleting.from}
					onClose={() => setDeleting(null)}
					ask={async (confirmation) => {
						const answer = await analyticsApi(await getApi()).funnels.delete({
							siteId,
							funnelId: deleting.funnel.id,
							confirmation,
						});
						return answer.deleted ? null : answer.confirmation.id;
					}}
					words={{
						title: t("analyticsGoals.deleteFunnelTitle", { name: deleting.funnel.name }),
						intro: t("analyticsGoals.deleteFunnelIntro"),
						done: t("analyticsGoals.funnelDeletedToast", { name: deleting.funnel.name }),
					}}
				/>
			) : null}
		</>
	);
}

/** A step as the dialog edits it: a Goal (by id) or a page visit. */
type StepDraft = { key: number; kind: "goal" | "page"; goalId: string; path: string; match: "exact" | "prefix" };

let keys = 0;
const draftOf = (step?: FunnelView["steps"][number], goals: readonly GoalView[] = []): StepDraft => ({
	key: ++keys,
	kind: step?.kind ?? "page",
	goalId: step?.kind === "goal" ? step.goalId : (goals[0]?.id ?? ""),
	path: step?.kind === "page" ? step.path : "/",
	match: step?.kind === "page" ? step.match : "exact",
});

function FunnelDialog({
	siteId,
	funnel,
	goals,
	onClose,
	finalFocus,
}: {
	siteId: string;
	funnel: FunnelView | null;
	goals: GoalView[];
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const afterRender = useAfterRender();
	const [name, setName] = useState(funnel?.name ?? "");
	const [steps, setSteps] = useState<StepDraft[]>(
		funnel ? funnel.steps.map((step) => draftOf(step, goals)) : [draftOf(undefined, goals), draftOf(undefined, goals)],
	);
	const [announcement, setAnnouncement] = useState("");
	const [problem, setProblem] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const change = (key: number, patch: Partial<StepDraft>) =>
		setSteps((before) => before.map((step) => (step.key === key ? { ...step, ...patch } : step)));
	const moveStep = (index: number, by: -1 | 1) => {
		const to = index + by;
		if (to < 0 || to >= steps.length) return;
		const next = [...steps];
		const [moved] = next.splice(index, 1);
		if (moved) next.splice(to, 0, moved);
		setSteps(next);
		setAnnouncement(t("analyticsGoals.stepMoved", { n: to + 1, count: next.length }));
		// Focus stays with the step's own button where it went.
		afterRender(() => document.getElementById(`${id}-${moved?.key}-${by < 0 ? "up" : "down"}`)?.focus());
	};
	const save = async (submitted: FormEvent) => {
		submitted.preventDefault();
		if (!name.trim()) return setProblem("analyticsGoals.nameRequired");
		if (steps.some((step) => (step.kind === "goal" ? !step.goalId : !step.path.trim().startsWith("/")))) {
			return setProblem("analyticsGoals.stepsIncomplete");
		}
		setBusy(true);
		setProblem(null);
		const made = steps.map((step) =>
			step.kind === "goal"
				? { kind: "goal" as const, goalId: step.goalId }
				: { kind: "page" as const, path: step.path.trim(), match: step.match },
		);
		try {
			const api = analyticsApi(await getApi());
			if (funnel) await api.funnels.update({ siteId, funnelId: funnel.id, name: name.trim(), steps: made });
			else await api.funnels.create({ siteId, name: name.trim(), steps: made });
			toast.success(t("analyticsGoals.funnelSavedToast", { name: name.trim() }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			setProblem(analyticsProblem(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("analyticsGoals.close")} finalFocus={finalFocus} className="sm:max-w-2xl">
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>
							{funnel ? t("analyticsGoals.editFunnelTitle", { name: funnel.name }) : t("analyticsGoals.addFunnelTitle")}
						</DialogTitle>
						<DialogDescription>{t("analyticsGoals.funnelDialogIntro")}</DialogDescription>
					</DialogHeader>
					<Announcer message={announcement} />
					<FieldGroup className="my-6 max-h-[60vh] gap-5 overflow-y-auto pe-1">
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("analyticsGoals.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={100}
								required
								autoFocus
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>
						<ol className="grid gap-4">
							{steps.map((step, index) => (
								<li key={step.key}>
									<FieldSet className="rounded-lg border p-4">
										<FieldLegend variant="label">{t("analyticsGoals.stepN", { n: index + 1 })}</FieldLegend>
										<div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
											<Field>
												<FieldLabel htmlFor={`${id}-${step.key}-kind`}>{t("analyticsGoals.stepKind")}</FieldLabel>
												<NativeSelect
													id={`${id}-${step.key}-kind`}
													value={step.kind}
													onChange={(event) =>
														change(step.key, { kind: event.target.value === "goal" ? "goal" : "page" })
													}
												>
													<NativeSelectOption value="page">{t("analyticsGoals.stepPage")}</NativeSelectOption>
													<NativeSelectOption value="goal" disabled={goals.length === 0}>
														{t("analyticsGoals.stepGoal")}
													</NativeSelectOption>
												</NativeSelect>
											</Field>
											{step.kind === "goal" ? (
												<Field>
													<FieldLabel htmlFor={`${id}-${step.key}-goal`}>{t("analyticsGoals.goal")}</FieldLabel>
													<NativeSelect
														id={`${id}-${step.key}-goal`}
														value={step.goalId}
														onChange={(event) => change(step.key, { goalId: event.target.value })}
													>
														{goals.map((goal) => (
															<NativeSelectOption key={goal.id} value={goal.id}>
																{goal.name}
															</NativeSelectOption>
														))}
													</NativeSelect>
												</Field>
											) : (
												<div className="grid gap-4 sm:grid-cols-2">
													<Field>
														<FieldLabel htmlFor={`${id}-${step.key}-path`}>{t("analyticsGoals.path")}</FieldLabel>
														<Input
															id={`${id}-${step.key}-path`}
															value={step.path}
															maxLength={1000}
															className="font-mono"
															spellCheck={false}
															onChange={(event) => change(step.key, { path: event.target.value })}
														/>
													</Field>
													<Field>
														<FieldLabel htmlFor={`${id}-${step.key}-match`}>{t("analyticsGoals.match")}</FieldLabel>
														<NativeSelect
															id={`${id}-${step.key}-match`}
															value={step.match}
															onChange={(event) =>
																change(step.key, { match: event.target.value === "prefix" ? "prefix" : "exact" })
															}
														>
															<NativeSelectOption value="exact">{t("analyticsGoals.matchExact")}</NativeSelectOption>
															<NativeSelectOption value="prefix">{t("analyticsGoals.matchPrefix")}</NativeSelectOption>
														</NativeSelect>
													</Field>
												</div>
											)}
										</div>
										<div className="flex flex-wrap gap-2">
											<Button
												id={`${id}-${step.key}-up`}
												type="button"
												variant="outline"
												size="sm"
												disabled={index === 0}
												onClick={() => moveStep(index, -1)}
												aria-label={t("analyticsGoals.moveUp", { n: index + 1 })}
											>
												<ArrowUpIcon aria-hidden="true" />
											</Button>
											<Button
												id={`${id}-${step.key}-down`}
												type="button"
												variant="outline"
												size="sm"
												disabled={index === steps.length - 1}
												onClick={() => moveStep(index, 1)}
												aria-label={t("analyticsGoals.moveDown", { n: index + 1 })}
											>
												<ArrowDownIcon aria-hidden="true" />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={steps.length <= 2}
												onClick={() => {
													setSteps((before) => before.filter((each) => each.key !== step.key));
													setAnnouncement(t("analyticsGoals.stepRemoved", { n: index + 1 }));
												}}
											>
												<XIcon aria-hidden="true" />
												{t("analyticsGoals.removeStep", { n: index + 1 })}
											</Button>
										</div>
									</FieldSet>
								</li>
							))}
						</ol>
						<div>
							<Button
								type="button"
								variant="outline"
								disabled={steps.length >= 5}
								onClick={() => {
									setSteps((before) => [...before, draftOf(undefined, goals)]);
									setAnnouncement(t("analyticsGoals.stepAdded", { n: steps.length + 1 }));
								}}
							>
								<PlusIcon aria-hidden="true" />
								{t("analyticsGoals.addStep")}
							</Button>
							<FieldDescription className="mt-2">{t("analyticsGoals.stepsHelp")}</FieldDescription>
						</div>
						{problem ? <FieldError>{t(problem)}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("analyticsGoals.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("analyticsGoals.save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
