import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@webcraft/ui/components/empty.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { BugOffIcon } from "lucide-react";
import { Fragment, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";

export type ErrorLogPage = Awaited<ReturnType<ApiClient["errorLog"]["list"]>>;
type Group = ErrorLogPage["groups"][number];
type Detail = Awaited<ReturnType<ApiClient["errorLog"]["get"]>>["group"];
type State = "open" | "resolved" | "all";

/** The Error log: causes of unexpected failures, the most recently seen first. */
export function ErrorLogScreen({ first }: { first: ErrorLogPage }) {
	const t = useT();
	const filterId = useId();
	const [state, setState] = useState<State>("open");
	const [groups, setGroups] = useState(first.groups);
	const [next, setNext] = useState(first.next);
	const [busy, setBusy] = useState(false);

	const load = async (show: State, after?: string) => {
		setBusy(true);
		try {
			const api = await getApi();
			const page = await api.errorLog.list({ state: show, ...(after ? { after } : {}) });
			setGroups((current) => (after ? [...current, ...page.groups] : page.groups));
			setNext(page.next);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const resolved = (group: Group) => {
		setGroups((current) =>
			state === "open"
				? current.filter((one) => one.id !== group.id)
				: current.map((one) => (one.id === group.id ? group : one)),
		);
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2 sm:w-60">
				<Label htmlFor={filterId}>{t("errorLog.filter")}</Label>
				<NativeSelect
					id={filterId}
					value={state}
					onChange={(event) => {
						const show = event.target.value as State;
						setState(show);
						void load(show);
					}}
					className="w-full"
				>
					<NativeSelectOption value="open">{t("errorLog.states.open")}</NativeSelectOption>
					<NativeSelectOption value="resolved">{t("errorLog.states.resolved")}</NativeSelectOption>
					<NativeSelectOption value="all">{t("errorLog.states.all")}</NativeSelectOption>
				</NativeSelect>
			</div>
			{groups.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<BugOffIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>
							<h2>{t("errorLog.emptyTitle")}</h2>
						</EmptyTitle>
						<EmptyDescription>{t("errorLog.emptyBody")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<section
					aria-labelledby="error-log-caption"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					tabIndex={0}
					className="focus-visible:ring-ring/50 overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px]"
				>
					<table className="w-full text-start text-sm">
						<caption id="error-log-caption" className="sr-only">
							{t("errorLog.tableLabel")}
						</caption>
						<thead className="bg-muted/50">
							<tr>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("errorLog.columns.cause")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("errorLog.columns.where")}
								</th>
								<th scope="col" className="px-3 py-2 text-end font-medium">
									{t("errorLog.columns.count")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium whitespace-nowrap">
									{t("errorLog.columns.firstSeen")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium whitespace-nowrap">
									{t("errorLog.columns.lastSeen")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("errorLog.columns.places")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("errorLog.columns.actions")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y">
							{groups.map((group) => (
								<GroupRows key={group.id} group={group} onResolved={resolved} />
							))}
						</tbody>
					</table>
				</section>
			)}
			{next ? (
				<div>
					<Button type="button" variant="outline" onClick={() => load(state, next)} disabled={busy}>
						{t("errorLog.older")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function GroupRows({ group, onResolved }: { group: Group; onResolved: (group: Group) => void }) {
	const t = useT();
	const detailsId = useId();
	const [detail, setDetail] = useState<Detail | null>(null);
	const [open, setOpen] = useState(false);
	const toggle = async () => {
		if (open) {
			setOpen(false);
			return;
		}
		try {
			if (!detail) {
				const api = await getApi();
				setDetail((await api.errorLog.get({ groupId: group.id })).group);
			}
			setOpen(true);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const resolve = async () => {
		try {
			const api = await getApi();
			const { group: done } = await api.errorLog.resolve({ groupId: group.id });
			toast.success(t("errorLog.resolved"));
			onResolved(done);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const source =
		group.source.kind === "job"
			? t("errorLog.source.job", { name: group.source.name ?? "" })
			: group.source.kind === "request"
				? group.source.name
					? t("errorLog.source.request", { name: group.source.name })
					: t("errorLog.source.requestUnnamed")
				: t("errorLog.source.process");
	const [firstPlace, secondPlace, ...morePlaces] = group.places;
	return (
		<Fragment>
			<tr className="align-top">
				<td className="min-w-72 px-3 py-2">
					<p className="font-medium">{group.name}</p>
					<p className="text-muted-foreground break-words">{group.message}</p>
					{group.resolvedAt ? (
						<Badge variant="secondary" className="mt-1">
							{t("errorLog.resolvedBy", {
								name: group.resolvedBy?.name ?? "WebCraft",
								time: formatUtc(group.resolvedAt),
							})}
						</Badge>
					) : group.reopenedAt ? (
						<Badge variant="outline" className="mt-1">
							{t("errorLog.reopened", { time: formatUtc(group.reopenedAt) })}
						</Badge>
					) : null}
				</td>
				<td className="min-w-40 px-3 py-2 break-words">{source}</td>
				<td className="px-3 py-2 text-end tabular-nums">{group.count}</td>
				<td className="px-3 py-2 whitespace-nowrap">{formatUtc(group.firstSeenAt)}</td>
				<td className="px-3 py-2 whitespace-nowrap">{formatUtc(group.lastSeenAt)}</td>
				<td className="min-w-48 px-3 py-2">
					{firstPlace ? (
						<ul className="space-y-1">
							{[firstPlace, secondPlace]
								.filter((place) => place !== undefined)
								.map((place) => (
									<li key={`${place.workspace.id}/${place.site?.id ?? ""}`}>{placeName(place)}</li>
								))}
							{morePlaces.length > 0 ? (
								<li className="text-muted-foreground">{t("errorLog.morePlaces", { count: morePlaces.length })}</li>
							) : null}
						</ul>
					) : (
						<span className="text-muted-foreground">{t("errorLog.noPlace")}</span>
					)}
				</td>
				<td className="px-3 py-2">
					<div className="flex gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							aria-expanded={open}
							aria-controls={detailsId}
							onClick={toggle}
						>
							{open ? t("errorLog.hideDetails") : t("errorLog.details")}
							<span className="sr-only">{t("errorLog.ofCause", { name: group.name })}</span>
						</Button>
						{group.resolvedAt ? null : (
							<Button type="button" variant="outline" size="sm" onClick={resolve}>
								{t("errorLog.markResolved")}
								<span className="sr-only">{t("errorLog.ofCause", { name: group.name })}</span>
							</Button>
						)}
					</div>
				</td>
			</tr>
			<tr id={detailsId} hidden={!open}>
				<td colSpan={7} className="bg-muted/30 px-3 py-3">
					{detail ? <GroupDetail detail={detail} /> : null}
				</td>
			</tr>
		</Fragment>
	);
}

function placeName(place: Group["places"][number]): string {
	return place.site
		? `${place.workspace.name} › ${place.site.name} (${place.count})`
		: `${place.workspace.name} (${place.count})`;
}

function GroupDetail({ detail }: { detail: Detail }) {
	const t = useT();
	const stackId = useId();
	return (
		<div className="flex flex-col gap-3">
			{detail.requestId ? <p className="text-sm">{t("errorLog.requestId", { id: detail.requestId })}</p> : null}
			<div className="flex flex-col gap-1">
				<p id={stackId} className="text-sm font-medium">
					{t("errorLog.stack")}
				</p>
				{detail.stack ? (
					<section
						aria-labelledby={stackId}
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
						tabIndex={0}
						className="bg-background focus-visible:ring-ring/50 max-h-72 overflow-auto rounded-md border outline-none focus-visible:ring-[3px]"
					>
						<pre className="p-3 font-mono text-xs whitespace-pre">{detail.stack}</pre>
					</section>
				) : (
					<p className="text-muted-foreground text-sm">{t("errorLog.noStack")}</p>
				)}
			</div>
			{detail.places.length > 2 ? (
				<ul className="space-y-1 text-sm">
					{detail.places.map((place) => (
						<li key={`${place.workspace.id}/${place.site?.id ?? ""}`}>{placeName(place)}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
