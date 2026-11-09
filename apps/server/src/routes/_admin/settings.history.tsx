import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/settings/history")({
	staticData: { crumb: "historySettings.pageTitle" },
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
	return <HistorySettingsForm settings={settings} />;
}

/** The limits the server keeps (`HISTORY_LIMITS` in `@webcraft/core`). */
const LIMITS = {
	revisionDays: { min: 1, max: 3650 },
	revisionsKept: { min: 0, max: 1000 },
	checkpointDays: { min: 1, max: 365 },
} as const;

function HistorySettingsForm({ settings }: { settings: Settings }) {
	const t = useT();
	const router = useRouter();
	const [revisionsOn, setRevisionsOn] = useState(settings.revisionsOn);
	const [numbers, setNumbers] = useState({
		revisionDays: String(settings.revisionDays),
		revisionsKept: String(settings.revisionsKept),
		checkpointDays: String(settings.checkpointDays),
	});
	const [invalid, setInvalid] = useState<(keyof typeof LIMITS)[]>([]);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const values = Object.fromEntries(
			(Object.keys(LIMITS) as (keyof typeof LIMITS)[]).map((key) => [key, Number(numbers[key])]),
		) as Record<keyof typeof LIMITS, number>;
		const wrong = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).filter(
			(key) =>
				numbers[key].trim() === "" ||
				!Number.isInteger(values[key]) ||
				values[key] < LIMITS[key].min ||
				values[key] > LIMITS[key].max,
		);
		setInvalid(wrong);
		if (wrong.length > 0) {
			document.getElementById(`history-${wrong[0]}`)?.focus();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.install.history.update({ revisionsOn, ...values });
			toast.success(t("historySettings.saved"));
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const number = (key: keyof typeof LIMITS, label: MessageKey, help: MessageKey) => (
		<Field data-invalid={invalid.includes(key) || undefined}>
			<FieldLabel htmlFor={`history-${key}`}>{t(label)}</FieldLabel>
			<Input
				id={`history-${key}`}
				type="number"
				inputMode="numeric"
				min={LIMITS[key].min}
				max={LIMITS[key].max}
				value={numbers[key]}
				onChange={(event) => setNumbers((before) => ({ ...before, [key]: event.target.value }))}
				aria-describedby={`history-${key}-help${invalid.includes(key) ? ` history-${key}-error` : ""}`}
				aria-invalid={invalid.includes(key) || undefined}
				className="max-w-32"
			/>
			<FieldDescription id={`history-${key}-help`}>{t(help)}</FieldDescription>
			{invalid.includes(key) ? (
				<FieldError id={`history-${key}-error`}>
					{t("historySettings.outOfRange", { min: LIMITS[key].min, max: LIMITS[key].max })}
				</FieldError>
			) : null}
		</Field>
	);

	return (
		<>
			<PageHeader heading={t("historySettings.heading")}>{t("historySettings.intro")}</PageHeader>
			<form onSubmit={submit} className="max-w-xl" noValidate>
				<FieldGroup className="gap-6">
					<label className="flex items-start gap-3 text-sm">
						<input
							type="checkbox"
							checked={revisionsOn}
							onChange={(event) => setRevisionsOn(event.target.checked)}
							aria-describedby="history-revisions-on-help"
							className="accent-primary mt-0.5 size-4 shrink-0"
						/>
						<span className="flex flex-col gap-1">
							<span className="font-medium">{t("historySettings.revisionsOn")}</span>
							<span id="history-revisions-on-help" className="text-muted-foreground">
								{t("historySettings.revisionsOnHelp")}
							</span>
						</span>
					</label>
					{number("revisionDays", "historySettings.revisionDays", "historySettings.revisionDaysHelp")}
					{number("revisionsKept", "historySettings.revisionsKept", "historySettings.revisionsKeptHelp")}
					{number("checkpointDays", "historySettings.checkpointDays", "historySettings.checkpointDaysHelp")}
					{error ? <FieldError>{t(error)}</FieldError> : null}
					<div>
						<Button type="submit" disabled={busy}>
							{t("historySettings.save")}
						</Button>
					</div>
				</FieldGroup>
			</form>
		</>
	);
}
