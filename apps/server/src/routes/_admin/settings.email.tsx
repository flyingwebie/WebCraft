import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { isAccentColour, isLogoUrl } from "@webcraft/core/email-branding";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { ScrollTextIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { SmtpForm, type SmtpView } from "../../ui/email/SmtpForm.tsx";
import { SmtpFailingNotice } from "../../ui/email/smtp-parts.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/settings/email")({
	staticData: { crumb: "emailSettings.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return null;
		const api = await getApi();
		const [smtp, branding] = await Promise.all([api.install.smtp.get(), api.install.emailBranding.get()]);
		return { smtp, branding };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "emailSettings.pageTitle") }],
	}),
	component: EmailSettingsPage,
});

type Branding = Awaited<ReturnType<ApiClient["install"]["emailBranding"]["get"]>>;

/** Install settings › Email (SMTP): the Install SMTP, a test email, and Install branding. */
function EmailSettingsPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { person } = Route.useRouteContext();
	const router = useRouter();
	// A new form after each save, so it starts from what was saved.
	const [version, setVersion] = useState(0);
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const { smtp, branding } = data;

	return (
		<>
			<PageHeader heading={t("emailSettings.heading")}>{t("emailSettings.intro")}</PageHeader>
			<div className="grid gap-6">
				<SmtpStatus health={smtp.health} />
				<SmtpForm
					key={version}
					view={smtp}
					testTo={person.email}
					layout="cards"
					onSaved={async (_saved: SmtpView) => {
						toast.success(t("emailSettings.saved"));
						await router.invalidate();
						setVersion((current) => current + 1);
					}}
					actions={({ busy }) => (
						<>
							<Button type="button" variant="outline" onClick={() => setVersion((current) => current + 1)}>
								{t("emailSettings.discard")}
							</Button>
							<Button type="submit" disabled={busy}>
								{t("emailSettings.save")}
							</Button>
						</>
					)}
				/>
				<BrandingForm branding={branding} />
				<p>
					<Link
						to="/email-log"
						className="inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
					>
						<ScrollTextIcon className="size-4" aria-hidden="true" />
						{t("emailSettings.emailLogLink")}
					</Link>
				</p>
			</div>
		</>
	);
}

/** Says when there is no SMTP yet, or when it is Failing. */
function SmtpStatus({ health }: { health: SmtpView["health"] }) {
	const t = useT();
	if (health.state === "not-set") {
		return (
			<div className="border-warning-border bg-warning text-warning-foreground flex items-start gap-3 rounded-lg border px-4 py-3">
				<TriangleAlertIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div className="space-y-1">
					<h2 className="font-semibold">{t("emailSettings.status.notSetTitle")}</h2>
					<p className="text-sm">{t("emailSettings.status.notSetBody")}</p>
				</div>
			</div>
		);
	}
	if (health.state === "failing") {
		return <SmtpFailingNotice title={t("emailSettings.status.failingTitle")} health={health} />;
	}
	return null;
}

type BrandingField = "logoUrl" | "accentColour" | "form";

