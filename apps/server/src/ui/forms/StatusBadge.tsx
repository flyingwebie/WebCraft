import { Badge } from "@webcraft/ui/components/badge.tsx";

import { useT } from "../i18n.tsx";

/** Where a Form stands: a Draft never published, published as it is, or changed since. */
export function StatusBadge({ status }: { status: "draft" | "published" | "changed" }) {
	const t = useT();
	return <Badge variant={status === "published" ? "secondary" : "outline"}>{t(`forms.statuses.${status}`)}</Badge>;
}
