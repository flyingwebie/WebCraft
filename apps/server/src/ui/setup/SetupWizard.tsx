import { type AdminLanguageCode, adminLanguageDirection } from "@webcraft/core/admin-languages";
import { CheckIcon, LockIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { AdminIntl, useT } from "../i18n.tsx";
import type { ShellContext } from "../shell/context.ts";
import { WIZARD_STEPS, type WizardStep } from "./steps.tsx";

/**
 * The setup wizard. Before the Superadmin exists it is open to whoever holds the setup token; once
 * the account is created it goes on, signed in as the Superadmin, until the last step finishes setup.
 */
export function SetupWizard({ shell, linkedToken }: { shell: ShellContext; linkedToken?: string }) {
	const [language, setLanguage] = useState<AdminLanguageCode>(shell.language.code);

	// The wizard can switch language before anyone has an account: the page follows it.
	useEffect(() => {
		const html = document.documentElement;
		const before = { lang: html.lang, dir: html.dir };
		html.lang = language;
		html.dir = adminLanguageDirection(language);
		return () => {
			html.lang = before.lang;
			html.dir = before.dir;
		};
	}, [language]);

	return (
		<AdminIntl language={language}>
			<Wizard shell={shell} linkedToken={linkedToken} language={language} setLanguage={setLanguage} />
		</AdminIntl>
	);
}

function Wizard({
	shell,
	linkedToken,
	language,
	setLanguage,
}: {
	shell: ShellContext;
	linkedToken?: string;
	language: AdminLanguageCode;
	setLanguage(language: AdminLanguageCode): void;
}) {
	const t = useT();
	const claimed = shell.setup.stage === "continue";
	const [token, setToken] = useState<string | null>(null);
	const [index, setIndex] = useState(() => (claimed ? firstIndexOf("continue") : 0));
	const panel = useRef<HTMLDivElement>(null);
	const shownIndex = useRef(index);

	// Once the account exists, the wizard is at the first step after it.
	useEffect(() => {
		if (claimed) setIndex((current) => Math.max(current, firstIndexOf("continue")));
	}, [claimed]);

	// Each new step's heading takes focus, so screen readers announce it; not on first load.
	useLayoutEffect(() => {
		if (shownIndex.current === index) return;
		shownIndex.current = index;
		panel.current?.querySelector<HTMLElement>("h1")?.focus();
	}, [index]);

	const step = WIZARD_STEPS[index] as WizardStep;
	const previous = WIZARD_STEPS[index - 1];
	const { Panel } = step;

	return (
		<main
			id="main"
			tabIndex={-1}
			className="bg-muted flex min-h-svh items-center justify-center p-4 outline-none md:p-10"
		>
			<div className="bg-card text-card-foreground grid w-full max-w-5xl overflow-hidden rounded-xl border shadow-sm md:min-h-[36rem] md:grid-cols-[19rem_1fr]">
				<div className="bg-sidebar flex flex-col gap-8 border-b p-6 md:border-e md:border-b-0 md:p-8">
					<p className="flex items-center gap-3 text-lg font-semibold">
						<span
							className="bg-foreground text-background flex size-9 items-center justify-center rounded-md"
							aria-hidden="true"
						>
							W
						</span>
						{t("setup.title")}
					</p>
					<ol aria-label={t("setup.stepsLabel")} className="flex flex-col gap-5">
						{WIZARD_STEPS.map((item, position) => {
							const done = position < index;
							const current = position === index;
							return (
								<li key={item.id} aria-current={current ? "step" : undefined} className="flex items-start gap-3">
									<span
										className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium ${
											done
												? "bg-primary text-primary-foreground border-transparent"
												: current
													? "bg-foreground text-background border-transparent"
													: "text-muted-foreground"
										}`}
										aria-hidden="true"
									>
										{done ? <CheckIcon className="size-4" /> : position + 1}
									</span>
									<span className="flex flex-col">
										<span className={current || done ? "font-medium" : "text-muted-foreground"}>
											{t(item.title)}
											{done ? <span className="sr-only"> ({t("setup.stepDone")})</span> : null}
										</span>
										<span className="text-muted-foreground text-sm">
											{t(done && item.doneHint ? item.doneHint : item.hint)}
										</span>
									</span>
								</li>
							);
						})}
					</ol>
					<p className="text-muted-foreground mt-auto flex items-start gap-2 text-sm">
						<LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						{t("setup.lockNote")}
					</p>
				</div>
				<div ref={panel} className="flex flex-col gap-6 p-6 md:p-10">
					<p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
						{t("setup.stepCount", { current: index + 1, total: WIZARD_STEPS.length })}
					</p>
					<Panel
						key={step.id}
						token={token}
						linkedToken={step.id === "token" ? linkedToken : undefined}
						language={language}
						setLanguage={setLanguage}
						isLast={index === WIZARD_STEPS.length - 1}
						onDone={(result) => {
							if (result?.token) setToken(result.token);
							setIndex(Math.min(index + 1, WIZARD_STEPS.length - 1));
						}}
						onBack={previous && previous.stage === step.stage ? () => setIndex(index - 1) : undefined}
					/>
				</div>
			</div>
		</main>
	);
}

function firstIndexOf(stage: WizardStep["stage"]): number {
	return Math.max(
		0,
		WIZARD_STEPS.findIndex((step) => step.stage === stage),
	);
}
