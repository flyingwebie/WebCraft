import { Link, useRouteContext } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { ExternalLinkIcon, FilePlusIcon, SquarePenIcon, UploadIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { useAuditWords } from "../audit/AuditLog.tsx";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { type ReviewView, reviewItemLink, reviewItemName } from "../review/Review.tsx";
import { SettingsCard, StateBadge, type StateTone } from "../settings/layout.tsx";
import { initials } from "../shell/context.ts";
import { languageName } from "./DraftParts.tsx";
import { When } from "./When.tsx";

type AuditPage = Awaited<ReturnType<ApiClient["audit"]["list"]>>;
type DomainList = Awaited<ReturnType<ApiClient["domains"]["list"]>>;

/** What the Overview shows of the Site, besides what its `place` already holds. */
export type SiteOverviewData = {
	reviews: readonly ReviewView[];
	/** The Site's newest Audit log entries; null for people who may not read them. */
	activity: AuditPage | null;
	domains: DomainList;
};

/**
 * Site › Overview (frame 04): what waits for review, the Drafts waiting to be published with
 * Publish all, the Site's recent activity, quick actions, and the Site card (its domain and its
 * state, languages and Staging address).
 */
export function SiteOverview({
	siteId,
	data,
	languages,
	postTypes,
	permissions,
	drafts,
}: {
	siteId: string;
	data: SiteOverviewData;
	languages: { default: string; all: readonly string[] };
	postTypes: readonly { id: string; name: string; builtIn: "page" | null }[];
	permissions: readonly string[];
	/** How many Drafts the person may publish. */
	drafts: number;
}) {
	const t = useT();
	const mayPublish = permissions.includes("entry.publish") || permissions.includes("structure.edit");
	return (
		<div className="grid items-start gap-6 @4xl/page:grid-cols-[minmax(0,1fr)_22.5rem]">
			<div className="grid min-w-0 gap-6">
				<Reviews siteId={siteId} reviews={data.reviews} />
				{mayPublish ? (
					<SettingsCard
						title={t("site.overview.draftsHeading")}
						description={drafts > 0 ? t("site.overview.draftsReady", { count: drafts }) : t("site.overview.draftsNone")}
						action={
							drafts > 0 ? (
								// A link to the shell's Publish all, not a second button with the top bar's name.
								<Link to="." search={{ publishAll: "1" }} className={buttonVariants({ size: "sm" })}>
									<UploadIcon aria-hidden="true" />
									{t("publishAll.button")}
									<Badge variant="secondary" className="ms-1 tabular-nums">
										{drafts}
									</Badge>
									<span className="sr-only"> {t("publishAll.changesCounted", { count: drafts })}</span>
								</Link>
							) : null
						}
					/>
				) : null}
				{data.activity ? <ActivityCard activity={data.activity} /> : null}
			</div>
			<div className="grid min-w-0 gap-6">
				<QuickActions siteId={siteId} postTypes={postTypes} permissions={permissions} />
				<SiteCard languages={languages} domains={data.domains} />
			</div>
		</div>
	);
}

/** One line of a card's list: who (an avatar), what, and when. */
function Line({ who, children, at }: { who: string | null; children: ReactNode; at: Date | string }) {
	return (
		<li className="flex items-center gap-3 py-2.5 text-sm">
			<Avatar size="sm" className="size-6">
				<AvatarFallback aria-hidden="true" className="text-[10px] font-semibold">
					{who ? initials(who) : "·"}
				</AvatarFallback>
			</Avatar>
			<span className="min-w-0 flex-1">{children}</span>
			<span className="text-muted-foreground shrink-0 text-[13px]">
				<When value={at} />
			</span>
		</li>
	);
}

/** "Waiting for review": who asked for a review of what, longest waiting first, each item a link. */
function Reviews({ siteId, reviews }: { siteId: string; reviews: readonly ReviewView[] }) {
	const t = useT();
	const you = useRouteContext({ from: "__root__" }).shell.person?.id ?? null;
	return (
		<SettingsCard
			title={t("review.waitingHeading")}
			description={reviews.length === 0 ? t("review.waitingNone") : undefined}
		>
			{reviews.length > 0 ? (
				<ul className="-my-2.5 divide-y">
					{reviews.map((review) => {
						const name = !review.submittedBy
							? t("review.someone")
							: review.submittedBy.id === you
								? t("review.you")
								: review.submittedBy.name;
						return (
							<Line key={review.id} who={review.submittedBy?.name ?? null} at={review.submittedAt}>
								<Link
									{...reviewItemLink(siteId, review)}
									className="focus-visible:ring-ring/50 rounded-sm outline-none hover:underline focus-visible:ring-3"
								>
									{t("site.overview.requested", { name, title: reviewItemName(t, review) })}
								</Link>
								{review.changedSinceSubmitted ? (
									<span className="text-muted-foreground"> · {t("review.changedSince")}</span>
								) : null}
							</Line>
						);
					})}
				</ul>
			) : null}
		</SettingsCard>
	);
}

/**
 * "Recent activity": a Site's or a Workspace's newest Audit log entries, in words; on a Workspace
 * (`withSite`) each says which Site it happened on.
 */
export function ActivityCard({ activity, withSite = false }: { activity: AuditPage; withSite?: boolean }) {
	const t = useT();
	const words = useAuditWords();
	return (
		<SettingsCard
			title={t("site.overview.activityHeading")}
			description={activity.entries.length === 0 ? t("site.overview.activityNone") : undefined}
		>
			{activity.entries.length > 0 ? (
				<ul className="-my-2.5">
					{activity.entries.map((entry) => {
						const who = entry.personId ? (activity.people[entry.personId]?.name ?? null) : null;
						const values = { who: words.who(entry, activity), action: words.action(entry.action) };
						const subject = subjectOf(entry.details);
						const line = subject
							? t("site.overview.activitySubject", { ...values, subject })
							: t("site.overview.activityLine", values);
						const site = withSite && entry.siteId ? (activity.sites[entry.siteId] ?? null) : null;
						return (
							<Line key={entry.id} who={who} at={entry.at}>
								{site ? t("site.overview.activityOn", { line, site }) : line}
							</Line>
						);
					})}
				</ul>
			) : null}
		</SettingsCard>
	);
}

/** What an entry is about, in words its details carry: an Entry's title, a file's or a thing's name. */
function subjectOf(details: Record<string, unknown>): string | null {
	for (const key of ["title", "fileName", "name"]) {
		const value = details[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
}

/** "Quick actions": a new Page or Entry, uploading Media, Edit mode on the home page. */
function QuickActions({
	siteId,
	postTypes,
	permissions,
}: {
	siteId: string;
	postTypes: readonly { id: string; name: string; builtIn: "page" | null }[];
	permissions: readonly string[];
}) {
	const t = useT();
	const impersonating = Boolean(useRouteContext({ from: "__root__" }).shell.impersonation);
	const [opening, setOpening] = useState(false);
	const canEdit = permissions.includes("entry.edit");
	const pages = postTypes.find((postType) => postType.builtIn === "page");
	const others = postTypes.filter((postType) => postType.builtIn !== "page").slice(0, 2);
	const actionClass = "w-full justify-start";

	const editOnSite = async () => {
		setOpening(true);
		try {
			const { url } = await (await getApi()).editMode.open({ siteId, path: "/", safeMode: false });
			window.location.assign(url);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setOpening(false);
		}
	};

	const actions: ReactNode[] = [];
	if (canEdit && pages) {
		actions.push(
			<Button
				key="page"
				variant="outline"
				className={actionClass}
				nativeButton={false}
				render={
					<Link
						to="/sites/$siteId/entries/$postTypeId"
						params={{ siteId, postTypeId: pages.id }}
						search={{ create: true }}
					/>
				}
			>
				<FilePlusIcon aria-hidden="true" />
				{t("entries.create.newPage")}
			</Button>,
		);
	}
	if (canEdit) {
		for (const postType of others) {
			actions.push(
				<Button
					key={postType.id}
					variant="outline"
					className={actionClass}
					nativeButton={false}
					render={
						<Link
							to="/sites/$siteId/entries/$postTypeId"
							params={{ siteId, postTypeId: postType.id }}
							search={{ create: true }}
						/>
					}
				>
					<SquarePenIcon aria-hidden="true" />
					<span className="truncate">{t("site.overview.newIn", { name: postType.name })}</span>
				</Button>,
			);
		}
	}
	if (permissions.includes("media.upload")) {
		actions.push(
			<Button
				key="media"
				variant="outline"
				className={actionClass}
				nativeButton={false}
				render={<Link to="/sites/$siteId/media" params={{ siteId }} />}
			>
				<UploadIcon aria-hidden="true" />
				{t("site.overview.uploadMedia")}
			</Button>,
		);
	}
	if (canEdit && !impersonating) {
		actions.push(
			<Button key="edit" variant="outline" className={actionClass} onClick={editOnSite} disabled={opening}>
				<ExternalLinkIcon aria-hidden="true" />
				{t("site.overview.editHome")}
			</Button>,
		);
	}
	if (actions.length === 0) return null;
	return (
		<SettingsCard title={t("site.overview.quickHeading")}>
			<div className="grid gap-2">{actions}</div>
		</SettingsCard>
	);
}

const DOMAIN_TONES: Record<"active" | "waiting" | "unreachable", StateTone> = {
	active: "success",
	waiting: "warning",
	unreachable: "danger",
};

/** Whether a Site's domain is live ("Live", "Waiting for DNS", "Unreachable"), as a badge in words. */
export function DomainState({ status }: { status: "active" | "waiting" | "unreachable" }) {
	const t = useT();
	return (
		<StateBadge tone={DOMAIN_TONES[status]}>
			{status === "active" ? t("site.overview.live") : t(`domains.status.${status}`)}
		</StateBadge>
	);
}

/** "Site": its Primary domain and whether it is live, its languages and its Staging address. */
function SiteCard({
	languages,
	domains,
}: {
	languages: { default: string; all: readonly string[] };
	domains: DomainList;
}) {
	const t = useT();
	const primary = domains.domains.find((domain) => domain.role === "primary") ?? null;
	const staging = domains.stagingUrl ? new URL(domains.stagingUrl).host : null;
	return (
		<SettingsCard title={t("site.overview.siteHeading")}>
			<dl className="grid grid-cols-[6.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
				<dt className="text-muted-foreground">{t("site.overview.domain")}</dt>
				<dd className="flex min-w-0 items-center gap-2">
					{primary ? (
						<>
							<span className="truncate font-mono font-medium">{primary.displayName}</span>
							<DomainState status={primary.status} />
						</>
					) : (
						<span className="text-muted-foreground">{t("site.overview.noDomain")}</span>
					)}
				</dd>
				<dt className="text-muted-foreground">{t("site.overview.languages")}</dt>
				<dd className="font-medium">{languages.all.map(languageName).join(", ")}</dd>
				<dt className="text-muted-foreground">{t("site.overview.staging")}</dt>
				<dd className="min-w-0 truncate font-mono font-medium" title={staging ?? undefined}>
					{staging ?? (
						<span className="text-muted-foreground font-sans font-normal">{t("site.overview.noStaging")}</span>
					)}
				</dd>
			</dl>
		</SettingsCard>
	);
}
