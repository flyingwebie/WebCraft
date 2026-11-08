import { Link, useRouter } from "@tanstack/react-router";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { StepHeader } from "./StepHeader.tsx";
import type { StepPanelProps } from "./steps.tsx";

/**
 * Step 3: encourages two-factor authentication. Setting it up happens in the person's account
 * (Your account › Two-factor authentication); this step links there.
 */
export function TwoFactorStep({ isLast, onDone }: StepPanelProps) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	const next = async () => {
		if (!isLast) return onDone();
		setBusy(true);
		try {
			const api = await getApi();
			await api.setup.finish();
			// Every navigation reloads the shell context, so the admin knows setup is finished.
			await router.navigate({ to: "/" });
		} catch (error) {
			toast.error(t(errorMessage(error)));
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-1 flex-col gap-8">
			<StepHeader heading={t("setup.steps.twoFactor.heading")}>
				<p>{t("setup.steps.twoFactor.intro")}</p>
				<p>{t("setup.steps.twoFactor.recommend")}</p>
			</StepHeader>
			<div className="flex flex-col items-start gap-3">
				<Link to="/account" hash="two-factor" className={buttonVariants({ variant: "outline" })}>
					<ShieldCheckIcon aria-hidden="true" />
					{t("setup.steps.twoFactor.setUp")}
				</Link>
				<p className="text-muted-foreground text-sm">{t("setup.steps.twoFactor.later")}</p>
			</div>
			<div className="mt-auto flex justify-end">
				<Button onClick={next} disabled={busy}>
					{isLast ? t("setup.finish") : t("setup.continue")}
				</Button>
			</div>
		</div>
	);
}
