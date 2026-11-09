import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import { ArrowUpCircleIcon } from "lucide-react";

import { useT } from "../i18n.tsx";

/**
 * "Update available": a newer WebCraft release is out, as the daily update check found. Shown to the
 * Superadmin on the Install's own pages, with a link to the release notes.
 */
export function UpdateBanner({ update }: { update: { version: string; running: string; url: string | null } }) {
	const t = useT();
	return (
		<div className="bg-muted/50 flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center">
			<ArrowUpCircleIcon className="text-primary hidden size-6 shrink-0 md:block" aria-hidden="true" />
			<div className="flex-1 space-y-1">
				<p className="font-semibold">{t("updateBanner.title", { version: update.version })}</p>
				<p className="text-muted-foreground text-sm">{t("updateBanner.body", { running: update.running })}</p>
			</div>
			{update.url ? (
				<div className="flex shrink-0">
					<a
						href={update.url}
						target="_blank"
						rel="noreferrer noopener"
						className={buttonVariants({ variant: "outline" })}
					>
						{t("updateBanner.action", { version: update.version })}
					</a>
				</div>
			) : null}
		</div>
	);
}
