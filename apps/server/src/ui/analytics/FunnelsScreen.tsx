import { useRouter } from "@tanstack/react-router";
import type { ModuleApi } from "@webcraft/module-sdk";
import type siteAnalytics from "@webcraft/module-site-analytics";
import { Button } from "@webcraft/ui/components/button.tsx";
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
import { cn } from "@webcraft/ui/lib/utils.ts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import { Announcer, DragHandle, moveItem, useAnnouncement, useDragOrder } from "../content/reorder.tsx";
import { FunnelSteps, WidgetLoading } from "../dashboards/charts.tsx";
import { type MessageKey, useT } from "../i18n.tsx";
import type { ModulePageProps } from "../modules/pages.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { PageSheet } from "../shell/page.tsx";
import { analyticsApi, analyticsProblem, DeleteDialog, type GoalView, RowMenu } from "./GoalsScreen.tsx";
import { lastThirtyDays } from "./parts.tsx";

type Answer<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;
type FunnelView = Answer<ModuleApi<typeof siteAnalytics>["funnels"]["list"]>["funnels"][number];
type StepView = FunnelView["steps"][number];

/** What Site › Funnels shows: the Site's Funnels, and its Goals (a step can be one). */
export type FunnelsData = { funnels: FunnelView[]; goals: GoalView[] };

export async function funnelsData(siteId: string): Promise<FunnelsData> {
	const api = analyticsApi(await getApi());
	const [{ funnels }, { goals }] = await Promise.all([api.funnels.list({ siteId }), api.goals.list({ siteId })]);
	return { funnels, goals };
}

/** The most steps a Funnel has. */
const MOST_STEPS = 5;
/** The fewest steps a Funnel has. */
const FEWEST_STEPS = 2;

/** A step as `funnels.update` takes it: without its label. */
function stepInput(step: StepView) {
	return step.kind === "goal"
		? { kind: "goal" as const, goalId: step.goalId }
		: { kind: "page" as const, path: step.path, match: step.match };
}

/**
 * Site › Funnels (Site analytics' page, Staff only: Funnels are Structure): the Site's Funnels on the
 * left and the open one on the right, its two to five steps (each a Goal or a page visit, counted per
 * visitor within one day) and how far visitors got in the last 30 days. Steps change in place and are
 * saved at once: dragged by their grip or moved with Up and Down from the keyboard, removed, added.
 */
