import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { type FormProblem, problemsOf } from "./model.ts";

type Captcha = { scriptUrl: string; verifyUrl: string; siteKey: string; responseField: string; widgetClass: string };

export type CaptchaView = {
	captcha: Captcha | null;
	secret: { set: false } | { set: true; lastFour: string | null };
};

const EMPTY: Captcha = { scriptUrl: "", verifyUrl: "", siteKey: "", responseField: "", widgetClass: "" };

const SETTINGS: { key: keyof Captcha; label: MessageKey; help: MessageKey }[] = [
	{ key: "scriptUrl", label: "forms.captcha.scriptUrl", help: "forms.captcha.scriptUrlHelp" },
	{ key: "widgetClass", label: "forms.captcha.widgetClass", help: "forms.captcha.widgetClassHelp" },
	{ key: "siteKey", label: "forms.captcha.siteKey", help: "forms.captcha.siteKeyHelp" },
	{ key: "responseField", label: "forms.captcha.responseField", help: "forms.captcha.responseFieldHelp" },
	{ key: "verifyUrl", label: "forms.captcha.verifyUrl", help: "forms.captcha.verifyUrlHelp" },
];

/**
 * The Site's CAPTCHA, off unless Staff set one up: any challenge provider of the usual shape (a
 * script drawing a widget, an address checking its answers with the Site's secret key). Saving is a
 * Sensitive action: the secret key is a secret, never shown again (only its last four characters).
 */
export function CaptchaCard({ siteId, view }: { siteId: string; view: CaptchaView }) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [values, setValues] = useState<Captcha>(view.captcha ?? EMPTY);
	const [secret, setSecret] = useState("");
	const [problems, setProblems] = useState<FormProblem[]>([]);
	const [busy, setBusy] = useState(false);

	const save = async (captcha: Captcha | null) => {
		setBusy(true);
		setProblems([]);
		try {
			const api = await getApi();
			await runSensitive(() =>
				api.forms.captcha.set({ siteId, captcha, secret: captcha && secret !== "" ? secret : undefined }),
			);
			setSecret("");
			if (!captcha) setValues(EMPTY);
			toast.success(t(captcha ? "forms.captcha.saved" : "forms.captcha.off"));
			await router.invalidate();
		} catch (error) {
			const found = problemsOf(error);
			if (found.length > 0) setProblems(found);
			else toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void save(values);
	};
	const problemAt = (at: string) => problems.find((problem) => problem.at === at)?.message;

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("forms.captcha.title")}</h2>
				</CardTitle>
				<CardDescription>{t(view.captcha ? "forms.captcha.onIntro" : "forms.captcha.offIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} className="grid gap-6">
					<FieldGroup>
						{SETTINGS.map((setting) => {
							const id = `captcha-${setting.key}`;
							const problem = problemAt(setting.key);
							return (
								<Field key={setting.key} data-invalid={problem ? true : undefined}>
									<FieldLabel htmlFor={id}>{t(setting.label)}</FieldLabel>
									<Input
										id={id}
										value={values[setting.key]}
										onChange={(event) => setValues({ ...values, [setting.key]: event.target.value })}
										aria-describedby={`${id}-help${problem ? ` ${id}-error` : ""}`}
										aria-invalid={problem ? true : undefined}
									/>
									<FieldDescription id={`${id}-help`}>{t(setting.help)}</FieldDescription>
									{problem ? <FieldError id={`${id}-error`}>{problem}</FieldError> : null}
								</Field>
							);
						})}
						<Field data-invalid={problemAt("secret") ? true : undefined}>
							<FieldLabel htmlFor="captcha-secret">{t("forms.captcha.secret")}</FieldLabel>
							<Input
								id="captcha-secret"
								type="password"
								autoComplete="off"
								value={secret}
								onChange={(event) => setSecret(event.target.value)}
								aria-describedby={`captcha-secret-help${problemAt("secret") ? " captcha-secret-error" : ""}`}
								aria-invalid={problemAt("secret") ? true : undefined}
							/>
							<FieldDescription id="captcha-secret-help">
								{view.secret.set
									? t("forms.captcha.secretSet", { lastFour: view.secret.lastFour ?? "" })
									: t("forms.captcha.secretHelp")}
							</FieldDescription>
							{problemAt("secret") ? <FieldError id="captcha-secret-error">{problemAt("secret")}</FieldError> : null}
						</Field>
					</FieldGroup>
					<div className="flex flex-wrap gap-2">
						<Button type="submit" disabled={busy}>
							{t("forms.captcha.save")}
						</Button>
						{view.captcha ? (
							<Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
								{t("forms.captcha.switchOff")}
							</Button>
						) : null}
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
