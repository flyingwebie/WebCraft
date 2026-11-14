import { createFileRoute, Link, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { AuthHeading, AuthLead, AuthPage, BrandMark, PasswordRules } from "../ui/auth/AuthPage.tsx";
import { errorCode, errorMessage } from "../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../ui/i18n.tsx";
import { PasswordInput } from "../ui/PasswordInput.tsx";

export const Route = createFileRoute("/invite")({
	// The link in the invite email carries the invite's token.
	validateSearch: z.object({ token: z.string().max(512).optional() }),
	beforeLoad: ({ context }) => {
		if (context.shell.setup.stage === "claim") throw redirect({ to: "/setup" });
	},
	// Loaded once: the token then leaves the address bar (see InvitePage), which must not load the
	// page again without it.
	shouldReload: false,
	loader: async ({ location }) => {
		const token = (location.search as { token?: string }).token;
		if (!token) return { invite: null, token: null };
		const api = await getApi();
		try {
			return { invite: await api.invites.get({ token }), token };
		} catch (error) {
			if (errorCode(error) === "INVITE_INVALID") return { invite: null, token: null };
			throw error;
		}
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "invite.pageTitle") }] }),
	component: InvitePage,
});

/**
 * Accepting an invite. A new person chooses their name and password, and is signed in; a person who
 * already has an account (a Member invite to their address) signs in and joins the Workspace.
 */
function InvitePage() {
	const t = useT();
	const navigate = useNavigate();
	const { invite, token } = Route.useLoaderData();
	const { token: linked } = Route.useSearch();

	// The token has been read: take it out of the address bar, so it stays out of the browser's history.
	useEffect(() => {
		if (linked) void navigate({ to: "/invite", search: {}, replace: true });
	}, [linked, navigate]);

	if (!invite || !token) {
		return (
			<AuthPage>
				<div className="grid gap-3">
					<AuthHeading>{t("invite.invalid.heading")}</AuthHeading>
					<AuthLead>{t("invite.invalid.body")}</AuthLead>
					<Button variant="outline" className="mt-1 w-full" render={<Link to="/sign-in" />}>
						{t("invite.invalid.signIn")}
					</Button>
				</div>
			</AuthPage>
		);
	}

	return (
		<AuthPage width="invite" below={<ReachedSites invite={invite} />}>
			{invite.workspace ? <BrandMark name={invite.workspace.name} size="small" /> : null}
			<InviteHeading invite={invite} />
			{invite.hasAccount ? <JoinForm invite={invite} token={token} /> : <AcceptForm invite={invite} token={token} />}
		</AuthPage>
	);
}

type Invite = NonNullable<ReturnType<typeof Route.useLoaderData>["invite"]>;

/** The Workspace role a Member invite grants. */
function workspaceRole(role: string) {
	return (["owner", "editor", "author"] as const).find((key) => key === role);
}

/** Who invited the person, where to and as what, in one line; then what that role does. */
function InviteHeading({ invite }: { invite: Invite }) {
	const t = useT();
	const install = invite.installName ?? t("app.name");
	const role = workspaceRole(invite.role);
	const heading =
		invite.workspace && role
			? invite.invitedBy
				? t("invite.memberHeading", {
						inviter: invite.invitedBy,
						workspace: invite.workspace.name,
						role: t(`roles.${role}`),
					})
				: t("invite.memberHeadingNoInviter", { workspace: invite.workspace.name, role: t(`roles.${role}`) })
			: invite.invitedBy
				? t("invite.heading", { inviter: invite.invitedBy, install })
				: t("invite.headingNoInviter", { install });
	return (
		<div className="grid gap-1.5">
			<AuthHeading>{heading}</AuthHeading>
			<AuthLead>{role ? t(`invite.roleHelp.${role}`) : t("invite.roleHelp.staff")}</AuthLead>
		</div>
	);
}

/** Under the card: the Sites a Member invite reaches. A Staff invite reaches Workspaces, not Sites. */
function ReachedSites({ invite }: { invite: Invite }) {
	const t = useT();
	if (!invite.sites || !invite.workspace) return null;
	return (
		<p>
			{invite.sites === "all"
				? t("invite.sitesAll", { workspace: invite.workspace.name })
				: t("invite.sites", { sites: invite.sites.join(", "), count: invite.sites.length })}
		</p>
	);
}

