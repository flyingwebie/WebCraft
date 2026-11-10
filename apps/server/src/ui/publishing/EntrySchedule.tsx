import { useNavigate } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { CalendarClockIcon, CalendarOffIcon, CircleAlertIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import { CancelScheduleDialog, ScheduleDialog, ScheduledTime } from "./schedule.tsx";

type Entry = Awaited<ReturnType<ApiClient["entries"]["get"]>>["entry"];

/** Which dialog is open. */
type Open = "schedule" | "unpublish" | "changePublish" | "changeUnpublish" | "cancelPublish" | "cancelUnpublish" | null;

/**
 * The Entry editor's Scheduled publishes (GLOSSARY.md › Scheduled publish), in its Status card: when
 * its Draft will be published (the version it was scheduled with: later edits stay in the Draft and
 * show "Changed since scheduled") and when it will be unpublished, each changed or cancelled here; a
 * Publish all set it belongs to is changed in the Publish all panel. Whoever may publish the Entry
 * schedules it (Authors see the schedules, never the buttons).
 */
export function EntrySchedule({
	siteId,
	entry,
	isPage,
	canPublish,
	flush,
	onChanged,
}: {
	siteId: string;
	entry: Entry;
	isPage: boolean;
	canPublish: boolean;
	/** Saves what is waiting, so the Draft scheduled is the one on screen; false when it couldn't. */
	flush: () => Promise<boolean>;
	/** Reads the Entry again, with its schedules. */
	onChanged: () => Promise<void>;
}) {
	const t = useT();
	const id = useId();
	const navigate = useNavigate();
	const [open, setOpen] = useState<Open>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const scheduleButton = useRef<HTMLButtonElement>(null);
	const unpublishButton = useRef<HTMLButtonElement>(null);
	const publishActions = useRef<HTMLButtonElement>(null);
	const unpublishActions = useRef<HTMLButtonElement>(null);
	const afterRender = useAfterRender();
	const { publish, unpublish } = entry.scheduled;
	const close = () => setOpen(null);

	const done = async (message: string) => {
		close();
		toast.success(message);
		await onChanged();
		// A cancelled schedule's buttons are gone: focus goes to what is there now.
		afterRender(() => {
			if (!document.activeElement || document.activeElement === document.body) {
				(scheduleButton.current ?? unpublishButton.current ?? publishActions.current)?.focus();
			}
		});
	};
	const schedulePublish = async (at: Date) => {
		if (!(await flush())) throw { code: "CHANGED_MEANWHILE" };
		const api = await getApi();
		await api.publishing.schedule({ siteId, item: { kind: "entry", id: entry.id }, at });
		await done(t("schedule.scheduled", { time: formatUtc(at) }));
	};
	const scheduleUnpublish = async (at: Date) => {
		const api = await getApi();
		await api.publishing.scheduleUnpublish({ siteId, entryId: entry.id, at });
		await done(t("schedule.scheduled", { time: formatUtc(at) }));
	};
	const reschedule = (scheduleId: string) => async (at: Date) => {
		const api = await getApi();
		await api.publishing.reschedule({ siteId, scheduleId, at });
		await done(t("schedule.rescheduled", { time: formatUtc(at) }));
	};
	const cancel = (scheduleId: string) => async () => {
		const api = await getApi();
		await api.publishing.cancelScheduled({ siteId, scheduleId });
		await done(t("schedule.cancelled"));
	};
	const takeDraft = async (scheduleId: string) => {
		setProblem(null);
		try {
			if (!(await flush())) throw { code: "CHANGED_MEANWHILE" };
			const api = await getApi();
			await api.publishing.updateScheduled({ siteId, scheduleId });
			toast.success(t("schedule.updated"));
			await onChanged();
		} catch (failure) {
			setProblem(t(errorMessage(failure)));
		}
	};

	const unpublishedNote =
		entry.status === "draft" && entry.unpublishedAt ? (
			<p className="text-muted-foreground flex items-start gap-2 text-sm">
				<CalendarOffIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
				{t("schedule.unpublishedOn", { time: formatUtc(entry.unpublishedAt) })}
			</p>
		) : null;

	if (!publish && !unpublish && !canPublish) return unpublishedNote;

	return (
		<section aria-labelledby={`${id}-heading`} className="grid gap-3 border-t pt-4">
			<h3 id={`${id}-heading`} className="text-sm font-medium">
				{t("schedule.heading")}
			</h3>
			{unpublishedNote}
			{publish ? (
				<div className="grid gap-2 text-sm">
					<p className="flex flex-wrap items-center gap-2">
						<CalendarClockIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
						<span>
							{t("schedule.publishes")} <ScheduledTime value={publish.at} />
						</span>
					</p>
					{publish.changedSinceScheduled ? (
						<div className="grid gap-1">
							<Badge variant="outline" className="w-fit">
								<CircleAlertIcon aria-hidden="true" />
								{t("schedule.changedSince")}
							</Badge>
							<p className="text-muted-foreground text-xs">{t("schedule.changedSinceHelp")}</p>
						</div>
					) : null}
					{publish.kind === "set" ? (
						<div className="grid gap-1">
							<p className="text-muted-foreground">{t("schedule.inSet")}</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="w-fit"
								onClick={() =>
									void navigate({ to: ".", search: (previous: object) => ({ ...previous, publishAll: 1 }) } as never)
								}
							>
								{t("schedule.openPublishAll")}
							</Button>
						</div>
					) : canPublish ? (
						<div className="flex flex-wrap gap-2">
							<Button
								ref={publishActions}
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setOpen("changePublish")}
							>
								{t("schedule.changeTime")}
							</Button>
							{publish.changedSinceScheduled ? (
								<Button type="button" variant="outline" size="sm" onClick={() => void takeDraft(publish.id)}>
									{t("schedule.takeDraft")}
								</Button>
							) : null}
							<Button type="button" variant="ghost" size="sm" onClick={() => setOpen("cancelPublish")}>
								{t("schedule.cancelSchedule")}
							</Button>
						</div>
					) : null}
				</div>
			) : null}
			{unpublish ? (
				<div className="grid gap-2 text-sm">
					<p className="flex flex-wrap items-center gap-2">
						<CalendarOffIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
						<span>
							{t("schedule.unpublishes")} <ScheduledTime value={unpublish.at} />
						</span>
					</p>
					{canPublish ? (
						<div className="flex flex-wrap gap-2">
							<Button
								ref={unpublishActions}
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setOpen("changeUnpublish")}
							>
								{t("schedule.changeTime")}
							</Button>
							<Button type="button" variant="ghost" size="sm" onClick={() => setOpen("cancelUnpublish")}>
								{t("schedule.cancelSchedule")}
							</Button>
						</div>
					) : null}
				</div>
			) : null}
			{canPublish && (!publish || (!unpublish && entry.path)) ? (
				<div className="flex flex-wrap gap-2">
					{!publish ? (
						<Button ref={scheduleButton} type="button" variant="outline" size="sm" onClick={() => setOpen("schedule")}>
							<CalendarClockIcon aria-hidden="true" />
							{t("schedule.schedulePublish")}
						</Button>
					) : null}
					{!unpublish && entry.path ? (
						<Button
							ref={unpublishButton}
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setOpen("unpublish")}
						>
							<CalendarOffIcon aria-hidden="true" />
							{t("schedule.scheduleUnpublish")}
						</Button>
					) : null}
				</div>
			) : null}
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : null}

			{open === "schedule" ? (
				<ScheduleDialog
					title={t("schedule.publishTitle")}
					description={t("schedule.publishDescription")}
					submitLabel={t("schedule.publishSubmit")}
					onSubmit={schedulePublish}
					onClose={close}
					finalFocus={scheduleButton}
				/>
			) : null}
			{open === "unpublish" ? (
				<ScheduleDialog
					title={t("schedule.unpublishTitle")}
					description={t(isPage ? "schedule.unpublishPageDescription" : "schedule.unpublishDescription")}
					submitLabel={t("schedule.unpublishSubmit")}
					onSubmit={scheduleUnpublish}
					onClose={close}
					finalFocus={unpublishButton}
				/>
			) : null}
			{open === "changePublish" && publish ? (
				<ScheduleDialog
					title={t("schedule.changeTimeTitle")}
					description={t("schedule.changeTimeDescription")}
					submitLabel={t("schedule.changeTimeSubmit")}
					initial={publish.at}
					onSubmit={reschedule(publish.id)}
					onClose={close}
					finalFocus={publishActions}
				/>
			) : null}
			{open === "changeUnpublish" && unpublish ? (
				<ScheduleDialog
					title={t("schedule.changeTimeTitle")}
					description={t("schedule.changeUnpublishTimeDescription")}
					submitLabel={t("schedule.changeTimeSubmit")}
					initial={unpublish.at}
					onSubmit={reschedule(unpublish.id)}
					onClose={close}
					finalFocus={unpublishActions}
				/>
			) : null}
			{open === "cancelPublish" && publish ? (
				<CancelScheduleDialog onConfirm={cancel(publish.id)} onClose={close} finalFocus={publishActions} />
			) : null}
			{open === "cancelUnpublish" && unpublish ? (
				<CancelScheduleDialog onConfirm={cancel(unpublish.id)} onClose={close} finalFocus={unpublishActions} />
			) : null}
		</section>
	);
}
