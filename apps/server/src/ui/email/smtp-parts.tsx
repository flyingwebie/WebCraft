/**
 * What the Install SMTP form (Install settings › Email, and the setup wizard) and a Site's SMTP form
 * (Site › Email) share: the security choices, the address check, the password field that never shows
 * a stored password, a test email's result, the form's sections and the notice of a failing server.
 */
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { CircleAlertIcon, CircleCheckIcon, LockIcon } from "lucide-react";
import { type ReactNode, type RefObject, useId } from "react";

import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PasswordInput } from "../PasswordInput.tsx";

export type Security = "starttls" | "tls" | "none";

export const SECURITY_OPTIONS: { value: Security; label: MessageKey; port: number }[] = [
	{ value: "starttls", label: "emailSettings.server.securityStarttls", port: 587 },
	{ value: "tls", label: "emailSettings.server.securityTls", port: 465 },
	{ value: "none", label: "emailSettings.server.securityNone", port: 25 },
];

/** What an email address looks like, as the forms check it before the server does. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A server that keeps failing: how many sends in a row, since when, and what it last answered. */
export function SmtpFailingNotice({
	title,
	health,
}: {
	title: string;
	health: { failuresInARow: number; failingSince: Date | string | null; lastResponse: string | null };
}) {
	const t = useT();
	return (
		<div className="border-destructive/60 bg-card flex items-start gap-3 rounded-lg border px-4 py-3">
			<CircleAlertIcon className="text-destructive mt-0.5 size-5 shrink-0" aria-hidden="true" />
			<div className="min-w-0 space-y-1">
				<h2 className="font-semibold">{title}</h2>
				<p className="text-sm">
					{t("emailSettings.status.failingBody", {
						count: health.failuresInARow,
						since: health.failingSince ? formatUtc(health.failingSince) : "",
					})}
				</p>
				{health.lastResponse ? (
					<p className="text-sm break-words">
						{t("emailSettings.status.lastResponse", { response: health.lastResponse })}
					</p>
				) : null}
			</div>
		</div>
	);
}

export function PasswordField({
	inputId,
	stored,
	replacing,
	password,
	setPassword,
	disabled,
	replaceButton,
	onReplace,
	onKeep,
}: {
	/** The password input's id (the form focuses it when Replace is pressed). */
	inputId: string;
	stored: { lastFour: string | null } | null;
	replacing: boolean;
	password: string;
	setPassword(value: string): void;
	disabled: boolean;
	replaceButton: RefObject<HTMLButtonElement | null>;
	onReplace(): void;
	onKeep(): void;
}) {
	const t = useT();
	const labelId = useId();
	if (stored && !replacing) {
		const status = stored.lastFour
			? t("emailSettings.server.passwordSet", { lastFour: stored.lastFour })
			: t("emailSettings.server.passwordSetHidden");
		return (
			<Field>
				<p id={labelId} className="text-sm font-medium">
					{t("emailSettings.server.password")}
				</p>
				<div className="flex items-center gap-3">
					<p
						id={`${labelId}-status`}
						className="bg-muted text-muted-foreground flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm"
					>
						<LockIcon className="size-4 shrink-0" aria-hidden="true" />
						{status}
					</p>
					<Button
						ref={replaceButton}
						type="button"
						variant="outline"
						onClick={onReplace}
						aria-describedby={`${labelId} ${labelId}-status`}
					>
						{t("emailSettings.server.replace")}
					</Button>
				</div>
				<FieldDescription>{t("emailSettings.server.passwordHelp")}</FieldDescription>
			</Field>
		);
	}
	return (
		<Field>
			<FieldLabel htmlFor={inputId}>{t("emailSettings.server.password")}</FieldLabel>
			<PasswordInput
				id={inputId}
				value={password}
				onChange={(event) => setPassword(event.target.value)}
				autoComplete="new-password"
				disabled={disabled}
				aria-describedby={`${inputId}-help`}
			/>
			<FieldDescription id={`${inputId}-help`}>{t("emailSettings.server.passwordHelp")}</FieldDescription>
			{stored ? (
				<div>
					<Button type="button" variant="outline" size="sm" onClick={onKeep}>
						{t("emailSettings.server.keep")}
					</Button>
				</div>
			) : null}
		</Field>
	);
}

export function TestResult({ result }: { result: { status: "sent" | "failed"; response: string; to: string } }) {
	const t = useT();
	const sent = result.status === "sent";
	return (
		<div
			className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${
				sent ? "border-success-border bg-success text-success-foreground" : "border-destructive/60 bg-card"
			}`}
		>
			{sent ? (
				<CircleCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			) : (
				<CircleAlertIcon className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
			)}
			<div className="min-w-0 space-y-1">
				<p className="font-medium">
					{sent
						? t("emailSettings.test.delivered", { to: result.to })
						: t("emailSettings.test.failed", { to: result.to })}
				</p>
				<p className="break-words">{t("emailSettings.test.response", { response: result.response })}</p>
			</div>
		</div>
	);
}

/** One part of the form: a card on the settings page, a plain section in the wizard. */
export function Section({
	layout = "cards",
	heading,
	intro,
	children,
}: {
	layout?: "cards" | "plain";
	heading: string;
	intro?: string;
	children: ReactNode;
}) {
	const id = useId();
	if (layout === "cards") {
		return (
			<Card>
				<CardHeader>
					<CardTitle>
						<h2 id={id}>{heading}</h2>
					</CardTitle>
					{intro ? <CardDescription>{intro}</CardDescription> : null}
				</CardHeader>
				<CardContent>{children}</CardContent>
			</Card>
		);
	}
	return (
		<section aria-labelledby={id} className="flex flex-col gap-4">
			<div className="space-y-1">
				<h2 id={id} className="font-medium">
					{heading}
				</h2>
				{intro ? <p className="text-muted-foreground text-sm">{intro}</p> : null}
			</div>
			{children}
		</section>
	);
}
