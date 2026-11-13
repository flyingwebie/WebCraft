import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { ADMIN_LANGUAGES, type AdminLanguageCode } from "@webcraft/core/admin-languages";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/settings/general")({
	staticData: { crumb: "generalSettings.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return { settings: null, updates: null };
		const api = await getApi();
		const [settings, updates] = await Promise.all([api.install.settings.get(), api.install.updates.get()]);
		return { settings, updates };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "generalSettings.pageTitle") }],
	}),
	component: GeneralSettingsPage,
});

/** Install settings › General: the Install's name and default Admin language, and its WebCraft version. */
function GeneralSettingsPage() {
	const t = useT();
	const { settings, updates } = Route.useLoaderData();
	if (!settings || !updates) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<GeneralSettingsForm settings={settings} />
			<WebCraftVersion check={updates} />
		</>
	);
}

/** The running WebCraft version, and what the last update check found. */
function WebCraftVersion({ check }: { check: Awaited<ReturnType<ApiClient["install"]["updates"]["get"]>> }) {
	const t = useT();
	const latest = check.latest;
	return (
		<section aria-labelledby="webcraft-version-heading" className="mt-10 grid max-w-xl gap-2 text-sm">
			<h2 id="webcraft-version-heading" className="text-lg font-semibold tracking-tight">
				{t("generalSettings.version.heading")}
			</h2>
			<p>
				{t("generalSettings.version.running", { version: check.running })}{" "}
				{check.updateAvailable && latest
					? t("generalSettings.version.newer", { version: latest.version })
					: latest
						? t("generalSettings.version.newest")
						: null}
			</p>
			{check.updateAvailable && latest?.url ? (
				<p>
					<a
						href={latest.url}
						target="_blank"
						rel="noreferrer noopener"
						className="focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
					>
						{t("generalSettings.version.notes")}
					</a>
				</p>
			) : null}
			{check.updateAvailable && latest?.notes ? (
				<pre className="bg-muted max-h-64 overflow-auto rounded-md border p-3 font-sans text-sm whitespace-pre-wrap">
					{latest.notes}
				</pre>
			) : null}
			<p className="text-muted-foreground">
				{!check.enabled
					? t("generalSettings.version.off")
					: check.checkedAt
						? `${t("generalSettings.version.checked", { time: formatUtc(check.checkedAt) })}${check.problem ? ` ${t("generalSettings.version.problem")}` : ""}`
						: t("generalSettings.version.never")}
			</p>
		</section>
	);
}

function GeneralSettingsForm({
	settings,
}: {
	settings: { name: string | null; defaultAdminLanguage: AdminLanguageCode };
}) {
	const t = useT();
	const router = useRouter();
	const [name, setName] = useState(settings.name ?? "");
	const [language, setLanguage] = useState<AdminLanguageCode>(settings.defaultAdminLanguage);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.install.settings.update({ name, defaultAdminLanguage: language });
			toast.success(t("generalSettings.saved"));
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHeader heading={t("generalSettings.heading")}>{t("generalSettings.intro")}</PageHeader>
			<form onSubmit={submit} className="max-w-xl" noValidate>
				<FieldGroup className="gap-6">
					<Field>
						<FieldLabel htmlFor="install-name">{t("generalSettings.name")}</FieldLabel>
						<Input
							id="install-name"
							value={name}
							maxLength={80}
							onChange={(event) => setName(event.target.value)}
							aria-describedby="install-name-help"
						/>
						<FieldDescription id="install-name-help">{t("generalSettings.nameHelp")}</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor="install-language">{t("generalSettings.defaultLanguage")}</FieldLabel>
						<NativeSelect
							id="install-language"
							value={language}
							onChange={(event) => setLanguage(event.target.value as AdminLanguageCode)}
							aria-describedby="install-language-help"
						>
							{ADMIN_LANGUAGES.map((option) => (
								<NativeSelectOption key={option.code} value={option.code} lang={option.code}>
									{option.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<FieldDescription id="install-language-help">{t("generalSettings.defaultLanguageHelp")}</FieldDescription>
					</Field>
					{error ? <FieldError>{t(error)}</FieldError> : null}
					<div>
						<Button type="submit" disabled={busy}>
							{t("generalSettings.save")}
						</Button>
					</div>
				</FieldGroup>
			</form>
		</>
	);
}
