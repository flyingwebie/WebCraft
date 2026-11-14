import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { CspMode, CspSettings, OutsideScript, OutsideScriptPlacement, SnippetProblem } from "@webcraft/core";
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
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import {
	Field,
	FieldContent,
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
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { EllipsisIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { FormatButton, FormatNoteLine, useCodeFormat } from "../../ui/code-format/FormatControl.tsx";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { ConfirmDialog } from "../../ui/settings/confirm.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import { SettingsCard, SettingsListRow, SettingsRows, StateBadge } from "../../ui/settings/layout.tsx";
import { PageSheet } from "../../ui/shell/page.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/outside-scripts")({
	staticData: { crumb: "outsideScripts.pageTitle", width: "form" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		const [{ policy }, { outsideScripts }] = await Promise.all([
			api.csp.get({ siteId: params.siteId }),
			api.outsideScripts.list({ siteId: params.siteId }),
		]);
		return { policy, outsideScripts };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "outsideScripts.pageTitle") }],
	}),
	component: OutsideScriptsPage,
});

const MODES: readonly CspMode[] = ["strict", "relaxed", "reportOnly"];
const PLACEMENTS: readonly OutsideScriptPlacement[] = ["head", "bodyEnd"];
const CATEGORIES = ["necessary", "analytics", "marketing", "media"] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * Site › Outside scripts (Structure, Staff only; ADRs 0022, 0023): the Site's Content Security Policy
 * (Strict, Relaxed or Report only), its outside scripts (tags, pixels and widgets from other hosts,
 * given by address or pasted as a snippet; they never run in Edit mode), and the hosts its policy
 * allows, which outside scripts add by themselves.
 */
function OutsideScriptsPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("outsideScripts.heading")}>{t("outsideScripts.intro")}</PageHeader>
			<SettingsForm>
				<div className="grid gap-6">
					<OutsideScriptList siteId={siteId} scripts={data.outsideScripts} />
					<AllowedHosts siteId={siteId} policy={data.policy} />
					<PolicyMode siteId={siteId} mode={data.policy.mode} />
					<p className="text-muted-foreground text-sm">{t("outsideScripts.appliesAtOnce")}</p>
				</div>
			</SettingsForm>
		</>
	);
}

/** The Site's policy mode: Strict (the default), Relaxed or Report only. */
function PolicyMode({ siteId, mode }: { siteId: string; mode: CspMode }) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: { chosen: mode },
		save: async ({ chosen }) => (await getApi()).csp.setMode({ siteId, mode: chosen }),
	});
	return (
		<SettingsCard title={t("outsideScripts.policyTitle")} description={t("outsideScripts.policyIntro")}>
			<form {...section.formProps} className="grid gap-6">
				<FieldSet>
					<FieldLegend variant="label">{t("outsideScripts.mode")}</FieldLegend>
					<RadioGroup
						value={section.values.chosen}
						onValueChange={(value) => section.set({ chosen: value as CspMode })}
					>
						{MODES.map((candidate) => (
							<Field key={candidate} orientation="horizontal">
								<RadioGroupItem
									value={candidate}
									id={`${id}-${candidate}`}
									aria-describedby={`${id}-${candidate}-help`}
								/>
								<FieldContent>
									<FieldLabel htmlFor={`${id}-${candidate}`}>{t(`outsideScripts.modes.${candidate}`)}</FieldLabel>
									<FieldDescription id={`${id}-${candidate}-help`}>
										{t(`outsideScripts.modeHelp.${candidate}`)}
									</FieldDescription>
								</FieldContent>
							</Field>
						))}
					</RadioGroup>
				</FieldSet>
				{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
			</form>
		</SettingsCard>
	);
}

