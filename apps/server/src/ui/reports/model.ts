import type { ApiClient } from "@webcraft/api";

type Answer<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;

/** A Report, as `reports.list` answers it. */
export type ReportView = Answer<ApiClient["reports"]["list"]>["reports"][number];
/** An entry of a Report's history. */
export type ReportSend = Answer<ApiClient["reports"]["history"]>["sends"][number];
/** An entry with what it shows, for review. */
export type ReportSendDetail = Answer<ApiClient["reports"]["sends"]["get"]>["send"];
/** A Share link, as `shareLinks.list` answers it. */
export type ShareLinkView = Answer<ApiClient["shareLinks"]["list"]>["links"][number];
/** A Workspace's branding of its Reports and Share links. */
export type WorkspaceBranding = Answer<ApiClient["reportBranding"]["workspace"]["get"]>["branding"];
/** The Install's agency brand and switches. */
export type InstallBranding = Answer<ApiClient["reportBranding"]["install"]["get"]>["branding"];
/** A logo, as the admin sees it: its type and size. */
export type LogoView = InstallBranding["logo"];

/** Where a Dashboard is: a Site, or a Workspace. */
export type ReportPlace = { siteId: string } | { workspaceId: string };

/** The languages a Report or Share link page can be in, by their own names. */
export const REPORT_LANGUAGE_NAMES = { en: "English", it: "Italiano" } as const;
export type ReportLanguage = keyof typeof REPORT_LANGUAGE_NAMES;

/** Recipients typed one per line (or separated by commas), as a list. */
export function recipientsFrom(text: string): string[] {
	return text
		.split(/[\n,;]+/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** Downloads a PDF the API answered (base64), as the browser saves any file. */
export function downloadPdf({ filename, base64 }: { filename: string; base64: string }): void {
	const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
	const link = document.createElement("a");
	link.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** A file read as base64, for a logo: what `reportBranding.*.update` takes. */
export async function logoFrom(file: File): Promise<{ contentType: string; data: string }> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return { contentType: file.type, data: btoa(binary) };
}

/** A size in kilobytes, for a logo. */
export function kilobytes(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
