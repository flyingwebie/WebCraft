import { Badge } from "@webcraft/ui/components/badge.tsx";
import { MinusIcon, PencilIcon, PlusIcon } from "lucide-react";

import { type MessageKey, useT } from "../i18n.tsx";
import type { ComparedPart, Shown } from "./model.ts";

/** How a Block, a row or a line stands against the other side. */
type Status = "same" | "changed" | "added" | "removed";

/** Singular names of the Block types, for a Body shown Block by Block. */
const BLOCK_NAMES: Record<string, MessageKey> = {
	paragraph: "history.block.paragraph",
	heading: "history.block.heading",
	list: "history.block.list",
	quote: "history.block.quote",
	image: "history.block.image",
	video: "history.block.video",
	table: "history.block.table",
	callout: "history.block.callout",
	code: "history.block.code",
	divider: "history.block.divider",
	toggle: "history.block.toggle",
};

/** A mark saying how something differs, in words and with an icon, never by colour alone. */
export function StatusMark({ status }: { status: Exclude<Status, "same"> }) {
	const t = useT();
	const Icon = status === "added" ? PlusIcon : status === "removed" ? MinusIcon : PencilIcon;
	return (
		<Badge variant={status === "changed" ? "default" : "outline"} className="shrink-0">
			<Icon aria-hidden="true" />
			{t(`history.status.${status}`)}
		</Badge>
	);
}

/** The border an item that differs carries beside its mark (the mark says it in words). */
function edge(status: Status): string {
	return status === "same" ? "border-transparent" : "border-primary";
}

/** One side of a part, as it reads. */
export function ShownValue({ shown, language }: { shown: Shown; language?: string }) {
	const t = useT();
	switch (shown.kind) {
		case "empty":
			return <p className="text-muted-foreground text-sm italic">{t("history.shown.empty")}</p>;
		case "fallback":
			return <p className="text-muted-foreground text-sm italic">{t("history.shown.fallback")}</p>;
		case "boolean":
			return <p className="text-sm">{shown.value ? t("history.shown.yes") : t("history.shown.no")}</p>;
		case "text":
			return (
				<p className="text-sm break-words whitespace-pre-wrap" lang={language}>
					{shown.text}
				</p>
			);
		case "code":
			return <CodeText text={shown.text} />;
		case "fields":
			return <FieldList fields={shown.fields} language={language} />;
		case "rows":
			return shown.rows.length === 0 ? (
				<p className="text-muted-foreground text-sm italic">{t("history.shown.empty")}</p>
			) : (
				<ol className="grid gap-2">
					{shown.rows.map((row, index) => (
						<li key={row.id} className={`grid gap-1 border-s-4 ps-3 ${edge(row.status)}`}>
							<p className="flex flex-wrap items-center gap-2 text-sm font-medium">
								{t("history.shown.row", { number: index + 1 })}
								{row.status === "same" ? null : <StatusMark status={row.status} />}
							</p>
							<FieldList fields={row.fields} language={language} />
						</li>
					))}
				</ol>
			);
		case "blocks":
			return shown.blocks.length === 0 ? (
				<p className="text-muted-foreground text-sm italic">{t("history.shown.empty")}</p>
			) : (
				<ol className="grid gap-2">
					{shown.blocks.map((block) => (
						<li key={block.id} className={`grid gap-1 border-s-4 ps-3 ${edge(block.status)}`}>
							<p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs font-medium">
								{BLOCK_NAMES[block.type] ? t(BLOCK_NAMES[block.type] as MessageKey) : block.type}
								{block.status === "same" ? null : <StatusMark status={block.status} />}
							</p>
							{block.text ? (
								<p className="text-sm break-words whitespace-pre-wrap" lang={language}>
									{block.text}
								</p>
							) : null}
						</li>
					))}
				</ol>
			);
	}
}

/** A Group's Fields (or a row's), each marked when it differs. */
function FieldList({ fields, language }: { fields: Extract<Shown, { kind: "fields" }>["fields"]; language?: string }) {
	return (
		<dl className="grid gap-2">
			{fields.map((field) => (
				<div key={field.key} className={`grid gap-0.5 border-s-4 ps-3 ${edge(field.changed ? "changed" : "same")}`}>
					<dt className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs font-medium">
						{field.label}
						{field.changed ? <StatusMark status="changed" /> : null}
					</dt>
					<dd>
						<ShownValue shown={field.shown} language={language} />
					</dd>
				</div>
			))}
		</dl>
	);
}

/** Markup, CSS, a script or settings as text, long lines wrapped. */
function CodeText({ text }: { text: string }) {
	return (
		<pre className="bg-muted rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">
			<code>{text}</code>
		</pre>
	);
}

/** How many unchanged lines are shown around each change; longer runs are folded. */
const CONTEXT_LINES = 2;

/**
 * Text that spans lines, as one list: lines only in the Revision or Checkpoint, only in the Draft, or
 * in both. Long runs of lines that are the same are folded, saying how many, so a long Template reads
 * as its changes.
 */
export function LineChanges({ lines }: { lines: NonNullable<ComparedPart["lines"]> }) {
	const t = useT();
	const near = (index: number) =>
		lines.slice(Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1).some((line) => line.status !== "same");
	const shown: ({ kind: "line"; index: number } | { kind: "fold"; count: number; at: number })[] = [];
	lines.forEach((_, index) => {
		if (near(index)) shown.push({ kind: "line", index });
		else {
			const last = shown.at(-1);
			if (last?.kind === "fold") last.count++;
			else shown.push({ kind: "fold", count: 1, at: index });
		}
	});
	return (
		<ol aria-label={t("history.lines.label")} className="bg-muted rounded-md py-2 font-mono text-xs">
			{shown.map((entry) => {
				if (entry.kind === "fold") {
					return (
						<li key={`fold-${entry.at}`} className="text-muted-foreground px-3 py-1 font-sans italic">
							{t("history.lines.folded", { count: entry.count })}
						</li>
					);
				}
				const line = lines[entry.index] as (typeof lines)[number];
				return (
					<li
						key={`line-${entry.index}`}
						className={`flex gap-2 border-s-4 px-2 ${line.status === "same" ? "border-transparent" : "border-primary bg-background/60"}`}
					>
						<span aria-hidden="true" className="w-3 shrink-0 select-none">
							{line.status === "added" ? "+" : line.status === "removed" ? "−" : " "}
						</span>
						{line.status === "same" ? null : <span className="sr-only">{t(`history.lines.${line.status}`)}</span>}
						<span className="min-w-0 break-words whitespace-pre-wrap">{line.text}</span>
					</li>
				);
			})}
		</ol>
	);
}
