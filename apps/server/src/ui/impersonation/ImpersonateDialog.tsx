import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, type RefObject, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";

/**
 * Asks before impersonating someone (ADR 0008): what it means (up to an hour, their account can't
 * change, everything recorded under both names, and they see it), and an optional reason kept in the
 * Audit log. Starting is a Sensitive action and needs the impersonator's own second factor; once it
 * starts, the admin opens at its home as the person, and Stop comes back to this page.
 */
export function ImpersonateDialog({
	person,
	you,
	open,
	onOpenChange,
	finalFocus,
}: {
	person: { id: string; name: string };
	/** The impersonator's own name, as the Audit log will show it. */
	you: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const ids = useId();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const returnTo = useRouterState({ select: (state) => state.location.pathname });
	const [reason, setReason] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const start = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const trimmed = reason.trim();
			await runSensitive(() =>
				api.impersonation.start({ personId: person.id, returnTo, ...(trimmed ? { reason: trimmed } : {}) }),
			);
			onOpenChange(false);
			await router.navigate({ to: "/" });
			await router.invalidate();
		} catch (failure) {
			const message = errorMessage(failure);
			if ((failure as { code?: string }).code === "IDENTITY_CHECK_CANCELLED") return;
			setError(message);
			toast.error(t(message));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("impersonation.cancel")} finalFocus={finalFocus}>
				<form onSubmit={start} noValidate className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{t("impersonation.title", { name: person.name })}</DialogTitle>
						<DialogDescription>{t("impersonation.intro", { name: person.name })}</DialogDescription>
					</DialogHeader>
					<ul className="text-muted-foreground list-disc space-y-1 ps-5 text-sm">
						<li>{t("impersonation.ruleAccount")}</li>
						<li>{t("impersonation.ruleRecorded", { you, name: person.name })}</li>
						<li>{t("impersonation.ruleOwn")}</li>
					</ul>
					<Field>
						<FieldLabel htmlFor={`${ids}-reason`}>{t("impersonation.reason")}</FieldLabel>
						<Input
							id={`${ids}-reason`}
							value={reason}
							maxLength={200}
							onChange={(event) => setReason(event.target.value)}
							aria-describedby={`${ids}-reason-help`}
						/>
						<FieldDescription id={`${ids}-reason-help`}>{t("impersonation.reasonHelp")}</FieldDescription>
					</Field>
					{error ? (
						<FieldError>
							{t(error)}
							{error === "errors.IMPERSONATION_NEEDS_TWO_FACTOR" ? (
								<>
									{" "}
									<Link to="/account" hash="two-factor" className={buttonVariants({ variant: "link", size: "sm" })}>
										{t("impersonation.openAccount")}
									</Link>
								</>
							) : null}
						</FieldError>
					) : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("impersonation.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("impersonation.start")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
