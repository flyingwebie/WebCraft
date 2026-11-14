import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { DownloadIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { type Folder, formsApi, type ReadFilter } from "./mailbox.ts";

/** The parts of the file a person can leave out. */
type Part = "sender" | "received" | "answers";
const PARTS: readonly Part[] = ["sender", "received", "answers"];

/** The file's own columns, before one column per field: when it came, its language, its page. */
const OWN_COLUMNS = 3;

/**
 * "Export this list as CSV": the Submissions the list shows (its folder, search, filter and language),
 * as a CSV file, with who sent each, when and where it came, and every other answer, each part ticked
 * or not. The Forms Module writes the file (and records the export in the Audit log); the parts left
 * out are taken out of it here.
 */
export function ExportDialog({
	open,
	onOpenChange,
	siteId,
	formId,
	filters,
	senderLabels,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	siteId: string;
	formId: string;
	filters: { folder: Folder; read: ReadFilter; search?: string; language?: string };
	/** The labels of the fields that say who sent a Submission (its name, its email address). */
	senderLabels: ReadonlySet<string>;
}) {
	const t = useT();
	const id = useId();
	const [parts, setParts] = useState<ReadonlySet<Part>>(() => new Set(PARTS));
	const [busy, setBusy] = useState(false);

	const exportCsv = async () => {
		setBusy(true);
		try {
			const api = formsApi(await getApi());
			const { filename, csv, count } = await api.submissions.export({ siteId, formId, ...filters });
			const link = document.createElement("a");
			link.href = URL.createObjectURL(
				new Blob([withParts(csv, parts, senderLabels)], { type: "text/csv;charset=utf-8" }),
			);
			link.download = filename;
			link.click();
			URL.revokeObjectURL(link.href);
			toast.success(t("submissions.exported", { count }));
			onOpenChange(false);
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent closeLabel={t("submissions.cancel")} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{t("submissions.exportTitle")}</DialogTitle>
				</DialogHeader>
				<fieldset className="grid gap-3">
					<legend className="sr-only">{t("submissions.exportParts")}</legend>
					{PARTS.map((part) => (
						<Field key={part} orientation="horizontal">
							<Checkbox
								id={`${id}-${part}`}
								checked={parts.has(part)}
								onCheckedChange={(checked) =>
									setParts((before) => {
										const next = new Set(before);
										if (checked === true) next.add(part);
										else next.delete(part);
										return next;
									})
								}
							/>
							<FieldLabel htmlFor={`${id}-${part}`} className="font-normal">
								{t(`submissions.exportPart.${part}`)}
							</FieldLabel>
						</Field>
					))}
				</fieldset>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("submissions.cancel")}</DialogClose>
					<Button type="button" onClick={() => void exportCsv()} disabled={busy || parts.size === 0}>
						<DownloadIcon data-icon="inline-start" />
						{t("submissions.exportButton")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The file with only the parts ticked: its own columns for "received", the sender's for "sender". */
function withParts(csv: string, parts: ReadonlySet<Part>, senderLabels: ReadonlySet<string>): string {
	if (parts.size === PARTS.length) return csv;
	const rows = parseCsv(csv.replace(/^﻿/, ""));
	const header = rows[0] ?? [];
	const kept = header
		.map((label, index) => {
			const part: Part = index < OWN_COLUMNS ? "received" : senderLabels.has(label) ? "sender" : "answers";
			return parts.has(part) ? index : -1;
		})
		.filter((index) => index >= 0);
	const lines = rows.map((row) => kept.map((index) => `"${(row[index] ?? "").replace(/"/g, '""')}"`).join(","));
	return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * The rows of a CSV file as the Forms Module writes it (every cell quoted, quotes doubled, rows ended
 * with CRLF, line breaks inside cells kept). Its cells keep what the Module made of them, so a cell
 * it made text (a formula's start) stays text.
 */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let at = 0; at < text.length; at++) {
		const character = text[at];
		if (quoted) {
			if (character === '"' && text[at + 1] === '"') {
				cell += '"';
				at++;
			} else if (character === '"') quoted = false;
			else cell += character;
		} else if (character === '"') quoted = true;
		else if (character === ",") {
			row.push(cell);
			cell = "";
		} else if (character === "\n" || character === "\r") {
			if (character === "\r" && text[at + 1] === "\n") at++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += character;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}
