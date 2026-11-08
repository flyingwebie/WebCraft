import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import { MailWarningIcon } from "lucide-react";

import { useT } from "../i18n.tsx";

/**
 * Tells the Superadmin the Install SMTP is Failing, on every admin page until a send goes through.
 * An email about it would have to go through the failing server, so this notice is the alert.
 */
export function SmtpFailingBanner() {
	const t = useT();
	return (
		<div className="border-warning-border bg-warning text-warning-foreground flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center">
			<MailWarningIcon className="hidden size-6 shrink-0 md:block" aria-hidden="true" />
			<div className="flex-1 space-y-1">
				<p className="font-semibold">{t("smtpFailingBanner.title")}</p>
				<p className="text-sm">{t("smtpFailingBanner.body")}</p>
			</div>
			<div className="flex shrink-0">
				<Link to="/settings/email" className={buttonVariants()}>
					{t("smtpFailingBanner.action")}
				</Link>
			</div>
		</div>
	);
}
