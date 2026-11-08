import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
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
import { InfoIcon, SendIcon, UserPlusIcon } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useId, useState } from "react";
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

/** "Invite Member": an email address, a role, and the Sites the Membership reaches. */
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
		<MemberSheet
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
			trigger={
				<SheetTrigger render={<Button />}>
					<UserPlusIcon aria-hidden="true" />
					{t("members.invite")}
				</SheetTrigger>
			}
			title={t("members.sheet.inviteTitle")}
			description={t("members.sheet.inviteDescription")}
			onSubmit={submit}
			submit={
				<Button type="submit" disabled={busy}>
					<SendIcon aria-hidden="true" />
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
					onChange={(event) => setEmail(event.target.value)}
					aria-invalid={errors.form ? true : undefined}
					aria-describedby={errors.form ? "member-invite-error" : undefined}
				/>
			</Field>
			<MemberAccessFields offer={offer} sites={sites} value={access} onChange={setAccess} error={errors.sites} />
			{errors.form ? <FieldError id="member-invite-error">{t(errors.form)}</FieldError> : null}
		</MemberSheet>
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
		<MemberSheet
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
		</MemberSheet>
	);
}

/** A side panel holding one form, with Cancel and the form's own submit button at the bottom. */
function MemberSheet({
	open,
	onOpenChange,
	trigger,
	finalFocus,
	title,
	description,
	onSubmit,
	submit,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger?: ReactNode;
	finalFocus?: RefObject<HTMLElement | null>;
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
			<SheetContent closeLabel={t("members.sheet.close")} className="w-full sm:max-w-md" finalFocus={finalFocus}>
				<form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
					<SheetHeader className="pe-12">
						<SheetTitle>{title}</SheetTitle>
						<SheetDescription>{description}</SheetDescription>
					</SheetHeader>
					<FieldGroup className="flex-1 gap-6 overflow-y-auto p-4">{children}</FieldGroup>
					<SheetFooter className="flex-row justify-end border-t">
						<SheetClose render={<Button variant="outline" type="button" />}>{t("members.sheet.cancel")}</SheetClose>
						{submit}
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}

/**
 * A role, and every Site of the Workspace (including later ones) or the ones ticked. Only what the
 * person may give is on offer: nobody grants more access than they hold.
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
	return (
		<>
			<FieldSet>
				<FieldLegend variant="label">{t("members.sheet.role")}</FieldLegend>
				<RadioGroup
					value={value.role}
					onValueChange={(role) => onChange(within({ ...value, role: role as WorkspaceRole }, offer))}
				>
					{offer.map(({ role }) => (
						<Field key={role} orientation="horizontal">
							<RadioGroupItem value={role} id={`${id}-${role}`} aria-describedby={`${id}-${role}-help`} />
							<FieldContent>
								<FieldLabel htmlFor={`${id}-${role}`}>{t(`roles.${role}`)}</FieldLabel>
								<FieldDescription id={`${id}-${role}-help`}>{t(`members.sheet.roleHelp.${role}`)}</FieldDescription>
							</FieldContent>
						</Field>
					))}
				</RadioGroup>
			</FieldSet>
			<FieldSet data-invalid={error ? true : undefined}>
				<FieldLegend variant="label">{t("members.sheet.access")}</FieldLegend>
				<RadioGroup value={value.mode} onValueChange={(mode) => onChange({ ...value, mode: mode as Access["mode"] })}>
					<Field orientation="horizontal" data-disabled={choice?.allSites ? undefined : true}>
						<RadioGroupItem
							value="all"
							id={`${id}-all`}
							disabled={!choice?.allSites}
							aria-describedby={`${id}-all-help`}
						/>
						<FieldContent>
							<FieldLabel htmlFor={`${id}-all`}>{t("members.sheet.all")}</FieldLabel>
							<FieldDescription id={`${id}-all-help`}>{t("members.sheet.allHelp")}</FieldDescription>
						</FieldContent>
					</Field>
					<Field orientation="horizontal">
						<RadioGroupItem value="chosen" id={`${id}-chosen`} aria-describedby={`${id}-chosen-help`} />
						<FieldContent>
							<FieldLabel htmlFor={`${id}-chosen`}>{t("members.sheet.chosen")}</FieldLabel>
							<FieldDescription id={`${id}-chosen-help`}>{t("members.sheet.chosenHelp")}</FieldDescription>
						</FieldContent>
					</Field>
				</RadioGroup>
				{value.mode === "chosen" ? (
					sites.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("members.sheet.noSites")}</p>
					) : (
						<FieldSet className="gap-3 ps-7">
							<FieldLegend variant="label" className="sr-only">
								{t("members.sheet.chooseLegend")}
							</FieldLegend>
							{sites.map((site) => {
								const offered = choice?.sites.includes(site.id) ?? false;
								return (
									<Field key={site.id} orientation="horizontal" data-disabled={offered ? undefined : true}>
										<Checkbox
											id={`${id}-${site.id}`}
											checked={value.chosen.includes(site.id)}
											disabled={!offered}
											onCheckedChange={(checked) => toggle(site.id, checked === true)}
											aria-describedby={offered ? undefined : `${id}-${site.id}-help`}
										/>
										<FieldContent>
											<FieldLabel htmlFor={`${id}-${site.id}`} className="font-normal">
												{site.name}
											</FieldLabel>
											{offered ? null : (
												<FieldDescription id={`${id}-${site.id}-help`}>
													{t("members.sheet.notReached")}
												</FieldDescription>
											)}
										</FieldContent>
									</Field>
								);
							})}
						</FieldSet>
					)
				) : null}
				{error ? <FieldError>{t(error)}</FieldError> : null}
			</FieldSet>
			<p className="bg-muted text-muted-foreground flex gap-2 rounded-md px-3 py-2 text-xs">
				<InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				{t("members.sheet.limitNote")}
			</p>
		</>
	);
}
