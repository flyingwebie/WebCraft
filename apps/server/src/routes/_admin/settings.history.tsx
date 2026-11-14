import { createFileRoute } from "@tanstack/react-router";
import { FieldError } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { useState } from "react";

import { getApi } from "../../ui/api.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import { describedBy as rowHelp, SettingsCard, SettingsRow, SettingsRows, Switch } from "../../ui/settings/layout.tsx";

export const Route = createFileRoute("/_admin/settings/history")({
	staticData: { crumb: "historySettings.pageTitle", width: "form" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return { settings: null };
		const api = await getApi();
		return { settings: await api.install.history.get() };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "historySettings.pageTitle") }],
	}),
	component: HistorySettingsPage,
});

type Settings = { revisionsOn: boolean; revisionDays: number; revisionsKept: number; checkpointDays: number };

/** Install settings › Revisions: whether publishing saves Revisions, and how long they and Checkpoints are kept. */
function HistorySettingsPage() {
	const t = useT();
	const { settings } = Route.useLoaderData();
	if (!settings) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<SettingsForm>
			<HistorySettingsForm settings={settings} />
		</SettingsForm>
	);
}

/** The limits the server keeps (`HISTORY_LIMITS` in `@webcraft/core`). */
const LIMITS = {
	revisionDays: { min: 1, max: 3650 },
	revisionsKept: { min: 0, max: 1000 },
	checkpointDays: { min: 1, max: 365 },
} as const;

function HistorySettingsForm({ settings }: { settings: Settings }) {
	const t = useT();
	const [invalid, setInvalid] = useState<(keyof typeof LIMITS)[]>([]);
	const section = useSettingsSection({
		saved: {
			revisionsOn: settings.revisionsOn,
			revisionDays: String(settings.revisionDays),
			revisionsKept: String(settings.revisionsKept),
			checkpointDays: String(settings.checkpointDays),
		},
		check: (numbers) => {
			const wrong = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).filter((key) => {
				const value = Number(numbers[key]);
				return (
					numbers[key].trim() === "" || !Number.isInteger(value) || value < LIMITS[key].min || value > LIMITS[key].max
				);
			});
			setInvalid(wrong);
			const first = wrong[0];
			if (!first) return null;
			document.getElementById(`history-${first}`)?.focus();
			return "historySettings.invalid";
		},
		save: async ({ revisionsOn, revisionDays, revisionsKept, checkpointDays }) =>
			(await getApi()).install.history.update({
				revisionsOn,
				revisionDays: Number(revisionDays),
				revisionsKept: Number(revisionsKept),
				checkpointDays: Number(checkpointDays),
			}),
	});

	const number = (key: keyof typeof LIMITS, label: MessageKey, help: MessageKey) => (
		<SettingsRow label={t(label)} help={t(help)} htmlFor={`history-${key}`}>
			<div className="flex flex-col items-end gap-1">
				<Input
					id={`history-${key}`}
					type="number"
					inputMode="numeric"
					min={LIMITS[key].min}
					max={LIMITS[key].max}
					value={section.values[key]}
					onChange={(event) => section.set({ [key]: event.target.value })}
					aria-describedby={`${rowHelp(`history-${key}`)}${invalid.includes(key) ? ` history-${key}-error` : ""}`}
					aria-invalid={invalid.includes(key) || undefined}
					className="w-28"
				/>
				{invalid.includes(key) ? (
					<FieldError id={`history-${key}-error`}>
						{t("historySettings.outOfRange", { min: LIMITS[key].min, max: LIMITS[key].max })}
					</FieldError>
				) : null}
			</div>
		</SettingsRow>
	);

	return (
		<>
			<PageHeader heading={t("historySettings.heading")}>{t("historySettings.intro")}</PageHeader>
			<form {...section.formProps} className="flex flex-col gap-6">
				<SettingsCard title={t("historySettings.revisionsCard")}>
					<SettingsRows>
						<SettingsRow
							label={t("historySettings.revisionsOn")}
							help={t("historySettings.revisionsOnHelp")}
							htmlFor="history-revisions-on"
						>
							<Switch
								id="history-revisions-on"
								checked={section.values.revisionsOn}
								onCheckedChange={(revisionsOn) => section.set({ revisionsOn })}
								aria-describedby={rowHelp("history-revisions-on")}
							/>
						</SettingsRow>
						{number("revisionDays", "historySettings.revisionDays", "historySettings.revisionDaysHelp")}
						{number("revisionsKept", "historySettings.revisionsKept", "historySettings.revisionsKeptHelp")}
					</SettingsRows>
				</SettingsCard>
				<SettingsCard title={t("historySettings.checkpointsCard")}>
					<SettingsRows>
						{number("checkpointDays", "historySettings.checkpointDays", "historySettings.checkpointDaysHelp")}
					</SettingsRows>
				</SettingsCard>
				{section.error && section.error !== "historySettings.invalid" ? (
					<FieldError>{t(section.error)}</FieldError>
				) : null}
			</form>
		</>
	);
}