/** Creating an account with the invite. */
function AcceptForm({ invite, token }: { invite: Invite; token: string }) {
	const t = useT();
	const router = useRouter();
	const { shell } = Route.useRouteContext();
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [errors, setErrors] = useState<{ name?: MessageKey; password?: MessageKey; form?: MessageKey }>({});
	const [busy, setBusy] = useState(false);
	const joining = invite.workspace?.name ?? invite.installName ?? t("app.name");

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setErrors({ name: "invite.nameRequired" });
			return;
		}
		setBusy(true);
		setErrors({});
		try {
			const api = await getApi();
			const { workspaceId } = await api.invites.accept({ token, name, password, adminLanguage: shell.language.code });
			// Every navigation reloads the shell context, so the admin knows who signed in.
			if (workspaceId) await router.navigate({ to: "/workspaces/$workspaceId", params: { workspaceId } });
			else await router.navigate({ to: "/" });
		} catch (failure) {
			const message = errorMessage(failure);
			setErrors(errorCode(failure) === "PASSWORD_REFUSED" ? { password: message } : { form: message });
			setBusy(false);
		}
	};

	return (
		<form onSubmit={submit} noValidate>
			{/* Lets password managers save the new password under the right address. */}
			<input type="hidden" name="username" autoComplete="username" value={invite.email} />
			<FieldGroup className="gap-4">
				<Field className="gap-2" data-invalid={errors.name ? true : undefined}>
					<FieldLabel htmlFor="invite-name">{t("invite.name")}</FieldLabel>
					<Input
						id="invite-name"
						value={name}
						maxLength={200}
						autoComplete="name"
						onChange={(event) => setName(event.target.value)}
						aria-invalid={errors.name ? true : undefined}
						aria-describedby={errors.name ? "invite-name-error" : undefined}
					/>
					{errors.name ? <FieldError id="invite-name-error">{t(errors.name)}</FieldError> : null}
				</Field>
				<Field className="gap-2" data-invalid={errors.password ? true : undefined}>
					<FieldLabel htmlFor="invite-password">{t("invite.password")}</FieldLabel>
					<PasswordInput
						id="invite-password"
						value={password}
						autoComplete="new-password"
						onChange={(event) => setPassword(event.target.value)}
						aria-invalid={errors.password ? true : undefined}
						aria-describedby={errors.password ? "invite-password-rules invite-password-error" : "invite-password-rules"}
					/>
					{errors.password ? <FieldError id="invite-password-error">{t(errors.password)}</FieldError> : null}
				</Field>
				<PasswordRules id="invite-password-rules" password={password} />
				{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
				<Button type="submit" disabled={busy} className="w-full">
					{t("invite.submit", { name: joining })}
				</Button>
			</FieldGroup>
		</form>
	);
}

/**
 * Joining a Workspace with an account the person already has: signed in with the invited address,
 * one button; otherwise they sign in with it first.
 */
function JoinForm({ invite, token }: { invite: Invite; token: string }) {
	const t = useT();
	const router = useRouter();
	const { shell } = Route.useRouteContext();
	const [password, setPassword] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const workspace = invite.workspace?.name ?? "";
	const signedInAsInvited = shell.person?.email === invite.email;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			if (!signedInAsInvited) await api.session.signIn({ email: invite.email, password });
			const { workspaceId } = await api.invites.join({ token });
			// Every navigation reloads the shell context, so the admin knows who signed in. A Staff invite
			// has no Workspace: Staff start at the Install's overview.
			if (workspaceId) await router.navigate({ to: "/workspaces/$workspaceId", params: { workspaceId } });
			else await router.navigate({ to: "/" });
		} catch (failure) {
			setError(errorMessage(failure));
			setBusy(false);
		}
	};

	return (
		<form onSubmit={submit} noValidate>
			<FieldGroup className="gap-4">
				{signedInAsInvited ? (
					<AuthLead className="text-foreground">{t("invite.join.signedInAs", { email: invite.email })}</AuthLead>
				) : (
					<>
						<AuthLead>
							{shell.person
								? t("invite.join.otherAccount", { current: shell.person.email, email: invite.email })
								: t("invite.join.haveAccount", { email: invite.email })}
						</AuthLead>
						<input type="hidden" name="username" autoComplete="username" value={invite.email} />
						<Field className="gap-2" data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="invite-join-password">{t("invite.join.password")}</FieldLabel>
							<PasswordInput
								id="invite-join-password"
								value={password}
								autoComplete="current-password"
								onChange={(event) => setPassword(event.target.value)}
								aria-invalid={error ? true : undefined}
								aria-describedby={error ? "invite-join-error" : undefined}
							/>
						</Field>
					</>
				)}
				{error ? <FieldError id="invite-join-error">{t(error)}</FieldError> : null}
				<Button type="submit" disabled={busy} className="w-full">
					{signedInAsInvited ? t("invite.join.submit", { workspace }) : t("invite.join.signIn")}
				</Button>
			</FieldGroup>
		</form>
	);
}
