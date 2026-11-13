import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { ADMIN_LANGUAGES, type AdminLanguageCode } from "@webcraft/core/admin-languages";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { type FormEvent, useState } from "react";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { SaveBar, type SaveState } from "../../ui/shell/page.tsx";

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

/**
 * The Install's name and default Admin language, saved with the settings foot bar: Save stays off
 * until something changed, and leaving with changes not saved asks first.
 */
function GeneralSettingsForm({
	settings,
}: {
	settings: { name: string | null; defaultAdminLanguage: AdminLanguageCode };
}) {
	const t = useT();
	const router = useRouter();
	const saved = { name: settings.name ?? "", language: settings.defaultAdminLanguage };
	const [name, setName] = useState(saved.name);
	const [language, setLanguage] = useState<AdminLanguageCode>(saved.language);
	const [error, setError] = useState<MessageKey | null>(null);
	const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
	const changed = name !== saved.name || language !== saved.language;
	const saveState: SaveState =
		state === "saving"
			? "saving"
			: state === "failed"
				? "failed"
				: changed
					? "dirty"
					: state === "saved"
						? "saved"
						: "clean";

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!changed && state !== "failed") return;
		setState("saving");
		setError(null);
		try {
			const api = await getApi();
			await api.install.settings.update({ name, defaultAdminLanguage: language });
			await router.invalidate();
			setState("saved");
		} catch (failure) {
			setError(errorMessage(failure));
			setState("failed");
		}
	};

	const edit = () => {
		if (state !== "saving") setState("idle");
	};

	return (
		<>
			<PageHeader heading={t("generalSettings.heading")}>{t("generalSettings.intro")}</PageHeader>
			<form id="install-general" onSubmit={submit} noValidate>
				<FieldGroup className="gap-6">
					<Field>
						<FieldLabel htmlFor="install-name">{t("generalSettings.name")}</FieldLabel>
						<Input
							id="install-name"
							value={name}
							maxLength={80}
							onChange={(event) => {
								setName(event.target.value);
								edit();
							}}
							aria-describedby="install-name-help"
						/>
						<FieldDescription id="install-name-help">{t("generalSettings.nameHelp")}</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor="install-language">{t("generalSettings.defaultLanguage")}</FieldLabel>
						<NativeSelect
							id="install-language"
							value={language}
							onChange={(event) => {
								setLanguage(event.target.value as AdminLanguageCode);
								edit();
							}}
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
				</FieldGroup>
			</form>
			<SaveBar
				state={saveState}
				form="install-general"
				onDiscard={() => {
					setName(saved.name);
					setLanguage(saved.language);
					setError(null);
					setState("idle");
				}}
			/>
		</>
	);
}