export function FunnelsScreen({ place, data }: ModulePageProps) {
	const t = useT();
	const siteId = place.level === "site" ? place.site.id : "";
	const shown = (data ?? null) as FunnelsData | null;
	const newButton = useRef<HTMLButtonElement>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ funnel: FunnelView | null; from: RefObject<HTMLElement | null> } | null>(
		null,
	);
	const [deleting, setDeleting] = useState<{ funnel: FunnelView; from: RefObject<HTMLElement | null> } | null>(null);
	if (!shown)
		return <PageHeader heading={t("analyticsGoals.funnelsHeading")}>{t("analyticsGoals.funnelsIntro")}</PageHeader>;
	const open = shown.funnels.find((funnel) => funnel.id === openId) ?? shown.funnels[0] ?? null;
	return (
		<>
			<PageHeader heading={t("analyticsGoals.funnelsHeading")}>{t("analyticsGoals.funnelsIntro")}</PageHeader>
			<div className="flex flex-col gap-6 @2xl/page:flex-row @2xl/page:items-start">
				<section
					aria-label={t("analyticsGoals.funnelsHeading")}
					className="bg-card flex w-full shrink-0 flex-col gap-1 rounded-[14px] border p-2 shadow-xs @2xl/page:min-h-[calc(100svh-13.75rem)] @2xl/page:w-70"
				>
					{shown.funnels.length === 0 ? (
						<p className="text-muted-foreground p-3 text-sm">{t("analyticsGoals.noFunnels")}</p>
					) : (
						<ul className="grid gap-1">
							{shown.funnels.map((funnel) => {
								const current = funnel.id === open?.id;
								return (
									<li key={funnel.id}>
										<button
											type="button"
											aria-current={current ? "true" : undefined}
											onClick={() => setOpenId(funnel.id)}
											className={cn(
												"focus-visible:ring-ring/50 grid w-full gap-0.5 rounded-lg p-3 text-start transition-colors duration-150 ease-in-out outline-none focus-visible:ring-3",
												current ? "bg-accent" : "hover:bg-muted/60",
											)}
										>
											<span className={cn("truncate text-sm", current ? "font-semibold" : "font-medium")}>
												{funnel.name}
											</span>
											<span className="text-muted-foreground text-xs">
												{t("analyticsGoals.stepCount", { count: funnel.steps.length })}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
					<hr className="my-1" />
					<Button
						ref={newButton}
						variant="ghost"
						size="sm"
						className="justify-start"
						onClick={() => setEditing({ funnel: null, from: newButton })}
					>
						<PlusIcon aria-hidden="true" />
						{t("analyticsGoals.newFunnel")}
					</Button>
				</section>
				{open ? (
					<OpenFunnel
						key={open.id}
						siteId={siteId}
						funnel={open}
						goals={shown.goals}
						onEdit={(from) => setEditing({ funnel: open, from })}
						onDelete={(from) => setDeleting({ funnel: open, from })}
					/>
				) : null}
			</div>
			{editing ? (
				<FunnelSheet
					siteId={siteId}
					funnel={editing.funnel}
					goals={shown.goals}
					onClose={() => setEditing(null)}
					onSaved={setOpenId}
					finalFocus={editing.from}
				/>
			) : null}
			{deleting ? (
				<DeleteDialog
					name={deleting.funnel.name}
					finalFocus={newButton}
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

/** The open Funnel: its name, its steps in order, Add step, and the Funnel drawn for the last 30 days. */
function OpenFunnel({
	siteId,
	funnel,
	goals,
	onEdit,
	onDelete,
}: {
	siteId: string;
	funnel: FunnelView;
	goals: GoalView[];
	onEdit: (from: RefObject<HTMLElement | null>) => void;
	onDelete: (from: RefObject<HTMLElement | null>) => void;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const afterRender = useAfterRender();
	const addButton = useRef<HTMLButtonElement>(null);
	const rows = useRef(new Map<number, HTMLLIElement>());
	// The steps as shown: they change at once, and go back if the save is refused.
	const [steps, setSteps] = useState(funnel.steps);
	const [adding, setAdding] = useState(false);
	const [announcement, announce] = useAnnouncement();
	const [counts, setCounts] = useState<{ label: string; count: number }[] | "loading" | "failed">("loading");
	const [counted, setCounted] = useState(0);
	// Saves go one after another, in the order the changes were made; the steps follow what the
	// server answers only once none is on its way, so a quick second move is never undone on screen.
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const pending = useRef(0);
	useEffect(() => {
		if (pending.current === 0) setSteps(funnel.steps);
	}, [funnel.steps]);

	// How far visitors got in the last 30 days, counted again after each change.
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- `counted` changes after each saved change.
	useEffect(() => {
		let live = true;
		setCounts("loading");
		void getApi()
			.then((api) => analyticsApi(api).stats.funnel({ siteId, funnel: funnel.name, ...lastThirtyDays() }))
			.then(
				(answer) => live && setCounts(answer.steps.map((step) => ({ label: step.label, count: step.visitors }))),
				() => live && setCounts("failed"),
			);
		return () => {
			live = false;
		};
	}, [siteId, funnel.name, counted]);

	const save = (next: StepView[], before: StepView[]): Promise<boolean> => {
		pending.current += 1;
		const run = queue.current.then(async () => {
			try {
				await analyticsApi(await getApi()).funnels.update({
					siteId,
					funnelId: funnel.id,
					name: funnel.name,
					steps: next.map(stepInput),
				});
				return true;
			} catch (failure) {
				setSteps(before);
				toast.error(t(analyticsProblem(failure)));
				return false;
			} finally {
				pending.current -= 1;
				if (pending.current === 0) {
					setCounted((count) => count + 1);
					await router.invalidate();
				}
			}
		});
		queue.current = run;
		return run;
	};
	const move = (from: number, to: number, focus?: "up" | "down") => {
		if (to < 0 || to >= steps.length || from === to) return;
		const before = steps;
		const next = moveItem(steps, from, to);
		setSteps(next);
		announce(t("analyticsGoals.stepMoved", { n: to + 1, count: next.length }));
		// Focus stays with the step's own button where it went.
		if (focus) afterRender(() => document.getElementById(`${id}-${to}-${focus}`)?.focus());
		void save(next, before);
	};
	const remove = (index: number) => {
		const before = steps;
		const next = steps.filter((_, at) => at !== index);
		setSteps(next);
		announce(t("analyticsGoals.stepRemoved", { n: index + 1 }));
		afterRender(() => addButton.current?.focus());
		void save(next, before);
	};
	const drag = useDragOrder((from, to) => move(from, to));
	return (
		<section aria-labelledby={`${id}-name`} className="flex min-w-0 flex-1 flex-col gap-5">
			<div className="flex items-center justify-between gap-3">
				<h2 id={`${id}-name`} className="min-w-0 truncate text-lg font-semibold">
					{funnel.name}
				</h2>
				<RowMenu label={t("analyticsGoals.actionsOf", { name: funnel.name })} onEdit={onEdit} onDelete={onDelete} />
			</div>
			<Announcer message={announcement} />
			<ol aria-label={t("analyticsGoals.steps")} className="grid gap-1">
				{steps.map((step, index) => (
					<li
						// oxlint-disable-next-line react/no-array-index-key -- a step is its place in the Funnel's order.
						key={index}
						ref={(row) => {
							if (row) rows.current.set(index, row);
							else rows.current.delete(index);
						}}
						{...drag.itemProps(index)}
						className={cn(
							"group hover:bg-accent focus-within:bg-accent flex h-11 items-center gap-3 rounded-lg px-3 transition-colors duration-150 ease-in-out",
							"data-[drop-target=true]:ring-primary data-[drop-target=true]:ring-2",
							drag.dragging === index && "opacity-50",
						)}
					>
						<DragHandle {...drag.handleProps(index, () => rows.current.get(index) ?? null)} />
						<span
							aria-hidden="true"
							className="bg-muted text-muted-foreground flex size-5.5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums"
						>
							{index + 1}
						</span>
						<span className="inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-xs font-medium">
							<span className="sr-only">{t("analyticsGoals.stepN", { n: index + 1 })}: </span>
							{step.kind === "page" ? t("analyticsGoals.stepPageBadge") : t("analyticsGoals.stepGoalBadge")}
						</span>
						<span className={cn("min-w-0 flex-1 truncate text-sm", step.kind === "page" && "font-mono")}>
							{step.label}
						</span>
						<span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
							<Button
								id={`${id}-${index}-up`}
								type="button"
								variant="ghost"
								size="icon-xs"
								disabled={index === 0}
								onClick={() => move(index, index - 1, "up")}
								aria-label={t("analyticsGoals.moveUp", { n: index + 1 })}
							>
								<ArrowUpIcon aria-hidden="true" />
							</Button>
							<Button
								id={`${id}-${index}-down`}
								type="button"
								variant="ghost"
								size="icon-xs"
								disabled={index === steps.length - 1}
								onClick={() => move(index, index + 1, "down")}
								aria-label={t("analyticsGoals.moveDown", { n: index + 1 })}
							>
								<ArrowDownIcon aria-hidden="true" />
							</Button>
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground"
							disabled={steps.length <= FEWEST_STEPS}
							onClick={() => remove(index)}
							aria-label={t("analyticsGoals.removeStep", { n: index + 1 })}
						>
							<XIcon aria-hidden="true" />
						</Button>
					</li>
				))}
			</ol>
			<div className="flex flex-wrap items-center gap-2.5">
				<Button
					ref={addButton}
					type="button"
					variant="outline"
					size="sm"
					disabled={steps.length >= MOST_STEPS}
					onClick={() => setAdding(true)}
				>
					<PlusIcon aria-hidden="true" />
					{t("analyticsGoals.addStep")}
				</Button>
				<span className="text-muted-foreground text-[13px]">{t("analyticsGoals.stepsLimit")}</span>
			</div>
			<div className="grid max-w-140 gap-3">
				<h3 className="text-[13px] font-semibold">{t("analyticsGoals.lastThirtyDays")}</h3>
				{counts === "loading" ? (
					<WidgetLoading />
				) : counts === "failed" ? (
					<p className="text-muted-foreground text-sm">{t("analyticsGoals.notCounted")}</p>
				) : (
					<FunnelSteps
						data={{ shape: "funnel", steps: counts }}
						title={t("analyticsGoals.lastThirtyDaysOf", { name: funnel.name })}
					/>
				)}
			</div>
			{adding ? (
				<AddStepSheet
					goals={goals}
					finalFocus={addButton}
					onClose={() => setAdding(false)}
					onAdd={async (step) => {
						const before = steps;
						const label =
							step.kind === "page"
								? step.match === "exact"
									? step.path
									: `${step.path.replace(/\/+$/, "")}/*`
								: (goals.find((goal) => goal.id === step.goalId)?.name ?? "");
						const next = [...steps, { ...step, label } as StepView];
						setSteps(next);
						const saved = await save(next, before);
						if (saved) announce(t("analyticsGoals.stepAdded", { n: next.length }));
						return saved;
					}}
				/>
			) : null}
		</section>
	);
}

type NewStep = { kind: "goal"; goalId: string } | { kind: "page"; path: string; match: "exact" | "prefix" };

/** Add step: a page visit or one of the Site's Goals, added at the end and saved at once. */
function AddStepSheet({
	goals,
	onAdd,
	onClose,
	finalFocus,
}: {
	goals: GoalView[];
	onAdd: (step: NewStep) => Promise<boolean>;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const [draft, setDraft] = useState<StepDraft>(() => draftOf(undefined, goals));
	const [problem, setProblem] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const add = async (submitted: FormEvent) => {
		submitted.preventDefault();
		if (draft.kind === "goal" ? !draft.goalId : !draft.path.trim().startsWith("/")) {
			return setProblem("analyticsGoals.stepsIncomplete");
		}
		setBusy(true);
		const saved = await onAdd(
			draft.kind === "goal"
				? { kind: "goal", goalId: draft.goalId }
				: { kind: "page", path: draft.path.trim(), match: draft.match },
		);
		setBusy(false);
		if (saved) onClose();
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("analyticsGoals.addStep")}
			description={t("analyticsGoals.addStepIntro")}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-95"
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("analyticsGoals.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy}>
						{t("analyticsGoals.addStep")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={add} noValidate className="@container/sheet">
				<FieldGroup className="gap-5">
					<StepFields id={id} step={draft} goals={goals} onChange={(patch) => setDraft({ ...draft, ...patch })} />
					{problem ? <FieldError>{t(problem)}</FieldError> : null}
				</FieldGroup>
			</form>
		</PageSheet>
	);
}

/** A step as a sheet edits it: a Goal (by id) or a page visit. */
type StepDraft = { key: number; kind: "goal" | "page"; goalId: string; path: string; match: "exact" | "prefix" };

let keys = 0;
const draftOf = (step?: StepView, goals: readonly GoalView[] = []): StepDraft => ({
	key: ++keys,
	kind: step?.kind ?? "page",
	goalId: step?.kind === "goal" ? step.goalId : (goals[0]?.id ?? ""),
	path: step?.kind === "page" ? step.path : "/",
	match: step?.kind === "page" ? step.match : "exact",
});

/** A step's fields: what it is, then its Goal, or its path and which pages. */
function StepFields({
	id,
	step,
	goals,
	onChange,
}: {
	id: string;
	step: StepDraft;
	goals: GoalView[];
	onChange: (patch: Partial<StepDraft>) => void;
}) {
	const t = useT();
	return (
		<>
			<Field>
				<FieldLabel htmlFor={`${id}-${step.key}-kind`}>{t("analyticsGoals.stepKind")}</FieldLabel>
				<NativeSelect
					id={`${id}-${step.key}-kind`}
					className="w-full"
					value={step.kind}
					onChange={(event) => onChange({ kind: event.target.value === "goal" ? "goal" : "page" })}
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
						className="w-full"
						value={step.goalId}
						onChange={(event) => onChange({ goalId: event.target.value })}
					>
						{goals.map((goal) => (
							<NativeSelectOption key={goal.id} value={goal.id}>
								{goal.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			) : (
				<div className="grid gap-4 @md/sheet:grid-cols-2">
					<Field>
						<FieldLabel htmlFor={`${id}-${step.key}-path`}>{t("analyticsGoals.path")}</FieldLabel>
						<Input
							id={`${id}-${step.key}-path`}
							value={step.path}
							maxLength={1000}
							className="font-mono"
							spellCheck={false}
							onChange={(event) => onChange({ path: event.target.value })}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-${step.key}-match`}>{t("analyticsGoals.match")}</FieldLabel>
						<NativeSelect
							id={`${id}-${step.key}-match`}
							className="w-full"
							value={step.match}
							onChange={(event) => onChange({ match: event.target.value === "prefix" ? "prefix" : "exact" })}
						>
							<NativeSelectOption value="exact">{t("analyticsGoals.matchExact")}</NativeSelectOption>
							<NativeSelectOption value="prefix">{t("analyticsGoals.matchPrefix")}</NativeSelectOption>
						</NativeSelect>
					</Field>
				</div>
			)}
		</>
	);
}

/** New Funnel, or a Funnel changed as a whole: its name and its two to five steps, in order. */
function FunnelSheet({
	siteId,
	funnel,
	goals,
	onClose,
	onSaved,
	finalFocus,
}: {
	siteId: string;
	funnel: FunnelView | null;
	goals: GoalView[];
	onClose: () => void;
	/** The Funnel saved, by id: it opens. */
	onSaved: (funnelId: string) => void;
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
		const next = moveItem(steps, index, to);
		const moved = next[to];
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
			const saved = funnel
				? await api.funnels.update({ siteId, funnelId: funnel.id, name: name.trim(), steps: made })
				: await api.funnels.create({ siteId, name: name.trim(), steps: made });
			toast.success(t("analyticsGoals.funnelSavedToast", { name: name.trim() }));
			onSaved(saved.funnel.id);
			onClose();
			await router.invalidate();
		} catch (failure) {
			setProblem(analyticsProblem(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={funnel ? t("analyticsGoals.editFunnelTitle", { name: funnel.name }) : t("analyticsGoals.newFunnel")}
			description={t("analyticsGoals.funnelDialogIntro")}
			finalFocus={finalFocus}
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("analyticsGoals.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy}>
						{funnel ? t("analyticsGoals.save") : t("analyticsGoals.newFunnel")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={save} noValidate className="@container/sheet">
				<Announcer message={announcement} />
				<FieldGroup className="gap-5">
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
								<FieldSet className="gap-4 rounded-lg border p-4">
									<FieldLegend variant="label" className="mb-0">
										{t("analyticsGoals.stepN", { n: index + 1 })}
									</FieldLegend>
									<StepFields id={id} step={step} goals={goals} onChange={(patch) => change(step.key, patch)} />
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
											disabled={steps.length <= FEWEST_STEPS}
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
							size="sm"
							disabled={steps.length >= MOST_STEPS}
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
			</form>
		</PageSheet>
	);
}
