import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
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
	FieldContent,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { UserPlusIcon } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";

/** What the Members screen loads: Members, pending invites, the Staff assigned and what may be granted. */
export type MembersData = Awaited<ReturnType<ApiClient["members"]["list"]>>;

export type Member = MembersData["members"][number];

export type MemberInvite = MembersData["invites"][number];

/** One Workspace role the person may give, with whether on every Site and on which Sites. */
export type AccessOffer = MembersData["offer"][number];

export type WorkspaceRole = AccessOffer["role"];

export type SiteOption = { id: string; name: string };

/** A Membership's access as the form holds it. */
type Access = { role: WorkspaceRole; mode: "all" | "chosen"; chosen: string[] };

/** Keeps the form within what may be granted for its role: drops "All Sites" and Sites the role can't have. */
function within(access: Access, offer: readonly AccessOffer[]): Access {
	const choice = offer.find((option) => option.role === access.role);
	if (!choice) return access;
	return {
		...access,
		mode: access.mode === "all" && !choice.allSites ? "chosen" : access.mode,
		chosen: access.chosen.filter((siteId) => choice.sites.includes(siteId)),
	};
}

function fromAccess(access: Access): "all" | string[] {
	return access.mode === "all" ? "all" : access.chosen;
}

/** The form's starting point for a new invite: Editor on every Site, or the nearest the person may give. */
function freshAccess(offer: readonly AccessOffer[]): Access {
	const role = offer.find((option) => option.role === "editor")?.role ?? offer[0]?.role ?? "author";
	return within({ role, mode: "all", chosen: [] }, offer);
}

/**
 * "Invite a Member" (frame "Invite a Member"): an email address, the role as three cards, the Sites
 * the Membership reaches (all of them, also those added later, or the ones ticked), and the line
 * about the link, which works for 7 days.
 */
export function InviteMemberSheet({
	workspaceId,
	offer,
	sites,
}: {
	workspaceId: string;
	offer: readonly AccessOffer[];
	sites: readonly SiteOption[];
}) {
	const t = useT();
	const router = useRouter();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [access, setAccess] = useState<Access>(() => freshAccess(offer));
	const [errors, setErrors] = useState<{ sites?: MessageKey; form?: MessageKey }>({});
	const [busy, setBusy] = useState(false);

	const reset = () => {
		setEmail("");
		setAccess(freshAccess(offer));
		setErrors({});
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (access.mode === "chosen" && access.chosen.length === 0) {
			setErrors({ sites: "members.sheet.chooseSite" });
			return;
		}
		setBusy(true);
		setErrors({});
		try {
			const api = await getApi();
			const { invite } = await api.members.invite({ workspaceId, email, role: access.role, sites: fromAccess(access) });
			toast.success(t("members.sheet.sent", { email: invite.email }));
			setOpen(false);
			reset();
			await router.invalidate();
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button ref={trigger} onClick={() => setOpen(true)} aria-haspopup="dialog">
				<UserPlusIcon aria-hidden="true" />
				{t("members.invite")}
			</Button>
			<MemberDialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) reset();
				}}
				finalFocus={trigger}
				title={t("members.sheet.inviteTitle")}
				onSubmit={submit}
				foot={<p className="text-muted-foreground text-sm">{t("members.sheet.linkNote")}</p>}
				submit={
					<Button type="submit" disabled={busy}>
						{t("members.sheet.send")}
					</Button>
				}
			>
				<Field data-invalid={errors.form ? true : undefined}>
					<FieldLabel htmlFor="member-invite-email">{t("members.sheet.email")}</FieldLabel>
					<Input
						id="member-invite-email"
						type="email"
						value={email}
						autoComplete="off"
						placeholder={t("members.sheet.emailPlaceholder")}
						onChange={(event) => setEmail(event.target.value)}
						aria-invalid={errors.form ? true : undefined}
						aria-describedby={errors.form ? "member-invite-error" : undefined}
					/>
				</Field>
				<MemberAccessFields offer={offer} sites={sites} value={access} onChange={setAccess} error={errors.sites} />
				{errors.form ? <FieldError id="member-invite-error">{t(errors.form)}</FieldError> : null}
			</MemberDialog>
		</>
	);
}

