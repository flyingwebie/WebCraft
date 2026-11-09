import type { AdminLanguageCode } from "@webcraft/core/admin-languages";
import type { ComponentType } from "react";

import type { MessageKey } from "../i18n.tsx";
import { AccountStep } from "./AccountStep.tsx";
import { EmailStep } from "./EmailStep.tsx";
import { ModulesStep } from "./ModulesStep.tsx";
import { TokenStep } from "./TokenStep.tsx";
import { TwoFactorStep } from "./TwoFactorStep.tsx";

/** What a step's panel gets from the wizard. */
export type StepPanelProps = {
	/** The setup token, once the token step has checked it (claim stage only). */
	token: string | null;
	/** A token from the wizard's link in the log, checked as soon as the wizard opens. */
	linkedToken?: string;
	language: AdminLanguageCode;
	setLanguage(language: AdminLanguageCode): void;
	/** The step is done: the wizard moves to the next one. */
	onDone(result?: { token?: string }): void;
	/** Back to the previous step, when there is one in the same stage. */
	onBack?(): void;
	/** Whether this is the wizard's last step: it finishes setup. */
	isLast: boolean;
};

export type WizardStep = {
	id: string;
	title: MessageKey;
	hint: MessageKey;
	/** Shown under the title once the step is done; `hint` otherwise. */
	doneHint?: MessageKey;
	/**
	 * `claim`: before the Superadmin exists, open to whoever holds the setup token.
	 * `continue`: signed in as the new Superadmin.
	 */
	stage: "claim" | "continue";
	Panel: ComponentType<StepPanelProps>;
};

/**
 * The setup wizard's steps, in order. The steps after the account are `continue` steps: they run
 * signed in as the Superadmin, and the last one finishes setup: approving the first-party Modules.
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
	{
		id: "token",
		title: "setup.steps.token.title",
		hint: "setup.steps.token.hint",
		doneHint: "setup.steps.token.doneHint",
		stage: "claim",
		Panel: TokenStep,
	},
	{
		id: "account",
		title: "setup.steps.account.title",
		hint: "setup.steps.account.hint",
		stage: "claim",
		Panel: AccountStep,
	},
	{
		id: "two-factor",
		title: "setup.steps.twoFactor.title",
		hint: "setup.steps.twoFactor.hint",
		stage: "continue",
		Panel: TwoFactorStep,
	},
	{
		id: "email",
		title: "setup.steps.email.title",
		hint: "setup.steps.email.hint",
		stage: "continue",
		Panel: EmailStep,
	},
	{
		id: "modules",
		title: "setup.steps.modules.title",
		hint: "setup.steps.modules.hint",
		stage: "continue",
		Panel: ModulesStep,
	},
];
