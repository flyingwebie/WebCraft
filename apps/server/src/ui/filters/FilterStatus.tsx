import { useT } from "../i18n.tsx";
import { StateBadge } from "../settings/layout.tsx";

/** Where a Filter stands, as a badge in words: a Draft never published, published as it is, or changed since. */
export function FilterStatus({ status }: { status: "draft" | "published" | "changed" }) {
	const t = useT();
	return (
		<StateBadge tone={status === "published" ? "success" : status === "changed" ? "warning" : "neutral"}>
			{t(`forms.statuses.${status}`)}
		</StateBadge>
	);
}
