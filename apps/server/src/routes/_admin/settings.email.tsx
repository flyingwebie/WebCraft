import { createFileRoute, Link } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { isAccentColour, isLogoUrl } from "@webcraft/core/email-branding";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { ScrollTextIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { getApi } from "../../ui/api.ts";
import { SmtpFailingNotice } from "../../ui/email/smtp-parts.tsx";
import { SmtpForm, type SmtpView } from "../../ui/email/SmtpForm.tsx";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import { describedBy as rowHelp, SettingsCard, SettingsRow, SettingsRows, Switch } from "../../ui/settings/layout.tsx";

export const Route = createFileRoute("/_admin/settings/email")({
	staticData: { crumb: "emailSettings.pageTitle", width: "form" },
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

/**
 * Install settings › Email (SMTP): the Install SMTP, a test email, whether Sites' own mail servers may
 * be inside the Install's network, and Install branding.
 */
function EmailSettingsPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { person } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const { smtp, branding } = data;

	return (
		<>
			<PageHeader heading={t("emailSettings.heading")}>{t("emailSettings.intro")}</PageHeader>
			<SettingsForm>
				<div className="grid gap-6">
					<SmtpStatus health={smtp.health} />
					{/* A new form after each save, so it starts from what was saved. */}
					<SmtpForm
						key={JSON.stringify(smtp.settings)}
						view={smtp}
						testTo={person.email}
						layout="cards"
						onSaved={() => undefined}
					/>
					<SiteServers allowPrivate={smtp.sitePrivateServers} />
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
			</SettingsForm>
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

/**
 * Whether a Site's own mail server may be inside the Install's own network. Off unless the Superadmin
 * allows it: Staff name that server, so by default only the public internet is connected to.
 */
function SiteServers({ allowPrivate }: { allowPrivate: boolean }) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const section = useSettingsSection({
		saved: { on: allowPrivate },
		save: async ({ on }) => {
			const api = await getApi();
			await runSensitive(() => api.install.smtp.setSitePrivateServers({ on }));
		},
	});
	return (
		<SettingsCard title={t("emailSettings.siteServers.heading")} description={t("emailSettings.siteServers.intro")}>
			<SettingsRows>
				<SettingsRow
					label={t("emailSettings.siteServers.allowPrivate")}
					help={t("emailSettings.siteServers.allowPrivateHelp")}
					htmlFor="site-private-servers"
				>
					<Switch
						id="site-private-servers"
						checked={section.values.on}
						onCheckedChange={(on) => section.set({ on })}
						aria-describedby={rowHelp("site-private-servers")}
					/>
				</SettingsRow>
			</SettingsRows>
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</SettingsCard>
	);
}

type BrandingField = "logoUrl" | "accentColour";

/** Install branding: the sender name, logo, accent colour and footer of every System email. */
function BrandingForm({ branding }: { branding: Branding }) {
	const t = useT();
	const [errors, setErrors] = useState<Partial<Record<BrandingField, MessageKey>>>({});
	const section = useSettingsSection({
		saved: {
			senderName: branding.senderName ?? "",
			logoUrl: branding.logoUrl ?? "",
			accentColour: branding.accentColour ?? "",
			footer: branding.footer ?? "",
		},
		check: ({ logoUrl, accentColour }) => {
			const found: Partial<Record<BrandingField, MessageKey>> = {};
			if (logoUrl.trim() !== "" && !isLogoUrl(logoUrl.trim())) {
				found.logoUrl = "emailSettings.branding.logoInvalid";
			}
			if (accentColour.trim() !== "" && !isAccentColour(accentColour.trim())) {
				found.accentColour = "emailSettings.branding.colourInvalid";
			}
			setErrors(found);
			const first = (["logoUrl", "accentColour"] as const).find((field) => found[field]);
			if (!first) return null;
			document.getElementById(`branding-${first}`)?.focus();
			return found[first] ?? null;
		},
		save: async (values) => (await getApi()).install.emailBranding.update(values),
	});
	const { senderName, logoUrl, accentColour, footer } = section.values;
	const fieldError = errors.logoUrl ?? errors.accentColour;

	const describedBy = (field: BrandingField, help: string) =>
		[help, errors[field] ? `branding-${field}-error` : undefined].filter(Boolean).join(" ");

	return (
		<SettingsCard title={t("emailSettings.branding.heading")} description={t("emailSettings.branding.intro")}>
			<form {...section.formProps}>
				<FieldGroup className="gap-5">
					<div className="grid gap-5 md:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="branding-senderName">{t("emailSettings.branding.senderName")}</FieldLabel>
							<Input
								id="branding-senderName"
								value={senderName}
								maxLength={80}
								placeholder={branding.defaults.senderName}
								onChange={(event) => section.set({ senderName: event.target.value })}
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
									onChange={(event) => section.set({ accentColour: event.target.value })}
									aria-label={t("emailSettings.branding.pickColour")}
									className="border-input focus-visible:ring-ring/50 focus-visible:border-ring h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 outline-none focus-visible:ring-[3px]"
								/>
								<Input
									id="branding-accentColour"
									value={accentColour}
									placeholder={branding.defaults.accentColour}
									spellCheck={false}
									onChange={(event) => section.set({ accentColour: event.target.value })}
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
							onChange={(event) => section.set({ logoUrl: event.target.value })}
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
							onChange={(event) => section.set({ footer: event.target.value })}
							aria-describedby="branding-footer-help"
						/>
						<FieldDescription id="branding-footer-help">{t("emailSettings.branding.footerHelp")}</FieldDescription>
					</Field>
					{section.error && !fieldError ? <FieldError>{t(section.error)}</FieldError> : null}
				</FieldGroup>
			</form>
		</SettingsCard>
	);
}
