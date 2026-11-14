import { type AdminLanguageCode, adminLanguageDirection } from "@webcraft/core/admin-languages";
import { Separator } from "@webcraft/ui/components/separator.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { CheckIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { AuthPage } from "../auth/AuthPage.tsx";
import { AdminIntl, useT } from "../i18n.tsx";
import type { ShellContext } from "../shell/context.ts";
import { WIZARD_STEPS, type WizardStep } from "./steps.tsx";

/**
 * The setup wizard, on the card the sign-in pages use (WebCraft's mark above it: the agency has no
 * name yet): the steps down the left, the current one at the right. Before the Superadmin exists it is open to whoever holds the setup token; once
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
		<AuthPage mark="webcraft" width="wide" below={t("setup.lockNote")} className="gap-0 p-0">
			<div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-stretch sm:gap-8 sm:p-8">
				<div className="sm:w-44 sm:shrink-0">
					<ol aria-label={t("setup.stepsLabel")} className="flex flex-col gap-1">
						{WIZARD_STEPS.map((item, position) => {
							const done = position < index;
							const current = position === index;
							return (
								<li
									key={item.id}
									aria-current={current ? "step" : undefined}
									className="flex items-center gap-2.5 text-sm"
								>
									<span
										className={cn(
											"flex size-[22px] shrink-0 items-center justify-center rounded-full text-xs font-semibold",
											done
												? "bg-green-700 text-white dark:bg-green-600"
												: current
													? "bg-primary text-primary-foreground"
													: "text-muted-foreground border",
										)}
										aria-hidden="true"
									>
										{done ? <CheckIcon className="size-[13px]" strokeWidth={3} /> : position + 1}
									</span>
									<span className={current ? "font-semibold" : done ? undefined : "text-muted-foreground"}>
										{t(item.title)}
										{done ? <span className="sr-only"> ({t("setup.stepDone")})</span> : null}
									</span>
								</li>
							);
						})}
					</ol>
				</div>
				<Separator orientation="vertical" className="hidden sm:block" />
				<Separator className="sm:hidden" />
				<div ref={panel} className="flex min-w-0 flex-1 flex-col">
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
		</AuthPage>
	);
}

function firstIndexOf(stage: WizardStep["stage"]): number {
	return Math.max(
		0,
		WIZARD_STEPS.findIndex((step) => step.stage === stage),
	);
}