/** "Change role and Sites" for one Member, opened from the row's menu. */
export function ChangeAccessSheet({
	workspaceId,
	member,
	offer,
	sites,
	open,
	onOpenChange,
	finalFocus,
}: {
	workspaceId: string;
	member: Member;
	offer: readonly AccessOffer[];
	sites: readonly SiteOption[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const current = (): Access => ({
		role: member.role as WorkspaceRole,
		mode: member.sites === "all" ? "all" : "chosen",
		chosen: member.sites === "all" ? [] : member.sites.map(({ id }) => id),
	});
	const [access, setAccess] = useState<Access>(current);
	const [errors, setErrors] = useState<{ sites?: MessageKey; form?: MessageKey }>({});
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (access.mode === "chosen" && access.chosen.length === 0) {
			setErrors({ sites: "members.sheet.chooseSite" });
			return;
		}
		setBusy(true);
		setErrors({});
		try {
			const api = await getApi();
			await api.members.changeAccess({
				workspaceId,
				personId: member.id,
				role: access.role,
				sites: fromAccess(access),
			});
			toast.success(t("members.sheet.saved"));
			onOpenChange(false);
			await router.invalidate();
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<MemberDialog
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				setAccess(current());
				setErrors({});
			}}
			finalFocus={finalFocus}
			title={t("members.sheet.changeTitle")}
			description={t("members.sheet.changeDescription", { name: member.name })}
			onSubmit={submit}
			submit={
				<Button type="submit" disabled={busy}>
					{t("members.sheet.save")}
				</Button>
			}
		>
			<MemberAccessFields offer={offer} sites={sites} value={access} onChange={setAccess} error={errors.sites} />
			{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
		</MemberDialog>
	);
}

/** A dialog holding one form: its fields, then a line at the foot, Cancel and the form's own submit. */
function MemberDialog({
	open,
	onOpenChange,
	finalFocus,
	title,
	description,
	onSubmit,
	foot,
	submit,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	finalFocus?: RefObject<HTMLElement | null>;
	title: string;
	description?: string;
	onSubmit: (event: FormEvent) => void;
	/** A line under the fields, before the buttons. */
	foot?: ReactNode;
	submit: ReactNode;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				closeLabel={t("members.sheet.close")}
				finalFocus={finalFocus}
				className="gap-0 p-6 sm:max-w-[520px]"
			>
				<form onSubmit={onSubmit} noValidate className="grid max-h-[calc(100dvh-6rem)] min-h-0 gap-5">
					<DialogHeader className="pe-8">
						<DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
						{description ? <DialogDescription>{description}</DialogDescription> : null}
					</DialogHeader>
					<div className="-mx-1 grid min-h-0 gap-5 overflow-y-auto px-1">{children}</div>
					<div className="grid gap-4">
						{foot}
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>{t("members.sheet.cancel")}</DialogClose>
							{submit}
						</DialogFooter>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The role as cards, one line each, and the Sites the Membership reaches: all of them (also those
 * added later) or the ones ticked. Only what the person may give is on offer: nobody grants more
 * access than they hold.
 */
function MemberAccessFields({
	offer,
	sites,
	value,
	onChange,
	error,
}: {
	offer: readonly AccessOffer[];
	sites: readonly SiteOption[];
	value: Access;
	onChange: (access: Access) => void;
	error?: MessageKey;
}) {
	const t = useT();
	const id = useId();
	const choice = offer.find((option) => option.role === value.role);
	const toggle = (siteId: string, checked: boolean) =>
		onChange({
			...value,
			chosen: checked ? [...value.chosen, siteId] : value.chosen.filter((chosen) => chosen !== siteId),
		});
	const all = value.mode === "all";
	return (
		<>
			<FieldSet className="gap-2">
				<FieldLegend variant="label" className="mb-1">
					{t("members.sheet.role")}
				</FieldLegend>
				<RadioGroup
					value={value.role}
					onValueChange={(role) => onChange(within({ ...value, role: role as WorkspaceRole }, offer))}
					className="gap-2"
				>
					{offer.map(({ role }) => (
						<label
							key={role}
							htmlFor={`${id}-${role}`}
							className={cn(
								"has-focus-visible:ring-ring/50 flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm transition-colors duration-150 has-focus-visible:ring-3",
								value.role === role ? "border-primary bg-accent" : "hover:bg-accent/50",
							)}
						>
							<RadioGroupItem value={role} id={`${id}-${role}`} />
							<span>
								<span className="font-semibold">{t("members.sheet.roleName", { role: t(`roles.${role}`) })}</span>{" "}
								{t(`members.sheet.roleLine.${role}`)}
							</span>
						</label>
					))}
				</RadioGroup>
			</FieldSet>
			<FieldSet data-invalid={error ? true : undefined} className="gap-2.5">
				<FieldLegend variant="label" className="mb-0.5">
					{t("members.sheet.reach")}
				</FieldLegend>
				{choice?.allSites ? (
					<Field orientation="horizontal">
						<Checkbox
							id={`${id}-all`}
							checked={all}
							onCheckedChange={(checked) =>
								onChange({
									...value,
									mode: checked === true ? "all" : "chosen",
									// Unticking "All Sites" starts from every Site ticked, to untick the ones not wanted.
									chosen: checked === true ? value.chosen : sites.map((site) => site.id),
								})
							}
						/>
						<FieldLabel htmlFor={`${id}-all`} className="font-normal">
							{t("members.sheet.allLater")}
						</FieldLabel>
					</Field>
				) : null}
				{sites.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("members.sheet.noSites")}</p>
				) : (
					sites.map((site) => {
						const offered = choice?.sites.includes(site.id) ?? false;
						return (
							<Field
								key={site.id}
								orientation="horizontal"
								data-disabled={offered && !all ? undefined : true}
								className={choice?.allSites ? "ps-6" : undefined}
							>
								<Checkbox
									id={`${id}-${site.id}`}
									checked={all ? offered : value.chosen.includes(site.id)}
									disabled={!offered || all}
									onCheckedChange={(checked) => toggle(site.id, checked === true)}
									aria-describedby={offered ? undefined : `${id}-${site.id}-help`}
								/>
								<FieldContent>
									<FieldLabel htmlFor={`${id}-${site.id}`} className="font-normal">
										{site.name}
									</FieldLabel>
									{offered ? null : (
										<FieldDescription id={`${id}-${site.id}-help`}>{t("members.sheet.notReached")}</FieldDescription>
									)}
								</FieldContent>
							</Field>
						);
					})
				)}
				{error ? <FieldError>{t(error)}</FieldError> : null}
			</FieldSet>
		</>
	);
}
