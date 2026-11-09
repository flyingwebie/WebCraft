import { createFileRoute, Link } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@webcraft/ui/components/empty.tsx";
import { CircleAlertIcon, MailIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/email-log")({
	staticData: { crumb: "emailLog.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return null;
		const api = await getApi();
		return { page: await api.install.emailLog.list({}) };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "emailLog.pageTitle") }] }),
	component: EmailLogPage,
});

type Page = Awaited<ReturnType<ApiClient["install"]["emailLog"]["list"]>>;
type Line = Page["lines"][number];

/** The Email log: every email the Install sent in the last 90 days, never its body. */
function EmailLogPage() {
	const t = useT();
	const data = Route.useLoaderData();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("emailLog.heading")}>{t("emailLog.intro")}</PageHeader>
			<EmailLogTable first={data.page} />
		</>
	);
}

const COLUMNS: MessageKey[] = [
	"emailLog.columns.time",
	"emailLog.columns.type",
	"emailLog.columns.recipient",
	"emailLog.columns.subject",
	"emailLog.columns.smtp",
	"emailLog.columns.status",
	"emailLog.columns.attempts",
	"emailLog.columns.lastResponse",
	"emailLog.columns.related",
];

function EmailLogTable({ first }: { first: Page }) {
	const t = useT();
	const [lines, setLines] = useState(first.lines);
	const [next, setNext] = useState(first.next);
	const [busy, setBusy] = useState(false);

	if (lines.length === 0) {
		return (
			<Empty className="border">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<MailIcon aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>
						<h2>{t("emailLog.emptyTitle")}</h2>
					</EmptyTitle>
					<EmptyDescription>{t("emailLog.emptyBody")}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const showOlder = async () => {
		if (!next) return;
		setBusy(true);
		try {
			const api = await getApi();
			const page = await api.install.emailLog.list({ after: next });
			setLines((current) => [...current, ...page.lines]);
			setNext(page.next);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			{/* Scrolls sideways on narrow screens: focusable, so keyboards can scroll it too. */}
			<section
				aria-labelledby="email-log-caption"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
				tabIndex={0}
				className="focus-visible:ring-ring/50 overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px]"
			>
				<table className="w-full text-start text-sm">
					<caption id="email-log-caption" className="sr-only">
						{t("emailLog.tableLabel")}
					</caption>
					<thead className="bg-muted/50">
						<tr>
							{COLUMNS.map((column) => (
								<th key={column} scope="col" className="px-3 py-2 text-start font-medium whitespace-nowrap">
									{t(column)}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y">
						{lines.map((line) => (
							<EmailLogRow key={line.id} line={line} />
						))}
					</tbody>
				</table>
			</section>
			{next ? (
				<div>
					<Button type="button" variant="outline" onClick={showOlder} disabled={busy}>
						{t("emailLog.older")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function EmailLogRow({ line }: { line: Line }) {
	const t = useT();
	const typeKey = `emailTypes.${line.type}.name` as MessageKey;
	return (
		<tr className="align-top">
			<td className="px-3 py-2 whitespace-nowrap">{formatUtc(line.time)}</td>
			<td className="min-w-36 px-3 py-2">{t.has(typeKey) ? t(typeKey) : line.type}</td>
			<td className="px-3 py-2 whitespace-nowrap">{line.recipient}</td>
			<td className="min-w-56 px-3 py-2">{line.subject}</td>
			<td className="px-3 py-2 whitespace-nowrap">
				{line.smtp === "install"
					? t("emailLog.smtp.install")
					: line.smtp === "site"
						? t("emailLog.smtp.site")
						: t("emailLog.smtp.none")}
			</td>
			<td className="px-3 py-2">
				<StatusBadge status={line.status} />
				{line.nextAttemptAt && line.status === "retrying" ? (
					<p className="text-muted-foreground mt-1 text-xs whitespace-nowrap">
						{t("emailLog.nextAttempt", { time: formatUtc(line.nextAttemptAt) })}
					</p>
				) : null}
			</td>
			<td className="px-3 py-2 text-end tabular-nums">{line.attempts}</td>
			<td className="text-muted-foreground min-w-56 px-3 py-2 break-words">{line.lastResponse}</td>
			<td className="px-3 py-2 whitespace-nowrap">
				<RelatedLink related={line.related} />
			</td>
		</tr>
	);
}

const STATUS_LABELS: Record<Line["status"], MessageKey> = {
	queued: "emailLog.status.queued",
	retrying: "emailLog.status.retrying",
	sent: "emailLog.status.sent",
	failed: "emailLog.status.failed",
	logged: "emailLog.status.logged",
};

function StatusBadge({ status }: { status: Line["status"] }) {
	const t = useT();
	if (status === "failed") {
		return (
			<Badge variant="outline" className="border-destructive/60">
				<CircleAlertIcon className="text-destructive" aria-hidden="true" data-icon="inline-start" />
				{t(STATUS_LABELS[status])}
			</Badge>
		);
	}
	return <Badge variant={status === "sent" ? "secondary" : "outline"}>{t(STATUS_LABELS[status])}</Badge>;
}

/** What the email is about, linked where the admin has a page for it. */
function RelatedLink({ related }: { related: Line["related"] }) {
	const t = useT();
	if (related?.kind === "install-smtp") {
		return (
			<Link to="/settings/email" className="underline-offset-4 hover:underline">
				{t("emailLog.related.installSmtp")}
			</Link>
		);
	}
	if (related?.kind === "site-smtp") {
		return (
			<Link to="/sites/$siteId/email" params={{ siteId: related.id }} className="underline-offset-4 hover:underline">
				{t("emailLog.related.siteSmtp")}
			</Link>
		);
	}
	if (related?.kind === "submission") return <span>{t("emailLog.related.submission")}</span>;
	return null;
}