/** The Site's outside scripts, in the order they load, with adding, changing and removing them. */
function OutsideScriptList({ siteId, scripts }: { siteId: string; scripts: readonly OutsideScript[] }) {
	const t = useT();
	const addButton = useRef<HTMLButtonElement>(null);
	const [adding, setAdding] = useState(false);
	return (
		<SettingsCard
			title={t("outsideScripts.listTitle")}
			description={t("outsideScripts.listIntro")}
			action={
				<Button ref={addButton} variant="outline" onClick={() => setAdding(true)}>
					<PlusIcon aria-hidden="true" />
					{t("outsideScripts.add")}
				</Button>
			}
		>
			{scripts.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("outsideScripts.none")}</p>
			) : (
				<SettingsRows>
					{scripts.map((script) => (
						<SettingsListRow
							key={script.id}
							detail={
								<div className="space-y-0.5">
									<p>
										{[
											t(`outsideScripts.kinds.${script.kind}`),
											`${t("outsideScripts.placement")}: ${t(`outsideScripts.placements.${script.placement}`)}`,
											`${t("outsideScripts.category")}: ${t(`outsideScripts.categories.${script.consentCategory}`)}`,
										].join(" · ")}
									</p>
									{script.hosts.length > 0 ? (
										<ul className="flex flex-wrap gap-x-3 gap-y-1">
											{script.hosts.map((host) => (
												<li key={host} className="flex items-center gap-1.5">
													<span className="font-mono">{host}</span>
													{script.blockedHosts.includes(host) ? (
														<StateBadge tone="danger">{t("outsideScripts.blocked")}</StateBadge>
													) : null}
												</li>
											))}
										</ul>
									) : null}
								</div>
							}
							actions={<OutsideScriptActions siteId={siteId} script={script} />}
						>
							<span>{script.name}</span>
						</SettingsListRow>
					))}
				</SettingsRows>
			)}
			{adding ? <OutsideScriptDialog siteId={siteId} onClose={() => setAdding(false)} finalFocus={addButton} /> : null}
		</SettingsCard>
	);
}

function OutsideScriptActions({ siteId, script }: { siteId: string; script: OutsideScript }) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState(false);
	const [removing, setRemoving] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={
						<Button variant="ghost" size="icon-sm" aria-label={t("outsideScripts.actionsOf", { name: script.name })} />
					}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-48">
					<DropdownMenuItem onClick={() => setEditing(true)}>
						<PencilIcon aria-hidden="true" />
						{t("outsideScripts.edit")}
					</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
						<TrashIcon aria-hidden="true" />
						{t("outsideScripts.remove")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{editing ? (
				<OutsideScriptDialog siteId={siteId} script={script} onClose={() => setEditing(false)} finalFocus={trigger} />
			) : null}
			{removing ? (
				<RemoveOutsideScriptDialog
					siteId={siteId}
					script={script}
					onClose={() => setRemoving(false)}
					finalFocus={trigger}
				/>
			) : null}
		</>
	);
}

