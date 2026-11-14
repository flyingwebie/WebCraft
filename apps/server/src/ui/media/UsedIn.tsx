import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Link2Icon } from "lucide-react";

import { type MessageKey, useT } from "../i18n.tsx";
import { useMediaHost } from "./host.tsx";

/** Where a file is used, as the Management API answers it. */
export type MediaUses = Awaited<ReturnType<ApiClient["media"]["usage"]>>["usedIn"];

type Use = MediaUses[number];

/** How a place is named in the admin's words. */
function placeName(use: Use, t: ReturnType<typeof useT>): string {
	switch (use.kind) {
		case "entry":
			return t("media.usedIn.entry", { title: use.title || t("media.usedIn.untitled"), postType: use.postType.name });
		case "globals":
			return t("media.usedIn.globals");
		case "template": {
			const keys: Record<typeof use.templateKind, MessageKey> = {
				site: "media.usedIn.siteTemplate",
				entry: "media.usedIn.entryTemplate",
				archive: "media.usedIn.archiveTemplate",
			};
			return t(keys[use.templateKind], { postType: use.postType?.name ?? "" });
		}
		case "popup":
			return `${t("popups.title")}: ${use.name}`;
		case "component":
			return t("media.usedIn.component", { name: use.name });
		case "loop":
			return t("media.usedIn.loop", { name: use.name });
		case "designSystem":
			return t("media.usedIn.designSystem");
		case "seoSettings":
			return t("media.usedIn.seoSettings");
	}
}

/**
 * The places a file is used, each linked by the host (`host.tsx`) to where it is changed when the
 * person can open it there.
 */
export function UsedInList({
	siteId,
	usedIn,
	permissions,
}: {
	siteId: string;
	usedIn: MediaUses;
	permissions: readonly string[];
}) {
	const t = useT();
	const { UseLink } = useMediaHost();
	const structure = permissions.includes("structure.edit");
	return (
		<ul className="grid gap-1.5 text-sm">
			{usedIn.map((use) => {
				const name = placeName(use, t);
				const draftOnly = !use.versions.includes("published");
				const linkClass = "hover:underline focus-visible:ring-ring/50 rounded-sm outline-none focus-visible:ring-3";
				// The host links the place to where it is changed (the admin's screens; the building area's
				// canvas or the admin), when the person can open it there.
				const label = UseLink ? (
					<UseLink siteId={siteId} use={use} structure={structure} className={linkClass}>
						{name}
					</UseLink>
				) : (
					<span>{name}</span>
				);
				return (
					<li key={`${use.kind}:${"id" in use ? use.id : ""}`} className="flex flex-wrap items-center gap-2">
						<Link2Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
						{label}
						{draftOnly ? <Badge variant="outline">{t("media.usedIn.draftOnly")}</Badge> : null}
					</li>
				);
			})}
		</ul>
	);
}

/** The Used in section of a file's details. */
export function UsedIn({
	siteId,
	usedIn,
	permissions,
}: {
	siteId: string;
	usedIn: MediaUses;
	permissions: readonly string[];
}) {
	const t = useT();
	return (
		<section aria-labelledby="media-used-in-heading" className="grid gap-2 border-t pt-4">
			<h3 id="media-used-in-heading" className="text-sm font-medium">
				{usedIn.length === 0 ? t("media.usedIn.heading") : t("media.usedIn.count", { count: usedIn.length })}
			</h3>
			{usedIn.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("media.usedIn.none")}</p>
			) : (
				<UsedInList siteId={siteId} usedIn={usedIn} permissions={permissions} />
			)}
		</section>
	);
}
