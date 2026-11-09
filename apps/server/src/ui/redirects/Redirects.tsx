import { useNavigate, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import type redirects from "@webcraft/module-redirects";
import type { MissView, RuleView } from "@webcraft/module-redirects";
import type { ModuleApi } from "@webcraft/module-sdk";
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
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { EllipsisIcon, EyeIcon, EyeOffIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { ModulePageProps } from "../modules/pages.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { Tabs } from "../Tabs.tsx";

/** The Redirects Module's procedures, as the admin calls them (`m.redirects.…`). */
function redirectsApi(api: ApiClient): ModuleApi<typeof redirects> {
	return (api as unknown as { m: { redirects: ModuleApi<typeof redirects> } }).m.redirects;
}

/** What Site › Redirects shows: the Site's rules, and its 404 log (open and ignored paths). */
export type RedirectsData = {
	rules: RuleView[];
	totalRules: number;
	misses: MissView[];
	totalMisses: number;
	ignored: MissView[];
	totalIgnored: number;
};

/** Loads Site › Redirects for a Site. */
export async function redirectsData(siteId: string): Promise<RedirectsData> {
	const api = redirectsApi(await getApi());
	const [rules, open, ignored] = await Promise.all([
		api.rules.list({ siteId }),
		api.notFound.list({ siteId }),
		api.notFound.list({ siteId, ignored: true }),
	]);
	return {
		rules: rules.rules,
		totalRules: rules.total,
		misses: open.misses,
		totalMisses: open.total,
		ignored: ignored.misses,
		totalIgnored: ignored.total,
	};
}

/** A rule being added or changed: a new one (perhaps from a path of the 404 log), or one of the Site's. */
type Editing = { rule: RuleView } | { from: string } | null;

/**
 * Site › Redirects (the Redirects and 404 log Module's page, for Editors, Owners and Staff): the
 * Site's Redirect rules, added by people or automatically when a published path changed, and the
 * 404 log of paths visitors asked for that have no page, each with Add redirect and Ignore. Rules are
 * Content without a Draft: a change applies as soon as it is saved.
 */
export function RedirectsScreen({ place, data, tab }: ModulePageProps) {
	const t = useT();
	const navigate = useNavigate();
	const siteId = place.level === "site" ? place.site.id : "";
	const shown = (data ?? null) as RedirectsData | null;
	const addButton = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState<Editing>(null);
	const [finalFocus, setFinalFocus] = useState<RefObject<HTMLElement | null>>(addButton);
	const edit = (next: Editing, from: RefObject<HTMLElement | null>) => {
		setFinalFocus(from);
		setEditing(next);
	};
	if (!shown) return <PageHeader heading={t("redirects.heading")}>{t("redirects.intro")}</PageHeader>;
	return (
		<>
			<PageHeader
				heading={t("redirects.heading")}
				action={
					<Button ref={addButton} onClick={() => edit({ from: "" }, addButton)}>
						<PlusIcon aria-hidden="true" />
						{t("redirects.add")}
					</Button>
				}
			>
				{t("redirects.intro")}
			</PageHeader>
			<div className="grid max-w-5xl grid-cols-1 gap-8">
				<Tabs
					label={t("redirects.tabsLabel")}
					initial={tab === "log" ? "log" : "rules"}
					onSelect={(id) =>
						void navigate({
							to: "/sites/$siteId/m/$moduleId/$",
							params: { siteId, moduleId: "redirects", _splat: "redirects" },
							search: { tab: id === "log" ? "log" : undefined },
							replace: true,
						})
					}
					tabs={[
						{
							id: "rules",
							label: t("redirects.rulesTab", { count: shown.totalRules }),
							panel: <RuleList siteId={siteId} data={shown} onEdit={edit} />,
						},
						{
							id: "log",
							label: t("redirects.logTab", { count: shown.totalMisses }),
							panel: <NotFoundLog siteId={siteId} data={shown} onAdd={edit} />,
						},
					]}
				/>
			</div>
			{editing ? (
				<RuleDialog siteId={siteId} editing={editing} onClose={() => setEditing(null)} finalFocus={finalFocus} />
			) : null}
		</>
	);
}

type OnEdit = (editing: Editing, from: RefObject<HTMLElement | null>) => void;

function RuleList({ siteId, data, onEdit }: { siteId: string; data: RedirectsData; onEdit: OnEdit }) {
	const t = useT();
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("redirects.rulesTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("redirects.rulesIntro")}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">
				{data.rules.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("redirects.none")}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("redirects.from")}</TableHead>
								<TableHead>{t("redirects.to")}</TableHead>
								<TableHead>{t("redirects.type")}</TableHead>
								<TableHead>{t("redirects.changed")}</TableHead>
								<TableHead>
									<span className="sr-only">{t("redirects.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.rules.map((rule) => (
								<TableRow key={rule.id}>
									<TableCell className="max-w-64 font-mono text-sm break-all whitespace-normal">{rule.from}</TableCell>
									<TableCell className="max-w-72 font-mono text-sm break-all whitespace-normal">{rule.to}</TableCell>
									<TableCell>
										<Badge variant={rule.status === 301 ? "secondary" : "outline"}>
											{t(rule.status === 301 ? "redirects.permanent" : "redirects.temporary")}
										</Badge>
									</TableCell>
									<TableCell>
										<div className="grid gap-1 text-sm">
											<span className="text-muted-foreground">{formatUtc(rule.updatedAt)}</span>
											{rule.automatic ? (
												<span className="text-muted-foreground text-xs">{t("redirects.automatic")}</span>
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-end">
										<RuleActions siteId={siteId} rule={rule} onEdit={onEdit} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				{data.rules.length < data.totalRules ? (
					<p className="text-muted-foreground text-sm">
						{t("redirects.shownOf", { shown: data.rules.length, total: data.totalRules })}
					</p>
				) : null}
			</CardContent>
		</Card>
	);
}

function RuleActions({ siteId, rule, onEdit }: { siteId: string; rule: RuleView; onEdit: OnEdit }) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [removing, setRemoving] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={<Button variant="ghost" size="icon-sm" aria-label={t("redirects.actionsOf", { from: rule.from })} />}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-44">
					<DropdownMenuItem onClick={() => onEdit({ rule }, trigger)}>
						<PencilIcon aria-hidden="true" />
						{t("redirects.edit")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
						<TrashIcon aria-hidden="true" />
						{t("redirects.remove")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{removing ? (
				<RemoveRuleDialog siteId={siteId} rule={rule} onClose={() => setRemoving(false)} finalFocus={trigger} />
			) : null}
		</>
	);
}

/** The 404 log: the paths missed most often first, each with Add redirect and Ignore; or the ignored ones. */
function NotFoundLog({ siteId, data, onAdd }: { siteId: string; data: RedirectsData; onAdd: OnEdit }) {
	const t = useT();
	const [showIgnored, setShowIgnored] = useState(false);
	const misses = showIgnored ? data.ignored : data.misses;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t(showIgnored ? "redirects.ignoredTitle" : "redirects.logTitle")}</h2>
				</CardTitle>
				<CardDescription>{t(showIgnored ? "redirects.ignoredIntro" : "redirects.logIntro")}</CardDescription>
				<CardAction>
					<Button variant="outline" size="sm" onClick={() => setShowIgnored((before) => !before)}>
						{showIgnored ? t("redirects.showLog") : t("redirects.showIgnored", { count: data.totalIgnored })}
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent>
				{misses.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						{t(showIgnored ? "redirects.ignoredEmpty" : "redirects.logEmpty")}
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("redirects.path")}</TableHead>
								<TableHead className="text-end">{t("redirects.hits")}</TableHead>
								<TableHead>{t("redirects.lastSeen")}</TableHead>
								<TableHead>{t("redirects.linkedFrom")}</TableHead>
								<TableHead>
									<span className="sr-only">{t("redirects.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{misses.map((miss) => (
								<MissRow key={miss.id} siteId={siteId} miss={miss} onAdd={onAdd} />
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}

function MissRow({ siteId, miss, onAdd }: { siteId: string; miss: MissView; onAdd: OnEdit }) {
	const t = useT();
	const router = useRouter();
	const addButton = useRef<HTMLButtonElement>(null);
	const ignore = async (ignored: boolean) => {
		try {
			await redirectsApi(await getApi()).notFound.ignore({ siteId, missId: miss.id, ignored });
			toast.success(t(ignored ? "redirects.ignoredToast" : "redirects.shownToast", { path: miss.path }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(refusalOf(failure).message));
		}
	};
	return (
		<TableRow>
			<TableCell className="max-w-72 whitespace-normal">
				<span className="flex flex-wrap items-center gap-2">
					<span className="font-mono text-sm break-all">{miss.path}</span>
					<Badge variant="outline" className="uppercase">
						<span className="sr-only">{t("redirects.language")}: </span>
						{miss.language}
					</Badge>
				</span>
			</TableCell>
			<TableCell className="text-end tabular-nums">{miss.hits}</TableCell>
			<TableCell className="text-muted-foreground text-sm">{formatUtc(miss.lastSeen)}</TableCell>
			<TableCell className="text-sm break-all whitespace-normal">
				{miss.referrerHost ?? <span className="text-muted-foreground">{t("redirects.noReferrer")}</span>}
			</TableCell>
			<TableCell>
				<div className="flex justify-end gap-2">
					{miss.ignored ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => ignore(false)}
							aria-label={t("redirects.showFor", { path: miss.path })}
						>
							<EyeIcon aria-hidden="true" />
							{t("redirects.show")}
						</Button>
					) : (
						<>
							<Button
								ref={addButton}
								variant="outline"
								size="sm"
								onClick={() => onAdd({ from: miss.path }, addButton)}
								aria-label={t("redirects.addRedirectFor", { path: miss.path })}
							>
								<PlusIcon aria-hidden="true" />
								{t("redirects.addRedirect")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => ignore(true)}
								aria-label={t("redirects.ignoreFor", { path: miss.path })}
							>
								<EyeOffIcon aria-hidden="true" />
								{t("redirects.ignore")}
							</Button>
						</>
					)}
				</div>
			</TableCell>
		</TableRow>
	);
}

type Problem = { field: "from" | "to" | null; message: MessageKey };

/** Why the Module refused a rule, in the admin's words, and which field it is about. */
function refusalOf(failure: unknown, from = ""): Problem {
	if (errorCode(failure) !== "MODULE_ERROR") return { field: null, message: errorMessage(failure) };
	const code = (failure as { data?: { code?: string } }).data?.code ?? "";
	switch (code) {
		case "FROM_INVALID":
		case "FROM_RESERVED":
		case "RULE_TAKEN":
			return { field: "from", message: `redirects.problems.${code}` };
		case "TO_INVALID":
		case "TO_SCHEME":
		case "RULE_LOOP":
			return { field: "to", message: `redirects.problems.${code}` };
		case "WILDCARD_INVALID": {
			// A * in the middle of the first path is that path's problem; otherwise it is the target's.
			const typed = from.trim();
			const misplaced = typed.includes("*") && !(typed === "/*" || typed.endsWith("/*"));
			return {
				field: misplaced ? "from" : "to",
				message: misplaced ? "redirects.problems.WILDCARD_FROM" : "redirects.problems.WILDCARD_TO",
			};
		}
		case "RULE_NOT_FOUND":
		case "MISS_NOT_FOUND":
			return { field: null, message: `redirects.problems.${code}` };
		default:
			return { field: null, message: "errors.generic" };
	}
}

/** Adding a rule (perhaps for a path of the 404 log), or changing one: from, to and its type. */
function RuleDialog({
	siteId,
	editing,
	onClose,
	finalFocus,
}: {
	siteId: string;
	editing: NonNullable<Editing>;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const rule = "rule" in editing ? editing.rule : null;
	const [from, setFrom] = useState(rule?.from ?? ("from" in editing ? editing.from : ""));
	const [to, setTo] = useState(rule?.to ?? "");
	const [status, setStatus] = useState<301 | 302>(rule?.status ?? 301);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
	// From the 404 log the path is known: the target comes next.
	const startAtTarget = !rule && from !== "";
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			const api = redirectsApi(await getApi());
			if (rule) {
				await api.rules.update({ siteId, ruleId: rule.id, from, to, status });
				toast.success(t("redirects.savedToast"));
			} else {
				const added = await api.rules.add({ siteId, from, to, status });
				toast.success(t("redirects.addedToast", { from: added.rule.from, to: added.rule.to }));
			}
			onClose();
			await router.invalidate();
		} catch (failure) {
			const found = refusalOf(failure, from);
			if (found.field) setProblem(found);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	const described = (field: "from" | "to") =>
		`${id}-${field}-help${problem?.field === field ? ` ${id}-${field}-error` : ""}`;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("redirects.close")} finalFocus={finalFocus} className="sm:max-w-xl">
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>{rule ? t("redirects.editTitle", { from: rule.from }) : t("redirects.addTitle")}</DialogTitle>
						<DialogDescription>{t("redirects.dialogIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-5">
						<Field data-invalid={problem?.field === "from" ? true : undefined}>
							<FieldLabel htmlFor={`${id}-from`}>{t("redirects.from")}</FieldLabel>
							<Input
								id={`${id}-from`}
								value={from}
								required
								maxLength={500}
								spellCheck={false}
								autoComplete="off"
								className="font-mono"
								placeholder="/old-page"
								autoFocus={!startAtTarget}
								onChange={(change) => setFrom(change.target.value)}
								aria-describedby={described("from")}
								aria-invalid={problem?.field === "from" ? true : undefined}
							/>
							<FieldDescription id={`${id}-from-help`}>{t("redirects.fromHelp")}</FieldDescription>
							{problem?.field === "from" ? <FieldError id={`${id}-from-error`}>{t(problem.message)}</FieldError> : null}
						</Field>
						<Field data-invalid={problem?.field === "to" ? true : undefined}>
							<FieldLabel htmlFor={`${id}-to`}>{t("redirects.to")}</FieldLabel>
							<Input
								id={`${id}-to`}
								value={to}
								required
								maxLength={2000}
								spellCheck={false}
								autoComplete="off"
								className="font-mono"
								placeholder="/new-page"
								autoFocus={startAtTarget}
								onChange={(change) => setTo(change.target.value)}
								aria-describedby={described("to")}
								aria-invalid={problem?.field === "to" ? true : undefined}
							/>
							<FieldDescription id={`${id}-to-help`}>{t("redirects.toHelp")}</FieldDescription>
							{problem?.field === "to" ? <FieldError id={`${id}-to-error`}>{t(problem.message)}</FieldError> : null}
						</Field>
						<FieldSet>
							<FieldLegend variant="label">{t("redirects.type")}</FieldLegend>
							<RadioGroup value={String(status)} onValueChange={(value) => setStatus(value === "302" ? 302 : 301)}>
								<Field orientation="horizontal">
									<RadioGroupItem value="301" id={`${id}-301`} aria-describedby={`${id}-301-help`} />
									<div className="grid gap-1">
										<FieldLabel htmlFor={`${id}-301`}>{t("redirects.permanent")}</FieldLabel>
										<FieldDescription id={`${id}-301-help`}>{t("redirects.permanentHelp")}</FieldDescription>
									</div>
								</Field>
								<Field orientation="horizontal">
									<RadioGroupItem value="302" id={`${id}-302`} aria-describedby={`${id}-302-help`} />
									<div className="grid gap-1">
										<FieldLabel htmlFor={`${id}-302`}>{t("redirects.temporary")}</FieldLabel>
										<FieldDescription id={`${id}-302-help`}>{t("redirects.temporaryHelp")}</FieldDescription>
									</div>
								</Field>
							</RadioGroup>
						</FieldSet>
						{rule?.automatic ? <p className="text-muted-foreground text-sm">{t("redirects.automaticHelp")}</p> : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("redirects.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t(rule ? "redirects.save" : "redirects.add")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function RemoveRuleDialog({
	siteId,
	rule,
	onClose,
	finalFocus,
}: {
	siteId: string;
	rule: RuleView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			await redirectsApi(await getApi()).rules.remove({ siteId, ruleId: rule.id });
			toast.success(t("redirects.removedToast", { from: rule.from }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(refusalOf(failure).message));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("redirects.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("redirects.removeTitle", { from: rule.from })}</DialogTitle>
					<DialogDescription>{t("redirects.removeText", { from: rule.from })}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("redirects.cancel")}</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy}>
						{t("redirects.remove")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
