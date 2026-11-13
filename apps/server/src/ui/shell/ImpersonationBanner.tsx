import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { VenetianMaskIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import type { ShellContext } from "./context.ts";

type Impersonation = NonNullable<ShellContext["impersonation"]>;

/** Whole minutes left until `endsAt`, never below zero. */
function minutesLeft(endsAt: Date | string, now: number): number {
	return Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 60_000));
}

/**
 * The banner on every admin page while the session impersonates someone: who, how long is left, and
 * Stop. Screen readers hear who is impersonated when it appears (a polite live region filled once
 * the page is ready), and again when 5 minutes are left. When the hour runs out the page reloads its
 * context: the session is the impersonator's again.
 */
export function ImpersonationBanner({ impersonation }: { impersonation: Impersonation }) {
	const t = useT();
	const router = useRouter();
	// The server's "now" first, so the page reads the same before and after it starts in the browser.
	const served = new Date(impersonation.endsAt).getTime() - impersonation.secondsLeft * 1000;
	const [now, setNow] = useState(served);
	const [said, setSaid] = useState("");
	const [busy, setBusy] = useState(false);
	const left = minutesLeft(impersonation.endsAt, now);
	const name = impersonation.person.name;

	useEffect(() => {
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(timer);
	}, []);

	// Said once the page is ready, so screen readers announce it rather than skip it.
	useEffect(() => {
		setSaid(
			`${t("impersonation.bannerText", { name, email: impersonation.person.email })} ${t("impersonation.minutesLeft", { minutes: minutesLeft(impersonation.endsAt, Date.now()) })}`,
		);
	}, [t, name, impersonation.person.email, impersonation.endsAt]);

	useEffect(() => {
		if (left === 5) setSaid(t("impersonation.minutesLeft", { minutes: 5 }));
		if (left > 0 || now === served) return;
		toast.info(t("impersonation.ended"));
		void router.invalidate();
	}, [left, now, served, router, t]);

	const stop = async () => {
		setBusy(true);
		try {
			const { returnTo } = await (await getApi()).impersonation.stop();
			toast.success(t("impersonation.stopped"));
			await router.navigate({ to: returnTo ?? "/" });
			await router.invalidate();
			document.getElementById("main")?.focus();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			aria-labelledby="impersonation-banner"
			className="flex flex-col gap-3 border-b border-amber-500/40 bg-amber-100 px-6 py-3 text-amber-950 md:flex-row md:items-center dark:bg-amber-950 dark:text-amber-50"
		>
			<VenetianMaskIcon className="hidden size-5 shrink-0 md:block" aria-hidden="true" />
			<div className="flex-1">
				<h2 id="impersonation-banner" className="sr-only">
					{t("impersonation.bannerLabel")}
				</h2>
				<p className="text-sm font-medium">
					{t("impersonation.bannerText", { name, email: impersonation.person.email })}{" "}
					<span className="font-normal tabular-nums">{t("impersonation.minutesLeft", { minutes: left })}</span>
				</p>
			</div>
			<p className="sr-only" role="status">
				{said}
			</p>
			<Button
				variant="outline"
				onClick={() => void stop()}
				disabled={busy}
				className="border-amber-900/40 bg-transparent text-amber-950 hover:bg-amber-200 dark:border-amber-50/40 dark:text-amber-50 dark:hover:bg-amber-900"
			>
				{t("impersonation.stop")}
			</Button>
		</section>
	);
}
