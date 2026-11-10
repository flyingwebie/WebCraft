import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { CalendarClockIcon, CalendarOffIcon, CircleAlertIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useState } from "react";
import { useLocale } from "use-intl";

import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";

/**
 * Scheduled publishes in the admin (GLOSSARY.md › Scheduled publish): the dialog that chooses a time,
 * and times shown as the admin shows them (UTC), with the person's own local time beside them once the
 * page runs in their browser.
 */

/** The browser's time zone (`Europe/Dublin`); null while the page is rendered on the server. */
function useTimeZone(): string | null {
	const [zone, setZone] = useState<string | null>(null);
	useEffect(() => {
		setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
	}, []);
	return zone;
}

/**
 * A time as people read it in their own time zone (`2 Mar 2026, 10:00`), in their Admin language;
 * nothing while the page is rendered on the server, so the server's HTML and the browser's agree.
 */
export function LocalTime({ value }: { value: Date | string }) {
	const t = useT();
	const language = useLocale();
	const zone = useTimeZone();
	if (!zone) return null;
	const local = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
	return <span className="text-muted-foreground"> {t("schedule.localTime", { time: local })}</span>;
}

/** A Scheduled publish's time: in UTC, as the admin shows times, and the person's local time beside it. */
export function ScheduledTime({ value }: { value: Date | string }) {
	return (
		<span>
			<time dateTime={new Date(value).toISOString()}>{formatUtc(value)}</time>
			<LocalTime value={value} />
		</span>
	);
}

/** Two digits. */
const pad = (part: number) => String(part).padStart(2, "0");

/** A date and time as the date and time boxes hold them, in the browser's time zone. */
function boxesOf(value: Date): { date: string; time: string } {
	return {
		date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
		time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
	};
}

/** The time the boxes name, in the browser's time zone; null while either is empty or unreadable. */
function timeOf(date: string, time: string): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
	// A date and time without an offset is read in the browser's own time zone.
	const value = new Date(`${date}T${time}:00`);
	return Number.isNaN(value.getTime()) ? null : value;
}

/** The next quarter of an hour at least an hour away: what a new schedule offers first. */
function suggestedTime(): Date {
	const value = new Date(Date.now() + 60 * 60_000);
	value.setSeconds(0, 0);
	value.setMinutes(Math.ceil(value.getMinutes() / 15) * 15);
	return value;
}

/**
 * Chooses a time for a Scheduled publish: a date box and a time box in the person's own time zone
 * (named under them), what that is in UTC as the admin shows times, said again as it changes, and
 * `submit` with the time chosen. A time in the past is refused before anything is sent; the server's
 * refusals show in the dialog.
 */
export function ScheduleDialog({
	title,
	description,
	submitLabel,
	initial,
	onSubmit,
	onClose,
	finalFocus,
	children,
}: {
	title: string;
	description: string;
	submitLabel: string;
	/** The time it starts at (changing a Scheduled publish's time); the next quarter hour an hour away unless given. */
	initial?: Date | string;
	/** Schedules at the time chosen; a refusal it throws is shown in the dialog. */
	onSubmit: (at: Date) => Promise<void>;
	onClose: () => void;
	finalFocus?: RefObject<HTMLElement | null>;
	/** More to show above the boxes, such as what will be published. */
	children?: ReactNode;
}) {
	const t = useT();
	const id = useId();
	const zone = useTimeZone();
	const [boxes, setBoxes] = useState(() => boxesOf(initial ? new Date(initial) : suggestedTime()));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const chosen = timeOf(boxes.date, boxes.time);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setProblem(null);
		if (!chosen) {
			setProblem(t("schedule.chooseTime"));
			return;
		}
		if (chosen.getTime() <= Date.now()) {
			setProblem(t("schedule.inPast"));
			return;
		}
		setBusy(true);
		try {
			await onSubmit(chosen);
		} catch (failure) {
			setProblem(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("schedule.close")} finalFocus={finalFocus}>
				<form onSubmit={submit} className="grid gap-4" noValidate>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{children}
					<FieldGroup className="grid gap-4 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor={`${id}-date`}>{t("schedule.date")}</FieldLabel>
							<Input
								id={`${id}-date`}
								type="date"
								required
								value={boxes.date}
								onChange={(event) => setBoxes({ ...boxes, date: event.target.value })}
								aria-describedby={`${id}-zone`}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-time`}>{t("schedule.time")}</FieldLabel>
							<Input
								id={`${id}-time`}
								type="time"
								step={60}
								required
								value={boxes.time}
								onChange={(event) => setBoxes({ ...boxes, time: event.target.value })}
								aria-describedby={`${id}-zone`}
							/>
						</Field>
					</FieldGroup>
					<FieldDescription id={`${id}-zone`}>
						{zone ? t("schedule.zone", { zone }) : t("schedule.zoneUnknown")}
					</FieldDescription>
					<p className="flex items-center gap-2 text-sm" aria-live="polite">
						<CalendarClockIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
						{chosen ? t("schedule.runsAt", { time: formatUtc(chosen) }) : t("schedule.chooseTime")}
					</p>
					{problem ? (
						<p role="alert" className="text-destructive text-sm">
							{problem}
						</p>
					) : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("schedule.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							<CalendarClockIcon aria-hidden="true" />
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Asks before cancelling a Scheduled publish: nothing of it will be published, and the version it
 * holds is let go (the Drafts stay as they are).
 */
export function CancelScheduleDialog({
	onConfirm,
	onClose,
	finalFocus,
}: {
	onConfirm: () => Promise<void>;
	onClose: () => void;
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const confirm = async () => {
		setBusy(true);
		setProblem(null);
		try {
			await onConfirm();
		} catch (failure) {
			setProblem(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("schedule.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("schedule.cancelTitle")}</DialogTitle>
					<DialogDescription>{t("schedule.cancelBody")}</DialogDescription>
				</DialogHeader>
				{problem ? (
					<p role="alert" className="text-destructive text-sm">
						{problem}
					</p>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("schedule.keep")}</DialogClose>
					<Button type="button" variant="destructive" disabled={busy} onClick={confirm}>
						{t("schedule.cancelConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** An Entry's Scheduled publishes, as its answer carries them. */
type EntryScheduled = {
	publish: { at: Date | string; changedSinceScheduled: boolean } | null;
	unpublish: { at: Date | string } | null;
};

/**
 * Lists' chips for an Entry's Scheduled publishes: "Scheduled" with its time (UTC), "Changed since
 * scheduled" when its Draft changed after, and "Unpublish scheduled". Words and icons, never colour alone.
 */
export function ScheduleBadges({ scheduled }: { scheduled: EntryScheduled }) {
	const t = useT();
	return (
		<>
			{scheduled.publish ? (
				<Badge variant="outline" title={formatUtc(scheduled.publish.at)}>
					<CalendarClockIcon aria-hidden="true" />
					{t("schedule.badge")}
					<span className="sr-only"> {formatUtc(scheduled.publish.at)}</span>
				</Badge>
			) : null}
			{scheduled.publish?.changedSinceScheduled ? (
				<Badge variant="outline">
					<CircleAlertIcon aria-hidden="true" />
					{t("schedule.changedSince")}
				</Badge>
			) : null}
			{scheduled.unpublish ? (
				<Badge variant="outline" title={formatUtc(scheduled.unpublish.at)}>
					<CalendarOffIcon aria-hidden="true" />
					{t("schedule.unpublishBadge")}
					<span className="sr-only"> {formatUtc(scheduled.unpublish.at)}</span>
				</Badge>
			) : null}
		</>
	);
}
