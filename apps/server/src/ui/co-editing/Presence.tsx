import type { DraftStatus, Participant } from "@webcraft/core/draft-document";
import { CircleAlertIcon, CircleCheckIcon, CloudOffIcon, LoaderIcon, LockIcon } from "lucide-react";
import { type FocusEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { useT } from "../i18n.tsx";
import type { PublishedBy } from "./shared-draft.ts";

/**
 * Who else is editing a Draft, and where (Co-editing, ADR 0025). Everyone shows by name, with initials
 * in their colour; the colour is never the only way to tell people apart. A Field someone is in has
 * an outline in their colour and their name above it. API clients, AI clients and AI translation show
 * as "<person> via <client>" for a moment after they change the Draft.
 */

/** The 8 colours people get, each with text that reads on it in light and dark. */
const COLOURS = [
	{ outline: "outline-sky-700 dark:outline-sky-300", fill: "bg-sky-700 text-white dark:bg-sky-300 dark:text-sky-950" },
	{
		outline: "outline-violet-700 dark:outline-violet-300",
		fill: "bg-violet-700 text-white dark:bg-violet-300 dark:text-violet-950",
	},
	{
		outline: "outline-emerald-700 dark:outline-emerald-300",
		fill: "bg-emerald-700 text-white dark:bg-emerald-300 dark:text-emerald-950",
	},
	{
		outline: "outline-amber-700 dark:outline-amber-300",
		fill: "bg-amber-700 text-white dark:bg-amber-300 dark:text-amber-950",
	},
	{
		outline: "outline-rose-700 dark:outline-rose-300",
		fill: "bg-rose-700 text-white dark:bg-rose-300 dark:text-rose-950",
	},
	{
		outline: "outline-cyan-700 dark:outline-cyan-300",
		fill: "bg-cyan-700 text-white dark:bg-cyan-300 dark:text-cyan-950",
	},
	{
		outline: "outline-fuchsia-700 dark:outline-fuchsia-300",
		fill: "bg-fuchsia-700 text-white dark:bg-fuchsia-300 dark:text-fuchsia-950",
	},
	{
		outline: "outline-lime-700 dark:outline-lime-300",
		fill: "bg-lime-700 text-white dark:bg-lime-300 dark:text-lime-950",
	},
] as const;

function colourOf(participant: Participant) {
	return COLOURS[participant.colour % COLOURS.length] ?? COLOURS[0];
}

function initialsOf(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters = words.length > 1 ? [words[0], words.at(-1)] : [words[0]];
	return letters.map((word) => (word ? Array.from(word)[0]?.toLocaleUpperCase() : "")).join("") || "?";
}

/**
 * A participant's name as people read it: the person, and the client they came through, or who is
 * impersonating them ("<Staff> as <Member>").
 */
function useDisplayName() {
	const t = useT();
	return (participant: Participant) => {
		const name = participant.name || t("coEditing.someone");
		if (participant.translation) return t("coEditing.viaTranslation", { name });
		if (participant.impersonator) return t("coEditing.as", { impersonator: participant.impersonator, name });
		return participant.via ? t("coEditing.via", { name, client: participant.via }) : name;
	};
}

/** The people editing a Draft besides this editor, as avatars with their names. */
export function PresenceList({ participants }: { participants: readonly Participant[] }) {
	const t = useT();
	const displayName = useDisplayName();
	const others = participants.filter((participant) => !participant.self);
	if (others.length === 0) return null;
	return (
		<section aria-label={t("coEditing.alsoHere")} className="flex flex-wrap items-center gap-2 text-sm">
			<span className="text-muted-foreground">{t("coEditing.alsoHere")}</span>
			<ul className="flex flex-wrap items-center gap-2">
				{others.map((participant) => (
					<li key={participant.id} className="bg-muted flex items-center gap-1.5 rounded-full py-0.5 ps-0.5 pe-2.5">
						<span
							aria-hidden="true"
							className={`${colourOf(participant).fill} grid size-6 place-items-center rounded-full text-xs font-semibold`}
						>
							{initialsOf(participant.name)}
						</span>
						<span>{displayName(participant)}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * Wraps one value's control: it says where the person is when focus enters it (`place`), and shows who
 * else is there, with an outline in their colour and their name.
 */
export function PresenceOutline({
	place,
	participants,
	children,
}: {
	place: string;
	participants: readonly Participant[];
	children: ReactNode;
}) {
	const t = useT();
	const displayName = useDisplayName();
	const here = participants.filter((participant) => !participant.self && participant.at === place);
	const first = here[0];
	return (
		<div
			data-draft-place={place}
			className={
				first ? `${colourOf(first).outline} relative rounded-md outline-2 outline-offset-4 outline-solid` : "relative"
			}
		>
			{first ? (
				<p className="mb-1 flex flex-wrap gap-1 text-xs">
					{here.map((participant) => (
						<span key={participant.id} className={`${colourOf(participant).fill} rounded px-1.5 py-0.5 font-medium`}>
							{t("coEditing.isHere", { name: displayName(participant) })}
						</span>
					))}
				</p>
			) : null}
			{children}
		</div>
	);
}

/** Says where focus is to the shared Draft: the value whose `PresenceOutline` holds it, or nowhere. */
export function usePlaceTracking(place: (at: string | null) => void) {
	return {
		onFocus: (event: FocusEvent<HTMLElement>) => {
			const holder = (event.target as HTMLElement).closest<HTMLElement>("[data-draft-place]");
			place(holder?.dataset.draftPlace ?? null);
		},
		onBlur: (event: FocusEvent<HTMLElement>) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) place(null);
		},
	};
}

/**
 * Where the Draft's saving stands, in words: saving, saved, connecting, offline (changes kept), read-only
 * (no connection for 5 minutes), ended. A live region, so screen readers hear each change of state, and
 * who published the Draft when someone does.
 */
export function SharedDraftStatus({
	status,
	editable,
	publishedBy,
}: {
	status: DraftStatus;
	editable: boolean;
	publishedBy: PublishedBy | undefined;
}) {
	const t = useT();
	const displayName = useDisplayName();
	const icon =
		status === "saving" || status === "connecting" ? (
			<LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
		) : status === "saved" ? (
			<CircleCheckIcon className="size-3.5" aria-hidden="true" />
		) : status === "offline" ? (
			<CloudOffIcon className="size-3.5" aria-hidden="true" />
		) : status === "readOnly" ? (
			<LockIcon className="size-3.5" aria-hidden="true" />
		) : (
			<CircleAlertIcon className="size-3.5" aria-hidden="true" />
		);
	const words =
		status === "readOnly" && !editable && publishedBy === undefined
			? t("coEditing.status.viewOnly")
			: t(`coEditing.status.${status}`);
	return (
		<span role="status" className="inline-flex flex-wrap items-center gap-1.5">
			{icon}
			<span>{words}</span>
			{publishedBy !== undefined ? (
				<span>
					{publishedBy
						? t("coEditing.publishedBy", {
								name: displayName({
									id: "",
									personId: null,
									name: publishedBy.name,
									via: publishedBy.via,
									...(publishedBy.impersonator ? { impersonator: publishedBy.impersonator } : {}),
									colour: 0,
									at: null,
								}),
							})
						: t("coEditing.published")}
				</span>
			) : null}
		</span>
	);
}

/**
 * A banner while the Draft can't be changed here: offline for too long (read-only until the connection
 * is back) or the session ended. Its words are said when it appears.
 */
export function SharedDraftBanner({ status, editable }: { status: DraftStatus; editable: boolean }) {
	const t = useT();
	const shown = status === "readOnly" || status === "ended" || status === "offline";
	// The banner is said when it appears after the page loaded, not when the page loads with it.
	const seen = useRef<DraftStatus | null>(null);
	const [announced, setAnnounced] = useState(false);
	useEffect(() => {
		if (seen.current !== null && seen.current !== status) setAnnounced(true);
		seen.current = status;
	});
	if (!shown) return null;
	const key =
		status === "ended"
			? "coEditing.banner.ended"
			: status === "offline"
				? "coEditing.banner.offline"
				: editable
					? "coEditing.banner.readOnly"
					: "coEditing.banner.viewOnly";
	return (
		<div
			role={announced ? "alert" : undefined}
			className="border-border bg-muted/50 flex items-start gap-3 rounded-lg border p-3 text-sm"
		>
			{status === "offline" ? (
				<CloudOffIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			) : (
				<LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			)}
			<p>{t(key)}</p>
		</div>
	);
}
