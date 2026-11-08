import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
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
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@webcraft/ui/components/sheet.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { SendIcon, UserPlusIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtcDate } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/staff")({
	staticData: { crumb: "staff.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("staff.manage")) return null;
		const api = await getApi();
		const [{ staff, invites }, { workspaces }] = await Promise.all([api.staff.list(), api.workspaces.list()]);
		return { staff, invites, workspaces: workspaces.map(({ id, name }) => ({ id, name })) };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "staff.pageTitle") }] }),
	component: StaffPage,
});

type WorkspaceOption = { id: string; name: string };

/** Which Workspaces Staff reach, as the form holds it. */
type Access = { mode: "all" | "chosen"; chosen: string[] };

const toAccess = (workspaces: "all" | WorkspaceOption[]): Access =>
	workspaces === "all" ? { mode: "all", chosen: [] } : { mode: "chosen", chosen: workspaces.map(({ id }) => id) };

const fromAccess = (access: Access): "all" | string[] => (access.mode === "all" ? "all" : access.chosen);

/** Install › Staff: the agency's people, the Workspaces they reach, and pending invites. */
function StaffPage() {
	const t = useT();
	const data = Route.useLoaderData();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const { staff, invites, workspaces } = data;
	const reach = (assigned: "all" | WorkspaceOption[]) =>
		assigned === "all"
			? t("staff.allWorkspaces")
			: assigned.length > 0
				? assigned.map(({ name }) => name).join(", ")
				: t("staff.noWorkspaces");

	return (
		<>
			<PageHeader heading={t("staff.heading")} action={<InviteStaffSheet workspaces={workspaces} />}>
				{t("staff.intro")}
			</PageHeader>
			<div className="grid gap-10">
				{staff.length === 0 ? (
					<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">{t("staff.empty")}</p>
				) : (
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="ps-4">{t("staff.columns.person")}</TableHead>
									<TableHead>{t("staff.columns.workspaces")}</TableHead>
									<TableHead>{t("staff.columns.since")}</TableHead>
									<TableHead className="pe-4 text-end">{t("staff.columns.actions")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{staff.map((person) => (
									<TableRow key={person.id}>
										<TableCell className="ps-4">
											<span className="block font-medium">{person.name}</span>
											<span className="text-muted-foreground block text-xs">{person.email}</span>
										</TableCell>
										<TableCell className="whitespace-normal">{reach(person.workspaces)}</TableCell>
										<TableCell className="text-muted-foreground">{formatUtcDate(person.since)}</TableCell>
										<TableCell className="pe-4 text-end">
											<ChangeWorkspacesSheet person={person} workspaces={workspaces} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
				<section aria-labelledby="pending-invites" className="grid gap-4">
					<h2 id="pending-invites" className="text-lg font-semibold tracking-tight">
						{t("staff.pending.heading")}
					</h2>
					{invites.length === 0 ? (
						<p className="text-muted-foreground">{t("staff.pending.empty")}</p>
					) : (
						<div className="rounded-lg border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="ps-4">{t("staff.pending.email")}</TableHead>
										<TableHead>{t("staff.pending.workspaces")}</TableHead>
										<TableHead>{t("staff.pending.invited")}</TableHead>
										<TableHead className="pe-4 text-end">{t("staff.pending.actions")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{invites.map((invite) => (
										<TableRow key={invite.id}>
											<TableCell className="ps-4 font-medium">{invite.email}</TableCell>
											<TableCell className="whitespace-normal">{reach(invite.workspaces)}</TableCell>
											<TableCell className="text-muted-foreground">
												{invite.invitedBy
													? t("staff.pending.invitedBy", {
															name: invite.invitedBy.name,
															date: formatUtcDate(invite.expiresAt),
														})
													: t("staff.pending.expires", { date: formatUtcDate(invite.expiresAt) })}
											</TableCell>
											<TableCell className="pe-4 text-end">
												<RevokeInviteButton invite={invite} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</section>
			</div>
		</>
	);
}

/** Withdraws a pending invite: its link stops working. */
function RevokeInviteButton({ invite }: { invite: { id: string; email: string } }) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const revoke = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.staff.revokeInvite({ inviteId: invite.id });
			toast.success(t("staff.pending.revoked", { email: invite.email }));
			await router.invalidate();
			document.getElementById("main")?.focus();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Button
			variant="outline"
			size="sm"
			onClick={revoke}
			disabled={busy}
			aria-label={t("staff.pending.revokeOf", { email: invite.email })}
		>
			{t("staff.pending.revoke")}
		</Button>
	);
}

/** "Invite Staff": an email address and the Workspaces they'll reach. */
function InviteStaffSheet({ workspaces }: { workspaces: WorkspaceOption[] }) {
	const t = useT();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [access, setAccess] = useState<Access>({ mode: "all", chosen: [] });
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const reset = () => {
		setEmail("");
		setAccess({ mode: "all", chosen: [] });
		setError(null);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { invite } = await api.staff.invite({ email, workspaces: fromAccess(access) });
			toast.success(t("staff.sheet.sent", { email: invite.email }));
			setOpen(false);
			reset();
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<StaffSheet
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
			trigger={
				<SheetTrigger render={<Button />}>
					<UserPlusIcon aria-hidden="true" />
					{t("staff.invite")}
				</SheetTrigger>
			}
			title={t("staff.sheet.inviteTitle")}
			description={t("staff.sheet.inviteDescription")}
			onSubmit={submit}
			submit={
				<Button type="submit" disabled={busy}>
					<SendIcon aria-hidden="true" />
					{t("staff.sheet.send")}
				</Button>
			}
		>
			<Field data-invalid={error ? true : undefined}>
				<FieldLabel htmlFor="invite-email">{t("staff.sheet.email")}</FieldLabel>
				<Input
					id="invite-email"
					type="email"
					value={email}
					autoComplete="off"
					onChange={(event) => setEmail(event.target.value)}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? "invite-error" : undefined}
				/>
			</Field>
			<WorkspaceAccessFields workspaces={workspaces} value={access} onChange={setAccess} />
			{error ? <FieldError id="invite-error">{t(error)}</FieldError> : null}
		</StaffSheet>
	);
}

/** "Change Workspaces" for one Staff member. */
function ChangeWorkspacesSheet({
	person,
	workspaces,
}: {
	person: { id: string; name: string; workspaces: "all" | WorkspaceOption[] };
	workspaces: WorkspaceOption[];
}) {
	const t = useT();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [access, setAccess] = useState<Access>(() => toAccess(person.workspaces));
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.staff.setWorkspaces({ personId: person.id, workspaces: fromAccess(access) });
			toast.success(t("staff.sheet.saved"));
			setOpen(false);
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<StaffSheet
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setAccess(toAccess(person.workspaces));
				setError(null);
			}}
			trigger={
				<SheetTrigger
					render={
						<Button variant="outline" size="sm" aria-label={t("staff.changeWorkspacesOf", { name: person.name })} />
					}
				>
					{t("staff.changeWorkspaces")}
				</SheetTrigger>
			}
			title={t("staff.sheet.changeTitle")}
			description={t("staff.sheet.changeDescription", { name: person.name })}
			onSubmit={submit}
			submit={
				<Button type="submit" disabled={busy}>
					{t("staff.sheet.save")}
				</Button>
			}
		>
			<WorkspaceAccessFields workspaces={workspaces} value={access} onChange={setAccess} />
			{error ? <FieldError>{t(error)}</FieldError> : null}
		</StaffSheet>
	);
}

/** A side panel holding one form, with Cancel and the form's own submit button at the bottom. */
function StaffSheet({
	open,
	onOpenChange,
	trigger,
	title,
	description,
	onSubmit,
	submit,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger: ReactNode;
	title: string;
	description: string;
	onSubmit: (event: FormEvent) => void;
	submit: ReactNode;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			{trigger}
			<SheetContent closeLabel={t("staff.sheet.close")} className="w-full sm:max-w-md">
				<form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
					<SheetHeader className="pe-12">
						<SheetTitle>{title}</SheetTitle>
						<SheetDescription>{description}</SheetDescription>
					</SheetHeader>
					<FieldGroup className="flex-1 gap-6 overflow-y-auto p-4">{children}</FieldGroup>
					<SheetFooter className="flex-row justify-end border-t">
						<SheetClose render={<Button variant="outline" type="button" />}>{t("staff.sheet.cancel")}</SheetClose>
						{submit}
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}

/** All Workspaces (including later ones), or the ones ticked. */
function WorkspaceAccessFields({
	workspaces,
	value,
	onChange,
}: {
	workspaces: WorkspaceOption[];
	value: Access;
	onChange: (access: Access) => void;
}) {
	const t = useT();
	const id = useId();
	const toggle = (workspaceId: string, checked: boolean) =>
		onChange({
			...value,
			chosen: checked ? [...value.chosen, workspaceId] : value.chosen.filter((chosen) => chosen !== workspaceId),
		});
	return (
		<FieldSet>
			<FieldLegend variant="label">{t("staff.sheet.access")}</FieldLegend>
			<RadioGroup value={value.mode} onValueChange={(mode) => onChange({ ...value, mode: mode as Access["mode"] })}>
				<Field orientation="horizontal">
					<RadioGroupItem value="all" id={`${id}-all`} aria-describedby={`${id}-all-help`} />
					<FieldContent>
						<FieldLabel htmlFor={`${id}-all`}>{t("staff.sheet.all")}</FieldLabel>
						<FieldDescription id={`${id}-all-help`}>{t("staff.sheet.allHelp")}</FieldDescription>
					</FieldContent>
				</Field>
				<Field orientation="horizontal">
					<RadioGroupItem value="chosen" id={`${id}-chosen`} aria-describedby={`${id}-chosen-help`} />
					<FieldContent>
						<FieldLabel htmlFor={`${id}-chosen`}>{t("staff.sheet.chosen")}</FieldLabel>
						<FieldDescription id={`${id}-chosen-help`}>{t("staff.sheet.chosenHelp")}</FieldDescription>
					</FieldContent>
				</Field>
			</RadioGroup>
			{value.mode === "chosen" ? (
				workspaces.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("staff.sheet.noWorkspaces")}</p>
				) : (
					<FieldSet className="gap-3 ps-7">
						<FieldLegend variant="label" className="sr-only">
							{t("staff.sheet.chooseLegend")}
						</FieldLegend>
						{workspaces.map((workspace) => (
							<Field key={workspace.id} orientation="horizontal">
								<Checkbox
									id={`${id}-${workspace.id}`}
									checked={value.chosen.includes(workspace.id)}
									onCheckedChange={(checked) => toggle(workspace.id, checked === true)}
								/>
								<FieldLabel htmlFor={`${id}-${workspace.id}`} className="font-normal">
									{workspace.name}
								</FieldLabel>
							</Field>
						))}
					</FieldSet>
				)
			) : null}
		</FieldSet>
	);
}
