import type { SystemEmailData, SystemEmailType } from "../catalogue.ts";

/** What one System email says, before the layout wraps it. Plain text: the layout escapes it. */
export type EmailContent = {
	subject: string;
	heading: string;
	paragraphs: string[];
	/** The one button, linking to a path in the admin. */
	action?: { label: string; path: string };
	/** A short line under the button, such as how long the link works. */
	note?: string;
};

/** What every email's wording may use besides its own data. */
export type WordingContext = {
	/** The Install's name, or WebCraft when it has none. */
	installName: string;
};

/** The words of the layout around every System email. */
export type LayoutWording = {
	/** Shown above the plain link under the button. */
	linkHint: string;
	sentBy(installName: string): string;
	/** The link to the person's email switches, on emails they can turn off. */
	preferences: string;
};

/** Everything System emails say in one Admin language: every type's wording, and the layout's. */
export type EmailWording = {
	types: { [Type in SystemEmailType]: (data: SystemEmailData<Type>, context: WordingContext) => EmailContent };
	layout: LayoutWording;
};
