import { Link } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { HistoryIcon } from "lucide-react";

import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import { attributionText, copyKind, copyParam, type HistoryItem, type HistoryPage, itemSearch } from "./model.ts";

/** How many of the newest copies the card lists. */
export const HISTORY_CARD_COPIES = 5;

/**
 * The History card beside an editor: the item's newest Revisions and Checkpoints, each opening the
 * History screen to compare it with the Draft (and restore it), and a link to the whole history. Says
 * when publishing saves no Revisions, and what happens to those saved before.
 */
export function HistoryCard({ siteId, item, history }: { siteId: string; item: HistoryItem; history: HistoryPage }) {
	const t = useT();
	const copies = history.copies.slice(0, HISTORY_CARD_COPIES);
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("history.card.heading")}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-4 text-sm">
				{history.revisions.on ? null : <RevisionsOff off={history.revisions.off} retention={history.retention} />}
				{copies.length === 0 ? (
					<p className="text-muted-foreground">{t("history.card.empty")}</p>
				) : (
					<ul className="grid gap-3">
						{copies.map((copy) => (
							<li key={copy.id} className="grid gap-0.5">
								<Link
									to="/sites/$siteId/history"
									params={{ siteId }}
									search={{ ...itemSearch(item), copy: copyParam(copy) }}
									className="focus-visible:ring-ring/50 rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-3"
								>
									{copyKind(t, copy)} · {formatUtc(copy.at)}
								</Link>
								<span className="text-muted-foreground">{attributionText(t, copy.by)}</span>
							</li>
						))}
					</ul>
				)}
				<div>
					<Button
						variant="outline"
						render={<Link to="/sites/$siteId/history" params={{ siteId }} search={itemSearch(item)} />}
					>
						<HistoryIcon aria-hidden="true" />
						{t("history.card.open")}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

/** Why publishing saves no Revisions, and what happens to those saved before. */
export function RevisionsOff({
	off,
	retention,
}: {
	off: HistoryPage["revisions"]["off"];
	retention: HistoryPage["retention"];
}) {
	const t = useT();
	return (
		<p className="bg-muted rounded-md p-3 text-sm">
			{off === "postType" ? t("history.off.postType") : t("history.off.install")}{" "}
			{t("history.off.kept", { days: retention.revisionDays, kept: retention.revisionsKept })}
		</p>
	);
}
