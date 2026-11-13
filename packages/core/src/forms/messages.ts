import { type FormVersion, formTextIn, formWords } from "@webcraft/renderer";

/** The message a Form shows once sent, in a language: its own, else WebCraft's words. */
export function sentMessage(version: FormVersion, language: string): string {
	return version.success.kind === "message" ? formTextIn(version.success.message, language) : formWords(language).sent;
}
