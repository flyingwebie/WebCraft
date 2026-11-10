import { useRouteContext, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { CircleCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { TwoFactorSetupChoices } from "../two-factor/Setup.tsx";
import { StepHeader } from "./StepHeader.tsx";
import type { StepPanelProps } from "./steps.tsx";

/**
 * Step 3: sets up two-factor authentication for the new Superadmin, with an authenticator app or a
 * passkey (backup codes come with the first). It can be skipped: the admin then reminds them until
 * they add it.
 */
export function TwoFactorStep({ isLast, onDone }: StepPanelProps) {
	const t = useT();
	const router = useRouter();
	const { shell } = useRouteContext({ from: "__root__" });
	const [added, setAdded] = useState(false);
	const [busy, setBusy] = useState(false);
	const on = added || shell.twoFactor?.on === true;

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

	const whenAdded = async () => {
		setAdded(true);
		await router.invalidate();
	};

	return (
		<div className="flex flex-1 flex-col gap-8">
			<StepHeader heading={t("setup.steps.twoFactor.heading")}>
				<p>{t("setup.steps.twoFactor.intro")}</p>
				<p>{t("setup.steps.twoFactor.recommend")}</p>
			</StepHeader>
			{on ? (
				<p className="flex items-center gap-2 font-medium" role="status">
					<CircleCheckIcon className="text-primary size-5" aria-hidden="true" />
					{t("setup.steps.twoFactor.done")}
				</p>
			) : (
				<TwoFactorSetupChoices account={shell.person?.email ?? ""} onAdded={whenAdded} />
			)}
			<div className="mt-auto flex flex-wrap items-center justify-end gap-3">
				{on ? null : <p className="text-muted-foreground me-auto text-sm">{t("setup.steps.twoFactor.later")}</p>}
				{on ? (
					<Button onClick={next} disabled={busy}>
						{isLast ? t("setup.finish") : t("setup.continue")}
					</Button>
				) : (
					<Button variant="outline" onClick={next} disabled={busy}>
						{t("setup.steps.twoFactor.skip")}
					</Button>
				)}
			</div>
		</div>
	);
}
