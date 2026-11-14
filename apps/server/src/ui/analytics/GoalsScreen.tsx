import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import type { ModuleApi } from "@webcraft/module-sdk";
import type siteAnalytics from "@webcraft/module-site-analytics";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	CheckIcon,
	ClipboardListIcon,
	EllipsisIcon,
	FileTextIcon,
	LinkIcon,
	type LucideIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
	ZapIcon,
} from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { useNumbers } from "../dashboards/charts.tsx";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { ModulePageProps } from "../modules/pages.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { PageSheet } from "../shell/page.tsx";
import { cellClass, headClass, headRowClass, lastThirtyDays, TableFrame } from "./parts.tsx";

/** Site analytics' procedures, as the admin calls them (`m.site-analytics.…`). */
export function analyticsApi(api: ApiClient): ModuleApi<typeof siteAnalytics> {
	return (api as unknown as { m: Record<string, ModuleApi<typeof siteAnalytics>> }).m["site-analytics"] as ModuleApi<
		typeof siteAnalytics
	>;
}

type Answer<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;
export type GoalView = Answer<ModuleApi<typeof siteAnalytics>["goals"]["list"]>["goals"][number];
type Definition = GoalView["definition"];

/**
 * What Site › Goals shows: the Site's Goals, its Forms (a Goal can count one's Submissions), and how
 * many times each Goal was reached in the last 30 days, by name (null when it could not be counted).
 */
export type GoalsData = {
	goals: GoalView[];
	forms: { id: string; name: string }[];
	reached: Record<string, number> | null;
};

