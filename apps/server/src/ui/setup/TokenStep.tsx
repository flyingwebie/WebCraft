import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { StepHeader } from "./StepHeader.tsx";
import type { StepPanelProps } from "./steps.tsx";

/** Step 1: the one-time setup token from the web process's log. */
export function TokenStep({ token, linkedToken, onDone }: StepPanelProps) {
	const t = useT();
	const router = useRouter();
	const [value, setValue] = useState(token ?? linkedToken ?? "");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const checkedLink = useRef(false);

	const check = async (candidate: string) => {
		if (candidate.trim() === "") {
			setError("setup.steps.token.required");
			document.getElementById("setup-token")?.focus();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.setup.checkToken({ token: candidate });
			onDone({ token: candidate.trim() });
		} catch (failure) {
			if (errorCode(failure) === "SETUP_CLOSED") await router.invalidate();
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	// The link in the log carries the token: check it straight away.
	useEffect(() => {
		if (linkedToken && !token && !checkedLink.current) {
			checkedLink.current = true;
			void check(linkedToken);
		}
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		void check(value);
	};

	return (
		<form onSubmit={submit} className="flex flex-1 flex-col gap-8" noValidate>
			<StepHeader heading={t("setup.steps.token.heading")}>
				<p>{t("setup.steps.token.intro")}</p>
			</StepHeader>
			<Field data-invalid={error ? true : undefined}>
				<FieldLabel htmlFor="setup-token">{t("setup.steps.token.label")}</FieldLabel>
				<Input
					id="setup-token"
					name="token"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					autoComplete="off"
					spellCheck={false}
					required
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? "setup-token-help setup-token-error" : "setup-token-help"}
					className="font-mono"
				/>
				<FieldDescription id="setup-token-help">{t("setup.steps.token.help")}</FieldDescription>
				{error ? <FieldError id="setup-token-error">{t(error)}</FieldError> : null}
			</Field>
			<div className="mt-auto flex justify-end">
				<Button type="submit" disabled={busy}>
					{t("setup.continue")}
				</Button>
			</div>
		</form>
	);
}
