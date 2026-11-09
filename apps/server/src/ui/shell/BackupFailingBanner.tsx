import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import { ArchiveXIcon } from "lucide-react";

import { useT } from "../i18n.tsx";

/**
 * Tells the Superadmin the last Backup failed, on every admin page until one succeeds. The Install's
 * health and its alert emails (later) build on the same Backup log.
 */
export function BackupFailingBanner() {
	const t = useT();
	return (
		<div className="border-warning-border bg-warning text-warning-foreground flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center">
			<ArchiveXIcon className="hidden size-6 shrink-0 md:block" aria-hidden="true" />
			<div className="flex-1 space-y-1">
				<p className="font-semibold">{t("backupFailingBanner.title")}</p>
				<p className="text-sm">{t("backupFailingBanner.body")}</p>
			</div>
			<div className="flex shrink-0">
				<Link to="/settings/backups" className={buttonVariants()}>
					{t("backupFailingBanner.action")}
				</Link>
			</div>
		</div>
	);
}