export async function goalsData(siteId: string): Promise<GoalsData> {
	const api = await getApi();
	const analytics = analyticsApi(api);
	const [{ goals }, { forms }] = await Promise.all([analytics.goals.list({ siteId }), api.forms.list({ siteId })]);
	// The Dashboard's default range: the last 30 days. The list still shows when it can't be counted.
	const reached =
		goals.length === 0
			? {}
			: await analytics.stats.goals({ siteId, ...lastThirtyDays() }).then(
					(counted) => Object.fromEntries(counted.goals.map((goal) => [goal.name, goal.conversions])),
					() => null,
				);
	return { goals, forms: forms.map(({ id, name }) => ({ id, name })), reached };
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

/** What a Goal counts, in words: its kind, then what it watches ("A Form is sent · Contact"). */
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
					{ path: definition.path },
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
 * link, or a custom event, with how often each was reached in the last 30 days. Goals count visitors
 * who accepted Analytics only. Adding and changing one is a sheet over the page; Widgets, Dashboard
 * templates and Workspace Dashboards find Goals by name.
 */
export function GoalsScreen({ place, data }: ModulePageProps) {
	const t = useT();
	const numbers = useNumbers();
	const siteId = place.level === "site" ? place.site.id : "";
	const shown = (data ?? null) as GoalsData | null;
	const describe = useDescribeGoal(shown?.forms ?? []);
	const addButton = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState<{ goal: GoalView | null; from: RefObject<HTMLElement | null> } | null>(null);
	const [deleting, setDeleting] = useState<{ goal: GoalView; from: RefObject<HTMLElement | null> } | null>(null);
	if (!shown)
		return <PageHeader heading={t("analyticsGoals.goalsHeading")}>{t("analyticsGoals.goalsIntro")}</PageHeader>;
	const reached = shown.reached;
	const most = Math.max(1, ...Object.values(reached ?? {}));
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
			<TableFrame>
				<Table aria-label={t("analyticsGoals.goalsHeading")} className="min-w-160 table-fixed">
					<colgroup>
						<col className="w-[30%]" />
						<col />
						{reached ? <col className="w-40" /> : null}
						<col className="w-14" />
					</colgroup>
					<TableHeader>
						<TableRow className={headRowClass}>
							<TableHead scope="col" className={headClass}>
								{t("analyticsGoals.name")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("analyticsGoals.counts")}
							</TableHead>
							{reached ? (
								<TableHead scope="col" className={headClass}>
									{t("analyticsGoals.reached")}
								</TableHead>
							) : null}
							<TableHead scope="col" className={headClass}>
								<span className="sr-only">{t("analyticsGoals.actions")}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{shown.goals.length === 0 ? (
							<TableRow className="hover:bg-transparent">
								<TableCell
									colSpan={reached ? 4 : 3}
									className="text-muted-foreground px-4 py-8 text-center whitespace-normal"
								>
									{t("analyticsGoals.noGoals")}
								</TableCell>
							</TableRow>
						) : (
							shown.goals.map((goal) => {
								const count = reached?.[goal.name] ?? 0;
								return (
									<TableRow key={goal.id}>
										<TableCell className={cn(cellClass, "truncate font-medium")} title={goal.name}>
											{goal.name}
										</TableCell>
										<TableCell
											className={cn(cellClass, "text-muted-foreground truncate")}
											title={describe(goal.definition)}
										>
											{describe(goal.definition)}
										</TableCell>
										{reached ? (
											<TableCell className={cellClass}>
												<span className="flex items-center gap-2">
													<span className="font-medium tabular-nums">{numbers.count(count)}</span>
													<span aria-hidden="true" className="bg-muted flex h-1.5 w-12 overflow-hidden rounded-[3px]">
														<span
															className="block h-full rounded-[3px]"
															style={{
																width: `${Math.max(count > 0 ? 6 : 0, (count / most) * 100)}%`,
																background: "var(--series-1)",
															}}
														/>
													</span>
												</span>
											</TableCell>
										) : null}
										<TableCell className={cn(cellClass, "text-end")}>
											<RowMenu
												label={t("analyticsGoals.actionsOf", { name: goal.name })}
												onEdit={(from) => setEditing({ goal, from })}
												onDelete={(from) => setDeleting({ goal, from })}
											/>
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</TableFrame>
			{editing ? (
				<GoalSheet
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

const KINDS: readonly { kind: Definition["kind"]; icon: LucideIcon }[] = [
	{ kind: "form", icon: ClipboardListIcon },
	{ kind: "page", icon: FileTextIcon },
	{ kind: "link", icon: LinkIcon },
	{ kind: "event", icon: ZapIcon },
];
const LINK_KINDS = ["outbound", "download", "tel", "mailto"] as const;

/**
 * "What counts": the four kinds of Goal as cards, one chosen. They are a radio group: the arrow keys
 * move between them, and the chosen one shows its check and an outline in the accent.
 */
function KindCards({
	id,
	value,
	onChange,
}: {
	id: string;
	value: Definition["kind"];
	onChange: (kind: Definition["kind"]) => void;
}) {
	const t = useT();
	return (
		<FieldSet className="gap-2">
			<FieldLegend variant="label" className="mb-0">
				{t("analyticsGoals.kind")}
			</FieldLegend>
			{KINDS.map(({ kind, icon: Icon }) => {
				const chosen = kind === value;
				return (
					<label
						key={kind}
						htmlFor={`${id}-${kind}`}
						data-chosen={chosen ? "true" : undefined}
						className={cn(
							"flex h-12 cursor-pointer items-center gap-2.5 rounded-[10px] border px-3.5 text-sm transition-colors duration-150 ease-in-out",
							"has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-3",
							chosen ? "bg-accent border-primary outline-primary font-medium outline outline-1" : "hover:bg-muted/60",
						)}
					>
						<input
							type="radio"
							id={`${id}-${kind}`}
							name={`${id}-kind`}
							value={kind}
							checked={chosen}
							onChange={() => onChange(kind)}
							className="sr-only"
						/>
						<Icon
							aria-hidden="true"
							className={cn("size-4 shrink-0", chosen ? "text-primary" : "text-muted-foreground")}
						/>
						<span className="min-w-0 flex-1 truncate">{t(`analyticsGoals.kinds.${kind}`)}</span>
						{chosen ? <CheckIcon aria-hidden="true" className="text-primary size-4 shrink-0" /> : null}
					</label>
				);
			})}
		</FieldSet>
	);
}

/** Add Goal, or a Goal changed: its name, what counts (four cards), then that kind's one or two fields. */
function GoalSheet({
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
	const [kind, setKind] = useState<Definition["kind"]>(start?.kind ?? (forms.length > 0 ? "form" : "page"));
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
	const detailInvalid = problem?.field === "detail" ? true : undefined;
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={goal ? t("analyticsGoals.editGoalTitle", { name: goal.name }) : t("analyticsGoals.addGoal")}
			description={goal ? t("analyticsGoals.goalDialogIntro") : undefined}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-95"
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("analyticsGoals.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy}>
						{goal ? t("analyticsGoals.save") : t("analyticsGoals.addGoal")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={save} noValidate>
				<FieldGroup className="gap-5">
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
					<KindCards id={id} value={kind} onChange={setKind} />
					{kind === "form" ? (
						forms.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("analyticsGoals.noForms")}</p>
						) : (
							<Field data-invalid={detailInvalid}>
								<FieldLabel htmlFor={`${id}-form`}>{t("analyticsGoals.form")}</FieldLabel>
								<NativeSelect
									id={`${id}-form`}
									className="w-full"
									value={formId}
									onChange={(change) => setFormId(change.target.value)}
									aria-describedby={`${id}-form-help`}
								>
									{forms.map((form) => (
										<NativeSelectOption key={form.id} value={form.id}>
											{form.name}
										</NativeSelectOption>
									))}
								</NativeSelect>
								<FieldDescription id={`${id}-form-help`}>{t("analyticsGoals.formHelp")}</FieldDescription>
							</Field>
						)
					) : null}
					{kind === "page" ? (
						<>
							<Field data-invalid={detailInvalid}>
								<FieldLabel htmlFor={`${id}-path`}>{t("analyticsGoals.path")}</FieldLabel>
								<Input
									id={`${id}-path`}
									value={path}
									maxLength={1000}
									className="font-mono"
									spellCheck={false}
									onChange={(change) => setPath(change.target.value)}
									aria-invalid={detailInvalid}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-match`}>{t("analyticsGoals.match")}</FieldLabel>
								<NativeSelect
									id={`${id}-match`}
									className="w-full"
									value={match}
									onChange={(change) => setMatch(change.target.value === "prefix" ? "prefix" : "exact")}
								>
									<NativeSelectOption value="exact">{t("analyticsGoals.matchExact")}</NativeSelectOption>
									<NativeSelectOption value="prefix">{t("analyticsGoals.matchPrefix")}</NativeSelectOption>
								</NativeSelect>
							</Field>
						</>
					) : null}
					{kind === "link" ? (
						<>
							<Field>
								<FieldLabel htmlFor={`${id}-link`}>{t("analyticsGoals.link")}</FieldLabel>
								<NativeSelect
									id={`${id}-link`}
									className="w-full"
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
						</>
					) : null}
					{kind === "event" ? (
						<Field data-invalid={detailInvalid}>
							<FieldLabel htmlFor={`${id}-event`}>{t("analyticsGoals.event")}</FieldLabel>
							<Input
								id={`${id}-event`}
								value={event}
								maxLength={100}
								className="font-mono"
								spellCheck={false}
								onChange={(change) => setEvent(change.target.value)}
								aria-invalid={detailInvalid}
								aria-describedby={`${id}-event-help`}
							/>
							<FieldDescription id={`${id}-event-help`}>{t("analyticsGoals.eventHelp")}</FieldDescription>
						</Field>
					) : null}
					{problem && problem.field !== "name" ? <FieldError>{t(problem.message)}</FieldError> : null}
				</FieldGroup>
			</form>
		</PageSheet>
	);
}

/**
 * Deleting Structure takes two steps: the dialog first asks what would go (and whether it may go at
 * all), then deletes with the confirmation it was given. It names the thing, and focus starts on Cancel.
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
	const cancel = useRef<HTMLButtonElement>(null);
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
			<DialogContent closeLabel={t("analyticsGoals.close")} initialFocus={cancel} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{words.title}</DialogTitle>
					<DialogDescription>{refused ? t(refused, { name }) : words.intro}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose ref={cancel} render={<Button variant="outline" />}>
						{t("analyticsGoals.cancel")}
					</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy || !confirmation || refused !== null}>
						{t("analyticsGoals.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
