import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
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
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { EllipsisIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { ModulePageProps } from "../modules/pages.tsx";
import { PageHeader } from "../PageHeader.tsx";

/** Site analytics' procedures, as the admin calls them (`m.site-analytics.…`). */
export function analyticsApi(api: ApiClient): ModuleApi<typeof siteAnalytics> {
	return (api as unknown as { m: Record<string, ModuleApi<typeof siteAnalytics>> }).m["site-analytics"] as ModuleApi<
		typeof siteAnalytics
	>;
}

type Answer<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;
export type GoalView = Answer<ModuleApi<typeof siteAnalytics>["goals"]["list"]>["goals"][number];
type Definition = GoalView["definition"];

/** What Site › Goals shows: the Site's Goals, and its Forms (a Goal can count one's Submissions). */
export type GoalsData = { goals: GoalView[]; forms: { id: string; name: string }[] };

export async function goalsData(siteId: string): Promise<GoalsData> {
	const api = await getApi();
	const [{ goals }, { forms }] = await Promise.all([
		analyticsApi(api).goals.list({ siteId }),
		api.forms.list({ siteId }),
	]);
	return { goals, forms: forms.map(({ id, name }) => ({ id, name })) };
}

/** A refusal of Site analytics', in the admin's words. */
export function analyticsProblem(failure: unknown): MessageKey {
	if (errorCode(failure) !== "MODULE_ERROR") return errorMessage(failure);
	const code = (failure as { data?: { code?: string } }).data?.code ?? "";
	switch (code) {
		case "GOAL_NAME_TAKEN":
		case "GOAL_IN_FUNNEL":
		case "GOALS_TOO_MANY":
		case "GOAL_NOT_FOUND":
		case "FUNNEL_NAME_TAKEN":
		case "FUNNEL_STEP_INVALID":
		case "FUNNELS_TOO_MANY":
		case "FUNNEL_NOT_FOUND":
			return `analyticsGoals.problems.${code}`;
		default:
			return "errors.generic";
	}
}

/** What a Goal counts, in words. */
export function useDescribeGoal(forms: readonly { id: string; name: string }[]) {
	const t = useT();
	return (definition: Definition): string => {
		switch (definition.kind) {
			case "form":
				return t("analyticsGoals.describe.form", {
					form: forms.find((form) => form.id === definition.formId)?.name ?? t("analyticsGoals.unknownForm"),
				});
			case "page":
				return t(
					definition.match === "prefix" ? "analyticsGoals.describe.pagePrefix" : "analyticsGoals.describe.page",
					{
						path: definition.path,
					},
				);
			case "link":
				return definition.target
					? t("analyticsGoals.describe.linkTo", {
							link: t(`analyticsGoals.linkKinds.${definition.link}`),
							target: definition.target,
						})
					: t("analyticsGoals.describe.link", { link: t(`analyticsGoals.linkKinds.${definition.link}`) });
			case "event":
				return t("analyticsGoals.describe.event", { event: definition.event });
		}
	};
}

/**
 * Site › Goals (Site analytics' page, Staff only: Goals are Structure): what counts as a result on
 * the Site, each a Form Submission, a page visit, a click on an outbound, download, phone or email
 * link, or a custom event. Goals count visitors who accepted Analytics only. Widgets, Dashboard
 * templates and Workspace Dashboards find Goals by name.
 */
export function GoalsScreen({ place, data }: ModulePageProps) {
	const t = useT();
	const siteId = place.level === "site" ? place.site.id : "";
	const shown = (data ?? null) as GoalsData | null;
	const describe = useDescribeGoal(shown?.forms ?? []);
	const addButton = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState<{ goal: GoalView | null; from: RefObject<HTMLElement | null> } | null>(null);
	const [deleting, setDeleting] = useState<{ goal: GoalView; from: RefObject<HTMLElement | null> } | null>(null);
	if (!shown)
		return <PageHeader heading={t("analyticsGoals.goalsHeading")}>{t("analyticsGoals.goalsIntro")}</PageHeader>;
	return (
		<>
			<PageHeader
				heading={t("analyticsGoals.goalsHeading")}
				action={
					<Button ref={addButton} onClick={() => setEditing({ goal: null, from: addButton })}>
						<PlusIcon aria-hidden="true" />
						{t("analyticsGoals.addGoal")}
					</Button>
				}
			>
				{t("analyticsGoals.goalsIntro")}
			</PageHeader>
			<Card className="max-w-5xl">
				<CardContent>
					{shown.goals.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("analyticsGoals.noGoals")}</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("analyticsGoals.name")}</TableHead>
									<TableHead>{t("analyticsGoals.counts")}</TableHead>
									<TableHead>
										<span className="sr-only">{t("analyticsGoals.actions")}</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{shown.goals.map((goal) => (
									<TableRow key={goal.id}>
										<TableCell className="font-medium break-words whitespace-normal">{goal.name}</TableCell>
										<TableCell className="text-sm break-all whitespace-normal">{describe(goal.definition)}</TableCell>
										<TableCell className="text-end">
											<RowMenu
												label={t("analyticsGoals.actionsOf", { name: goal.name })}
												onEdit={(from) => setEditing({ goal, from })}
												onDelete={(from) => setDeleting({ goal, from })}
											/>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
			{editing ? (
				<GoalDialog
					siteId={siteId}
					goal={editing.goal}
					forms={shown.forms}
					onClose={() => setEditing(null)}
					finalFocus={editing.from}
				/>
			) : null}
			{deleting ? (
				<DeleteDialog
					name={deleting.goal.name}
					finalFocus={deleting.from}
					onClose={() => setDeleting(null)}
					ask={async (confirmation) => {
						const answer = await analyticsApi(await getApi()).goals.delete({
							siteId,
							goalId: deleting.goal.id,
							confirmation,
						});
						return answer.deleted ? null : answer.confirmation.id;
					}}
					words={{
						title: t("analyticsGoals.deleteGoalTitle", { name: deleting.goal.name }),
						intro: t("analyticsGoals.deleteGoalIntro"),
						done: t("analyticsGoals.goalDeletedToast", { name: deleting.goal.name }),
					}}
				/>
			) : null}
		</>
	);
}

/** A row's menu: Edit and Delete. */
export function RowMenu({
	label,
	onEdit,
	onDelete,
}: {
	label: string;
	onEdit: (from: RefObject<HTMLElement | null>) => void;
	onDelete: (from: RefObject<HTMLElement | null>) => void;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger ref={trigger} render={<Button variant="ghost" size="icon-sm" aria-label={label} />}>
				<EllipsisIcon aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-auto min-w-40">
				<DropdownMenuItem onClick={() => onEdit(trigger)}>
					<PencilIcon aria-hidden="true" />
					{t("analyticsGoals.edit")}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onClick={() => onDelete(trigger)}>
					<TrashIcon aria-hidden="true" />
					{t("analyticsGoals.delete")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const KINDS = ["form", "page", "link", "event"] as const;
const LINK_KINDS = ["outbound", "download", "tel", "mailto"] as const;

function GoalDialog({
	siteId,
	goal,
	forms,
	onClose,
	finalFocus,
}: {
	siteId: string;
	goal: GoalView | null;
	forms: { id: string; name: string }[];
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const start = goal?.definition;
	const [name, setName] = useState(goal?.name ?? "");
	const [kind, setKind] = useState<Definition["kind"]>(start?.kind ?? "page");
	const [formId, setFormId] = useState(start?.kind === "form" ? start.formId : (forms[0]?.id ?? ""));
	const [path, setPath] = useState(start?.kind === "page" ? start.path : "/");
	const [match, setMatch] = useState<"exact" | "prefix">(start?.kind === "page" ? start.match : "exact");
	const [link, setLink] = useState<(typeof LINK_KINDS)[number]>(start?.kind === "link" ? start.link : "outbound");
	const [target, setTarget] = useState(start?.kind === "link" ? start.target : "");
	const [event, setEvent] = useState(start?.kind === "event" ? start.event : "");
	const [problem, setProblem] = useState<{ field: "name" | "detail" | null; message: MessageKey } | null>(null);
	const [busy, setBusy] = useState(false);
	const definition = (): Definition | null => {
		switch (kind) {
			case "form":
				return formId ? { kind, formId } : null;
			case "page":
				return path.trim().startsWith("/") ? { kind, path: path.trim(), match } : null;
			case "link":
				return { kind, link, target: target.trim() };
			case "event":
				return event.trim() ? { kind, event: event.trim() } : null;
		}
	};
	const save = async (submitted: FormEvent) => {
		submitted.preventDefault();
		if (!name.trim()) return setProblem({ field: "name", message: "analyticsGoals.nameRequired" });
		const made = definition();
		if (!made) return setProblem({ field: "detail", message: `analyticsGoals.detailRequired.${kind}` });
		setBusy(true);
		setProblem(null);
		try {
			const api = analyticsApi(await getApi());
			if (goal) await api.goals.update({ siteId, goalId: goal.id, name: name.trim(), definition: made });
			else await api.goals.create({ siteId, name: name.trim(), definition: made });
			toast.success(t("analyticsGoals.goalSavedToast", { name: name.trim() }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			const message = analyticsProblem(failure);
			setProblem({ field: message === "analyticsGoals.problems.GOAL_NAME_TAKEN" ? "name" : null, message });
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("analyticsGoals.close")} finalFocus={finalFocus} className="sm:max-w-xl">
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>
							{goal ? t("analyticsGoals.editGoalTitle", { name: goal.name }) : t("analyticsGoals.addGoalTitle")}
						</DialogTitle>
						<DialogDescription>{t("analyticsGoals.goalDialogIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-5">
						<Field data-invalid={problem?.field === "name" ? true : undefined}>
							<FieldLabel htmlFor={`${id}-name`}>{t("analyticsGoals.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={100}
								required
								autoFocus
								onChange={(change) => setName(change.target.value)}
								aria-invalid={problem?.field === "name" ? true : undefined}
								aria-describedby={problem?.field === "name" ? `${id}-name-error` : undefined}
							/>
							{problem?.field === "name" ? <FieldError id={`${id}-name-error`}>{t(problem.message)}</FieldError> : null}
						</Field>
						<FieldSet>
							<FieldLegend variant="label">{t("analyticsGoals.kind")}</FieldLegend>
							<RadioGroup value={kind} onValueChange={(value) => setKind(value as Definition["kind"])}>
								{KINDS.map((each) => (
									<Field key={each} orientation="horizontal">
										<RadioGroupItem value={each} id={`${id}-${each}`} />
										<FieldLabel htmlFor={`${id}-${each}`} className="font-normal">
											{t(`analyticsGoals.kinds.${each}`)}
										</FieldLabel>
									</Field>
								))}
							</RadioGroup>
						</FieldSet>
						{kind === "form" ? (
							forms.length === 0 ? (
								<p className="text-muted-foreground text-sm">{t("analyticsGoals.noForms")}</p>
							) : (
								<Field>
									<FieldLabel htmlFor={`${id}-form`}>{t("analyticsGoals.form")}</FieldLabel>
									<NativeSelect id={`${id}-form`} value={formId} onChange={(change) => setFormId(change.target.value)}>
										{forms.map((form) => (
											<NativeSelectOption key={form.id} value={form.id}>
												{form.name}
											</NativeSelectOption>
										))}
									</NativeSelect>
									<FieldDescription>{t("analyticsGoals.formHelp")}</FieldDescription>
								</Field>
							)
						) : null}
						{kind === "page" ? (
							<div className="grid gap-4 sm:grid-cols-2">
								<Field>
									<FieldLabel htmlFor={`${id}-path`}>{t("analyticsGoals.path")}</FieldLabel>
									<Input
										id={`${id}-path`}
										value={path}
										maxLength={1000}
										className="font-mono"
										spellCheck={false}
										onChange={(change) => setPath(change.target.value)}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${id}-match`}>{t("analyticsGoals.match")}</FieldLabel>
									<NativeSelect
										id={`${id}-match`}
										value={match}
										onChange={(change) => setMatch(change.target.value === "prefix" ? "prefix" : "exact")}
									>
										<NativeSelectOption value="exact">{t("analyticsGoals.matchExact")}</NativeSelectOption>
										<NativeSelectOption value="prefix">{t("analyticsGoals.matchPrefix")}</NativeSelectOption>
									</NativeSelect>
								</Field>
							</div>
						) : null}
						{kind === "link" ? (
							<div className="grid gap-4">
								<Field>
									<FieldLabel htmlFor={`${id}-link`}>{t("analyticsGoals.link")}</FieldLabel>
									<NativeSelect
										id={`${id}-link`}
										value={link}
										onChange={(change) => setLink(change.target.value as (typeof LINK_KINDS)[number])}
									>
										{LINK_KINDS.map((each) => (
											<NativeSelectOption key={each} value={each}>
												{t(`analyticsGoals.linkKinds.${each}`)}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${id}-target`}>{t("analyticsGoals.target")}</FieldLabel>
									<Input
										id={`${id}-target`}
										value={target}
										maxLength={1000}
										className="font-mono"
										spellCheck={false}
										placeholder="*.pdf"
										onChange={(change) => setTarget(change.target.value)}
										aria-describedby={`${id}-target-help`}
									/>
									<FieldDescription id={`${id}-target-help`}>{t("analyticsGoals.targetHelp")}</FieldDescription>
								</Field>
							</div>
						) : null}
						{kind === "event" ? (
							<Field>
								<FieldLabel htmlFor={`${id}-event`}>{t("analyticsGoals.event")}</FieldLabel>
								<Input
									id={`${id}-event`}
									value={event}
									maxLength={100}
									className="font-mono"
									spellCheck={false}
									onChange={(change) => setEvent(change.target.value)}
									aria-describedby={`${id}-event-help`}
								/>
								<FieldDescription id={`${id}-event-help`}>{t("analyticsGoals.eventHelp")}</FieldDescription>
							</Field>
						) : null}
						{problem && problem.field !== "name" ? <FieldError>{t(problem.message)}</FieldError> : null}
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

/**
 * Deleting Structure takes two steps: the dialog first asks what would go (and whether it may go at
 * all), then deletes with the confirmation it was given.
 */
export function DeleteDialog({
	name,
	ask,
	words,
	onClose,
	finalFocus,
}: {
	name: string;
	/** Without a confirmation: asks, answering its id; with one: deletes, answering null. */
	ask: (confirmation?: string) => Promise<string | null>;
	words: { title: string; intro: string; done: string };
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const [confirmation, setConfirmation] = useState<string | null>(null);
	const [refused, setRefused] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	// Asked once, when the dialog opens.
	const asking = useRef(ask);
	useEffect(() => {
		let live = true;
		asking
			.current()
			.then((id) => live && setConfirmation(id))
			.catch((failure) => live && setRefused(analyticsProblem(failure)));
		return () => {
			live = false;
		};
	}, []);
	const remove = async () => {
		if (!confirmation) return;
		setBusy(true);
		try {
			await ask(confirmation);
			toast.success(words.done);
			onClose();
			await router.invalidate();
		} catch (failure) {
			setRefused(analyticsProblem(failure));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("analyticsGoals.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{words.title}</DialogTitle>
					<DialogDescription>{refused ? t(refused, { name }) : words.intro}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("analyticsGoals.cancel")}</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy || !confirmation || refused !== null}>
						{t("analyticsGoals.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
