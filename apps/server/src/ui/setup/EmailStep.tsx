import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Skeleton } from "@webcraft/ui/components/skeleton.tsx";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { SmtpForm, type SmtpView } from "../email/SmtpForm.tsx";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { StepHeader } from "./StepHeader.tsx";
import type { StepPanelProps } from "./steps.tsx";

/**
 * The Install email step: the Install SMTP, with a test email. It can be skipped: until an SMTP is
 * set, System emails are written to the web log.
 */
export function EmailStep({ isLast, onDone, onBack }: StepPanelProps) {
	const t = useT();
	const router = useRouter();
	const [loaded, setLoaded] = useState<{ view: SmtpView; email: string } | null>(null);
	const [finishing, setFinishing] = useState(false);

	useEffect(() => {
		let current = true;
		(async () => {
			const api = await getApi();
			const [view, session] = await Promise.all([api.install.smtp.get(), api.session.current()]);
			if (current) setLoaded({ view, email: session.person?.email ?? "" });
		})().catch((error: unknown) => toast.error(t(errorMessage(error))));
		return () => {
			current = false;
		};
	}, [t]);

	/** On to the next step, or, on the last one, setup is finished and the admin opens. */
	const next = async () => {
		if (!isLast) return onDone();
		setFinishing(true);
		try {
			const api = await getApi();
			await api.setup.finish();
			await router.navigate({ to: "/" });
		} catch (error) {
			toast.error(t(errorMessage(error)));
			setFinishing(false);
		}
	};

	return (
		<div className="flex flex-1 flex-col gap-8">
			<StepHeader heading={t("setup.steps.email.heading")}>
				<p>{t("setup.steps.email.intro")}</p>
				<p>{t("setup.steps.email.later")}</p>
			</StepHeader>
			{loaded ? (
				<SmtpForm
					view={loaded.view}
					testTo={loaded.email}
					layout="plain"
					onSaved={next}
					actions={({ busy }) => (
						<>
							{onBack ? (
								<Button type="button" variant="ghost" className="me-auto" onClick={onBack}>
									<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
									{t("setup.back")}
								</Button>
							) : null}
							<Button type="button" variant="outline" onClick={next} disabled={busy || finishing}>
								{t("setup.steps.email.skip")}
							</Button>
							<Button type="submit" disabled={busy || finishing}>
								{isLast ? t("setup.steps.email.saveAndFinish") : t("setup.steps.email.save")}
							</Button>
						</>
					)}
				/>
			) : (
				<Skeleton className="h-96 w-full" />
			)}
		</div>
	);
}
