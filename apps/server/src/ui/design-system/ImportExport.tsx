import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { ChevronDownIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { ProblemList } from "./DesignSystemScreen.tsx";
import { type DesignSystemView, type ImportPreview, type Problem, problemsOf } from "./model.ts";

/** Hands the browser a JSON file to save. */
function download(name: string, content: unknown) {
	const url = URL.createObjectURL(new Blob([`${JSON.stringify(content, null, "\t")}\n`], { type: "application/json" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export: the whole Design system as one file (the Draft's, or the published one), or the Design
 * tokens alone as DTCG for other tools.
 */
export function ExportMenu({ siteId, beforeExport }: { siteId: string; beforeExport(): Promise<boolean> }) {
	const t = useT();
	const run = async (what: "draft" | "published" | "tokens") => {
		try {
			if (!(await beforeExport())) return;
			const api = await getApi();
			if (what === "tokens") download("design-tokens.json", (await api.designSystem.exportTokens({ siteId })).tokens);
			else
				download(
					what === "draft" ? "design-system.json" : "design-system-published.json",
					(await api.designSystem.exportFile({ siteId, version: what })).file,
				);
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button type="button" variant="outline" />}>
				<DownloadIcon aria-hidden="true" />
				{t("designSystem.export.button")}
				<ChevronDownIcon aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-auto min-w-64">
				<DropdownMenuItem onClick={() => void run("draft")}>{t("designSystem.export.draft")}</DropdownMenuItem>
				<DropdownMenuItem onClick={() => void run("published")}>{t("designSystem.export.published")}</DropdownMenuItem>
				<DropdownMenuItem onClick={() => void run("tokens")}>{t("designSystem.export.tokens")}</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Import: a Design system file chosen here is checked and shown first (what each section gains, loses
 * and changes); "Replace the Draft" then replaces the Draft with it, never what visitors see, which
 * changes only when the Design system is published. A file that can't be read says why and where.
 */
export function ImportDialog({
	siteId,
	beforeImport,
	onImported,
}: {
	siteId: string;
	beforeImport(): Promise<boolean>;
	onImported(designSystem: DesignSystemView): void;
}) {
	const t = useT();
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [file, setFile] = useState<Record<string, unknown> | null>(null);
	const [asked, setAsked] = useState<{ confirmation: string; preview: ImportPreview } | null>(null);
	const [failure, setFailure] = useState<{ message: string; problems: Problem[] } | null>(null);
	const [busy, setBusy] = useState(false);

	const reset = () => {
		setFile(null);
		setAsked(null);
		setFailure(null);
	};

	const choose = async (chosen: File | undefined) => {
		reset();
		if (!chosen) return;
		setBusy(true);
		try {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await chosen.text());
			} catch {
				setFailure({ message: t("designSystem.import.notJson"), problems: [] });
				return;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				setFailure({ message: t("designSystem.import.notJson"), problems: [] });
				return;
			}
			if (!(await beforeImport())) return;
			const api = await getApi();
			const answer = await api.designSystem.importFile({ siteId, file: parsed as Record<string, unknown> });
			if ("confirmation" in answer) {
				setFile(parsed as Record<string, unknown>);
				setAsked({ confirmation: answer.confirmation.id, preview: answer.preview });
			}
		} catch (error) {
			setFailure({ message: t(errorMessage(error)), problems: problemsOf(error) });
		} finally {
			setBusy(false);
		}
	};

	const confirm = async () => {
		if (!file || !asked) return;
		setBusy(true);
		try {
			const api = await getApi();
			const answer = await api.designSystem.importFile({ siteId, file, confirmation: asked.confirmation });
			if ("designSystem" in answer) {
				onImported(answer.designSystem);
				setOpen(false);
				reset();
				toast.success(t("designSystem.import.done"));
			}
		} catch (error) {
			setFailure({ message: t(errorMessage(error)), problems: problemsOf(error) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button ref={trigger} type="button" variant="outline" onClick={() => setOpen(true)}>
				<UploadIcon aria-hidden="true" />
				{t("designSystem.import.button")}
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) reset();
				}}
			>
				<DialogContent closeLabel={t("designSystem.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{t("designSystem.import.title")}</DialogTitle>
						<DialogDescription>{t("designSystem.import.body")}</DialogDescription>
					</DialogHeader>
					<Field>
						<FieldLabel htmlFor={`${id}-file`}>{t("designSystem.import.file")}</FieldLabel>
						<Input
							id={`${id}-file`}
							type="file"
							accept="application/json,.json"
							disabled={busy}
							onChange={(event) => void choose(event.target.files?.[0])}
							aria-describedby={`${id}-file-help`}
						/>
						<FieldDescription id={`${id}-file-help`}>{t("designSystem.import.fileHelp")}</FieldDescription>
					</Field>
					{failure ? (
						<div role="alert" className="text-destructive grid gap-2 text-sm">
							<p className="font-medium">{failure.message}</p>
							<ProblemList problems={failure.problems} />
						</div>
					) : null}
					{asked ? <ImportChanges preview={asked.preview} /> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("designSystem.cancel")}</DialogClose>
						<Button type="button" disabled={busy || !asked} onClick={confirm}>
							{t("designSystem.import.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** What importing the file changes in the Draft, section by section. */
function ImportChanges({ preview }: { preview: ImportPreview }) {
	const t = useT();
	const { changes } = preview;
	const lines: string[] = [];
	const names = (list: readonly string[]) => list.join(", ");
	const section = (what: string, change: { added: string[]; removed: string[]; changed: string[] }) => {
		const parts = [
			change.added.length > 0 ? t("designSystem.import.adds", { names: names(change.added) }) : null,
			change.removed.length > 0 ? t("designSystem.import.removes", { names: names(change.removed) }) : null,
			change.changed.length > 0 ? t("designSystem.import.changes", { names: names(change.changed) }) : null,
		].filter(Boolean);
		if (parts.length > 0) lines.push(`${what}: ${parts.join("; ")}`);
	};
	for (const each of changes.tokens) section(t(`designSystem.tokens.group.${each.kind}`), each);
	for (const setting of changes.tokenSettings) lines.push(t(`designSystem.import.setting.${setting}`));
	section(t("designSystem.tabs.classes"), changes.classes);
	if (changes.baseStyles.length > 0)
		lines.push(t("designSystem.import.baseStyles", { elements: names(changes.baseStyles) }));
	if (changes.customCss) lines.push(t("designSystem.import.customCss"));
	if (changes.darkMode)
		lines.push(changes.darkMode.to ? t("designSystem.import.darkOn") : t("designSystem.import.darkOff"));
	return (
		<section aria-labelledby="design-import-changes" className="grid gap-2 text-sm">
			<h3 id="design-import-changes" className="font-medium">
				{t("designSystem.import.changesHeading")}
			</h3>
			{changes.any ? (
				<ul className="grid list-disc gap-1 ps-5">
					{lines.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			) : (
				<p>{t("designSystem.import.nothing")}</p>
			)}
		</section>
	);
}
