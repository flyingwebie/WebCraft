import { createFileRoute } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { ADMIN_LANGUAGES, type AdminLanguageCode } from "@webcraft/core/admin-languages";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";

import { getApi } from "../../ui/api.ts";
import { formatUtc } from "../../ui/format.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import { SettingsCard } from "../../ui/settings/layout.tsx";

export const Route = createFileRoute("/_admin/settings/general")({
	staticData: { crumb: "generalSettings.pageTitle", width: "form" },
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
			<PageHeader heading={t("generalSettings.heading")}>{t("generalSettings.intro")}</PageHeader>
			<SettingsForm>
				<div className="flex flex-col gap-6">
					<InstallCard settings={settings} />
					<WebCraftVersion check={updates} />
				</div>
			</SettingsForm>
		</>
	);
}

/** The running WebCraft version, and what the last update check found. */
function WebCraftVersion({ check }: { check: Awaited<ReturnType<ApiClient["install"]["updates"]["get"]>> }) {
	const t = useT();
	const latest = check.latest;
	return (
		<SettingsCard
			title={t("generalSettings.version.heading")}
			description={
				!check.enabled
					? t("generalSettings.version.off")
					: check.checkedAt
						? `${t("generalSettings.version.checked", { time: formatUtc(check.checkedAt) })}${check.problem ? ` ${t("generalSettings.version.problem")}` : ""}`
						: t("generalSettings.version.never")
			}
		>
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
		</SettingsCard>
	);
}

/**
 * The Install's name and default Admin language, saved with the settings foot bar: Save stays off
 * until something changed, and leaving with changes not saved asks first.
 */
function InstallCard({ settings }: { settings: { name: string | null; defaultAdminLanguage: AdminLanguageCode } }) {
	const t = useT();
	const section = useSettingsSection({
		saved: { name: settings.name ?? "", language: settings.defaultAdminLanguage },
		save: async ({ name, language }) =>
			(await getApi()).install.settings.update({ name, defaultAdminLanguage: language }),
	});
	return (
		<SettingsCard title={t("generalSettings.installCard")}>
			<form {...section.formProps}>
				<FieldGroup className="gap-6">
					<Field>
						<FieldLabel htmlFor="install-name">{t("generalSettings.name")}</FieldLabel>
						<Input
							id="install-name"
							value={section.values.name}
							maxLength={80}
							onChange={(event) => section.set({ name: event.target.value })}
							aria-describedby="install-name-help"
						/>
						<FieldDescription id="install-name-help">{t("generalSettings.nameHelp")}</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor="install-language">{t("generalSettings.defaultLanguage")}</FieldLabel>
						<NativeSelect
							id="install-language"
							value={section.values.language}
							onChange={(event) => section.set({ language: event.target.value as AdminLanguageCode })}
							aria-describedby="install-language-help"
							className="w-full"
						>
							{ADMIN_LANGUAGES.map((option) => (
								<NativeSelectOption key={option.code} value={option.code} lang={option.code}>
									{option.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<FieldDescription id="install-language-help">{t("generalSettings.defaultLanguageHelp")}</FieldDescription>
					</Field>
					{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
				</FieldGroup>
			</form>
		</SettingsCard>
	);
}
