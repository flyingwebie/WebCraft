import { Link } from "@tanstack/react-router";
import type { HealthPart } from "@webcraft/core";
import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import { HeartPulseIcon } from "lucide-react";

import { type MessageKey, useT } from "../i18n.tsx";

/**
 * Tells the Superadmin, on every admin page, that parts of the Install are Failing (Install health),
 * until they work again; Health alert emails go out besides, after 5 minutes.
 */
export function HealthBanner({ failing }: { failing: readonly HealthPart[] }) {
	const t = useT();
	const parts = failing.map((part) => t(`installHealth.parts.${part}` as MessageKey)).join(", ");
	return (
		<div className="border-destructive/40 bg-destructive/10 flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center">
			<HeartPulseIcon className="text-destructive hidden size-6 shrink-0 md:block" aria-hidden="true" />
			<div className="flex-1 space-y-1">
				<p className="font-semibold">{t("healthBanner.title")}</p>
				<p className="text-sm">{t("healthBanner.body", { parts })}</p>
			</div>
			<div className="flex shrink-0">
				<Link to="/install/health" className={buttonVariants()}>
					{t("healthBanner.action")}
				</Link>
			</div>
		</div>
	);
}