/** Adding an outside script, or changing one: its name, an address or a snippet, where it loads and its Consent category. */
function OutsideScriptDialog({
	siteId,
	script,
	onClose,
	finalFocus,
}: {
	siteId: string;
	script?: OutsideScript;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(script?.name ?? "");
	const [kind, setKind] = useState<"url" | "snippet">(script?.kind ?? "url");
	const [url, setUrl] = useState(script?.url ?? "");
	const [snippet, setSnippet] = useState(script?.snippet ?? "");
	const snippetArea = useRef<HTMLTextAreaElement>(null);
	const formatting = useCodeFormat("html", snippetArea, snippet, kind === "snippet");
	const [placement, setPlacement] = useState<OutsideScriptPlacement>(script?.placement ?? "bodyEnd");
	const [category, setCategory] = useState<Category>(script?.consentCategory ?? "marketing");
	const [problems, setProblems] = useState<SnippetProblem[]>([]);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblems([]);
		const input = {
			siteId,
			name,
			placement,
			consentCategory: category,
			source: kind === "url" ? { kind, url } : { kind, snippet },
		};
		try {
			const api = await getApi();
			if (script) await api.outsideScripts.update({ ...input, outsideScriptId: script.id });
			else await api.outsideScripts.add(input);
			toast.success(t(script ? "outsideScripts.saved" : "outsideScripts.added", { name: name.trim() }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			if (errorCode(failure) === "OUTSIDE_SCRIPT_INVALID") {
				setProblems((failure as { data?: { problems?: SnippetProblem[] } }).data?.problems ?? []);
			} else {
				toast.error(t(errorMessage(failure)));
			}
		} finally {
			setBusy(false);
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={script ? t("outsideScripts.editTitle", { name: script.name }) : t("outsideScripts.addTitle")}
			description={t("outsideScripts.dialogIntro")}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-2xl"
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("outsideScripts.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy || !name.trim()}>
						{t("outsideScripts.save")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={save} noValidate>
				<FieldGroup className="gap-5">
					<Field>
						<FieldLabel htmlFor={`${id}-name`}>{t("outsideScripts.name")}</FieldLabel>
						<Input
							id={`${id}-name`}
							value={name}
							required
							maxLength={100}
							onChange={(event) => setName(event.target.value)}
						/>
					</Field>
					<FieldSet>
						<FieldLegend variant="label">{t("outsideScripts.kind")}</FieldLegend>
						<RadioGroup value={kind} onValueChange={(value) => setKind(value as "url" | "snippet")}>
							<Field orientation="horizontal">
								<RadioGroupItem value="url" id={`${id}-url`} />
								<FieldLabel htmlFor={`${id}-url`}>{t("outsideScripts.kinds.url")}</FieldLabel>
							</Field>
							<Field orientation="horizontal">
								<RadioGroupItem value="snippet" id={`${id}-snippet`} />
								<FieldLabel htmlFor={`${id}-snippet`}>{t("outsideScripts.kinds.snippet")}</FieldLabel>
							</Field>
						</RadioGroup>
					</FieldSet>
					{kind === "url" ? (
						<Field>
							<FieldLabel htmlFor={`${id}-address`}>{t("outsideScripts.address")}</FieldLabel>
							<Input
								id={`${id}-address`}
								type="url"
								value={url}
								required
								maxLength={2000}
								spellCheck={false}
								className="font-mono"
								onChange={(event) => setUrl(event.target.value)}
								aria-describedby={`${id}-address-help`}
							/>
							<FieldDescription id={`${id}-address-help`}>{t("outsideScripts.addressHelp")}</FieldDescription>
						</Field>
					) : (
						<Field>
							<div className="flex items-center justify-between gap-2">
								<FieldLabel htmlFor={`${id}-code`}>{t("outsideScripts.snippet")}</FieldLabel>
								<FormatButton format={formatting} withWord />
							</div>
							<Textarea
								ref={snippetArea}
								id={`${id}-code`}
								value={snippet}
								required
								rows={8}
								spellCheck={false}
								className="max-h-72 font-mono text-xs"
								onChange={(event) => setSnippet(event.target.value)}
								onKeyDown={(event) => {
									formatting.onKeyDown(event);
								}}
								aria-describedby={`${id}-code-help`}
								aria-invalid={problems.length > 0 ? true : undefined}
							/>
							<FormatNoteLine format={formatting} />
							<FieldDescription id={`${id}-code-help`}>{t("outsideScripts.snippetHelp")}</FieldDescription>
						</Field>
					)}
					<div className="grid gap-5 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor={`${id}-placement`}>{t("outsideScripts.placement")}</FieldLabel>
							<NativeSelect
								id={`${id}-placement`}
								value={placement}
								onChange={(event) => setPlacement(event.target.value as OutsideScriptPlacement)}
							>
								{PLACEMENTS.map((candidate) => (
									<NativeSelectOption key={candidate} value={candidate}>
										{t(`outsideScripts.placements.${candidate}`)}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-category`}>{t("outsideScripts.category")}</FieldLabel>
							<NativeSelect
								id={`${id}-category`}
								value={category}
								onChange={(event) => setCategory(event.target.value as Category)}
								aria-describedby={`${id}-category-help`}
							>
								{CATEGORIES.map((candidate) => (
									<NativeSelectOption key={candidate} value={candidate}>
										{t(`outsideScripts.categories.${candidate}`)}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<FieldDescription id={`${id}-category-help`}>{t("outsideScripts.categoryHelp")}</FieldDescription>
						</Field>
					</div>
					<div role="alert" className="grid gap-1 empty:hidden">
						{problems.length > 0 ? (
							<>
								<p className="text-destructive text-sm font-medium">{t("outsideScripts.problems")}</p>
								<ul className="text-destructive list-disc ps-5 text-sm">
									{problems.map((problem) => (
										<li key={`${problem.line}-${problem.message}`}>
											{problem.line > 0 ? `${t("outsideScripts.line", { line: problem.line })} ` : ""}
											{problem.message}
										</li>
									))}
								</ul>
							</>
						) : null}
					</div>
				</FieldGroup>
			</form>
		</PageSheet>
	);
}

function RemoveOutsideScriptDialog({
	siteId,
	script,
	onClose,
	finalFocus,
}: {
	siteId: string;
	script: OutsideScript;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.outsideScripts.remove({ siteId, outsideScriptId: script.id });
			toast.success(t("outsideScripts.removed", { name: script.name }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("outsideScripts.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("outsideScripts.removeTitle", { name: script.name })}</DialogTitle>
					<DialogDescription>{t("outsideScripts.removeText")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("outsideScripts.cancel")}</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy}>
						{t("outsideScripts.remove")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Why a host was refused, in the admin's words. */
function hostRefusal(failure: unknown): MessageKey {
	const code = errorCode(failure);
	if (code === "HOST_INVALID") return "outsideScripts.hostInvalid";
	if (code === "TOO_MANY_HOSTS") return "outsideScripts.tooManyHosts";
	return errorMessage(failure);
}

/** The hosts the Site's policy allows: added by hand, needed by outside scripts, or declared by running Modules. */
function AllowedHosts({ siteId, policy }: { siteId: string; policy: CspSettings }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [host, setHost] = useState("");
	const [busy, setBusy] = useState(false);
	const add = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await getApi();
			await api.csp.addHost({ siteId, host });
			toast.success(t("outsideScripts.hostAdded", { host: host.trim().toLowerCase() }));
			setHost("");
			await router.invalidate();
		} catch (failure) {
			toast.error(t(hostRefusal(failure)));
		} finally {
			setBusy(false);
		}
	};
	const [removing, setRemoving] = useState<string | null>(null);
	const remove = async (removed: string) => {
		try {
			const api = await getApi();
			await api.csp.removeHost({ siteId, host: removed });
			toast.success(t("outsideScripts.hostRemoved", { host: removed }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const empty = policy.hosts.length === 0 && policy.moduleHosts.length === 0;
	return (
		<SettingsCard title={t("outsideScripts.hostsTitle")} description={t("outsideScripts.hostsIntro")}>
			{empty ? (
				<p className="text-muted-foreground text-sm">{t("outsideScripts.noHosts")}</p>
			) : (
				<SettingsRows>
					{policy.hosts.map((allowed) => (
						<SettingsListRow
							key={allowed.host}
							detail={
								allowed.usedBy.length > 0
									? t("outsideScripts.neededBy", { names: allowed.usedBy.map((script) => script.name).join(", ") })
									: t(allowed.source === "hand" ? "outsideScripts.byHand" : "outsideScripts.byScript")
							}
							actions={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("outsideScripts.removeHost", { host: allowed.host })}
									onClick={() => setRemoving(allowed.host)}
								>
									<TrashIcon aria-hidden="true" />
								</Button>
							}
						>
							<span className="font-mono">{allowed.host}</span>
						</SettingsListRow>
					))}
					{policy.moduleHosts.map((allowed) => (
						<SettingsListRow
							key={`${allowed.moduleId} ${allowed.host}`}
							detail={t("outsideScripts.byModule", { name: allowed.module })}
						>
							<span className="font-mono">{allowed.host}</span>
						</SettingsListRow>
					))}
				</SettingsRows>
			)}
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={t("outsideScripts.removeHostTitle", { host: removing ?? "" })}
				confirm={t("outsideScripts.remove")}
				onConfirm={() => (removing ? remove(removing) : undefined)}
			>
				{t("outsideScripts.removeHostBody")}
			</ConfirmDialog>
			<form onSubmit={add} noValidate className="grid gap-3">
				<Field>
					<FieldLabel htmlFor={`${id}-host`}>{t("outsideScripts.addHost")}</FieldLabel>
					<div className="flex flex-wrap gap-2">
						<Input
							id={`${id}-host`}
							value={host}
							maxLength={253}
							autoComplete="off"
							spellCheck={false}
							className="max-w-sm font-mono"
							onChange={(event) => setHost(event.target.value)}
							aria-describedby={`${id}-host-help`}
						/>
						<Button type="submit" variant="outline" disabled={busy || !host.trim()}>
							{t("outsideScripts.allow")}
						</Button>
					</div>
					<FieldDescription id={`${id}-host-help`}>{t("outsideScripts.hostHelp")}</FieldDescription>
				</Field>
			</form>
		</SettingsCard>
	);
}
