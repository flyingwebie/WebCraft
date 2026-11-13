import { Link, useRouter } from "@tanstack/react-router";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * Reminds a person without two-factor authentication to add it, on every admin page until they do.
 * "Remind me later" puts it off for 7 days, never for good.
 */
export function TwoFactorReminderBanner() {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	const later = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.me.twoFactor.remindLater();
			toast.success(t("twoFactor.reminder.postponed"));
			await router.invalidate();
			// The banner and its buttons are gone: keep keyboard focus on the page, not lost.
			document.getElementById("main")?.focus();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			aria-labelledby="two-factor-reminder"
			className="bg-muted/60 flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center"
		>
			<ShieldCheckIcon className="text-muted-foreground hidden size-6 shrink-0 md:block" aria-hidden="true" />
			<div className="flex-1 space-y-1">
				<h2 id="two-factor-reminder" className="font-semibold">
					{t("twoFactor.reminder.title")}
				</h2>
				<p className="text-muted-foreground text-sm">{t("twoFactor.reminder.body")}</p>
			</div>
			<div className="flex shrink-0 gap-2">
				<Button variant="outline" onClick={later} disabled={busy}>
					{t("twoFactor.reminder.later")}
				</Button>
				<Link to="/account" hash="two-factor" className={buttonVariants()}>
					{t("twoFactor.reminder.setUp")}
				</Link>
			</div>
		</section>
	);
}