/** Install branding: the sender name, logo, accent colour and footer of every System email. */
function BrandingForm({ branding }: { branding: Branding }) {
	const t = useT();
	const router = useRouter();
	const [senderName, setSenderName] = useState(branding.senderName ?? "");
	const [logoUrl, setLogoUrl] = useState(branding.logoUrl ?? "");
	const [accentColour, setAccentColour] = useState(branding.accentColour ?? "");
	const [footer, setFooter] = useState(branding.footer ?? "");
	const [errors, setErrors] = useState<Partial<Record<BrandingField, MessageKey>>>({});
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const found: Partial<Record<BrandingField, MessageKey>> = {};
		if (logoUrl.trim() !== "" && !isLogoUrl(logoUrl.trim())) {
			found.logoUrl = "emailSettings.branding.logoInvalid";
		}
		if (accentColour.trim() !== "" && !isAccentColour(accentColour.trim())) {
			found.accentColour = "emailSettings.branding.colourInvalid";
		}
		setErrors(found);
		const first = (["logoUrl", "accentColour"] as const).find((field) => found[field]);
		if (first) {
			document.getElementById(`branding-${first}`)?.focus();
			return;
		}
		setBusy(true);
		try {
			const api = await getApi();
			await api.install.emailBranding.update({ senderName, logoUrl, accentColour, footer });
			toast.success(t("emailSettings.saved"));
			await router.invalidate();
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	const describedBy = (field: BrandingField, help: string) =>
		[help, errors[field] ? `branding-${field}-error` : undefined].filter(Boolean).join(" ");

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("emailSettings.branding.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("emailSettings.branding.intro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} noValidate>
					<FieldGroup className="gap-5">
						<div className="grid gap-5 md:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="branding-senderName">{t("emailSettings.branding.senderName")}</FieldLabel>
								<Input
									id="branding-senderName"
									value={senderName}
									maxLength={80}
									placeholder={branding.defaults.senderName}
									onChange={(event) => setSenderName(event.target.value)}
									aria-describedby="branding-senderName-help"
								/>
								<FieldDescription id="branding-senderName-help">
									{t("emailSettings.branding.senderNameHelp", { name: branding.defaults.senderName })}
								</FieldDescription>
							</Field>
							<Field data-invalid={errors.accentColour ? true : undefined}>
								<FieldLabel htmlFor="branding-accentColour">{t("emailSettings.branding.accentColour")}</FieldLabel>
								<div className="flex gap-3">
									<input
										type="color"
										value={/^#[0-9a-f]{6}$/i.test(accentColour) ? accentColour : branding.defaults.accentColour}
										onChange={(event) => setAccentColour(event.target.value)}
										aria-label={t("emailSettings.branding.pickColour")}
										className="border-input focus-visible:ring-ring/50 focus-visible:border-ring h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 outline-none focus-visible:ring-[3px]"
									/>
									<Input
										id="branding-accentColour"
										value={accentColour}
										placeholder={branding.defaults.accentColour}
										spellCheck={false}
										onChange={(event) => setAccentColour(event.target.value)}
										aria-invalid={errors.accentColour ? true : undefined}
										aria-describedby={describedBy("accentColour", "branding-accentColour-help")}
									/>
								</div>
								<FieldDescription id="branding-accentColour-help">
									{t("emailSettings.branding.accentColourHelp", { colour: branding.defaults.accentColour })}
								</FieldDescription>
								{errors.accentColour ? (
									<FieldError id="branding-accentColour-error">{t(errors.accentColour)}</FieldError>
								) : null}
							</Field>
						</div>
						<Field data-invalid={errors.logoUrl ? true : undefined}>
							<FieldLabel htmlFor="branding-logoUrl">{t("emailSettings.branding.logoUrl")}</FieldLabel>
							<Input
								id="branding-logoUrl"
								type="url"
								value={logoUrl}
								placeholder="https://"
								spellCheck={false}
								onChange={(event) => setLogoUrl(event.target.value)}
								aria-invalid={errors.logoUrl ? true : undefined}
								aria-describedby={describedBy("logoUrl", "branding-logoUrl-help")}
							/>
							<FieldDescription id="branding-logoUrl-help">{t("emailSettings.branding.logoUrlHelp")}</FieldDescription>
							{errors.logoUrl ? <FieldError id="branding-logoUrl-error">{t(errors.logoUrl)}</FieldError> : null}
						</Field>
						<Field>
							<FieldLabel htmlFor="branding-footer">{t("emailSettings.branding.footer")}</FieldLabel>
							<Textarea
								id="branding-footer"
								value={footer}
								maxLength={500}
								rows={3}
								onChange={(event) => setFooter(event.target.value)}
								aria-describedby="branding-footer-help"
							/>
							<FieldDescription id="branding-footer-help">{t("emailSettings.branding.footerHelp")}</FieldDescription>
						</Field>
						{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
						<div className="flex justify-end">
							<Button type="submit" disabled={busy}>
								{t("emailSettings.branding.save")}
							</Button>
						</div>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}
