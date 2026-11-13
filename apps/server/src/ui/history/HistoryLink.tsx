import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import { HistoryIcon } from "lucide-react";

import { useT } from "../i18n.tsx";
import { type HistoryItem, itemSearch } from "./model.ts";

/** Opens an item's History screen: its Revisions and Checkpoints, Compare and Restore. */
export function HistoryLink({
	siteId,
	item,
	name,
	size = "default",
	emails = false,
}: {
	siteId: string;
	item: HistoryItem;
	/** The item's name, said to screen readers where several links sit side by side (a list's rows). */
	name?: string;
	size?: "default" | "sm";
	/** A Form's emails, beside the Form's own History link: says whose history it opens. */
	emails?: boolean;
}) {
	const t = useT();
	return (
		<Link
			to="/sites/$siteId/history"
			params={{ siteId }}
			search={itemSearch(item)}
			className={buttonVariants({ variant: "outline", size })}
		>
			<HistoryIcon aria-hidden="true" />
			{emails ? t("history.emailsLink") : t("history.link")}
			{name ? <span className="sr-only">{t("history.linkNamed", { name })}</span> : null}
		</Link>
	);
}
