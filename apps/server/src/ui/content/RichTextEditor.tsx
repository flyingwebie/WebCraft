import { cleanRichText } from "@webcraft/renderer/rich-text";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import {
	BoldIcon,
	ItalicIcon,
	LinkIcon,
	ListIcon,
	ListOrderedIcon,
	type LucideIcon,
	QuoteIcon,
	UnlinkIcon,
} from "lucide-react";
import { type FormEvent, useRef, useState } from "react";

import { type MessageKey, useT } from "../i18n.tsx";

/** A formatting command of the toolbar, and the element it writes (each one the rich text cleaner keeps). */
type Command = { id: string; label: MessageKey; icon: LucideIcon; run(editor: HTMLElement): void };

const COMMANDS: readonly Command[] = [
	{ id: "bold", label: "content.richText.bold", icon: BoldIcon, run: () => exec("bold") },
	{ id: "italic", label: "content.richText.italic", icon: ItalicIcon, run: () => exec("italic") },
	{ id: "bulleted", label: "content.richText.bulleted", icon: ListIcon, run: () => exec("insertUnorderedList") },
	{ id: "numbered", label: "content.richText.numbered", icon: ListOrderedIcon, run: () => exec("insertOrderedList") },
	{ id: "quote", label: "content.richText.quote", icon: QuoteIcon, run: () => exec("formatBlock", "blockquote") },
	{ id: "unlink", label: "content.richText.unlink", icon: UnlinkIcon, run: () => exec("unlink") },
];

/**
 * Runs one of the browser's editing commands on the selection. They are old but are still the only
 * way to change a selection that keeps the browser's own undo; what they write is cleaned on save.
 */
function exec(command: string, value?: string): void {
	document.execCommand(command, false, value);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text pasted into rich text: each paragraph its own `<p>`, lines kept with `<br>`. */
function textToHtml(text: string): string {
	return text
		.split(/\r?\n\s*\r?\n/)
		.filter((paragraph) => paragraph.trim() !== "")
		.map((paragraph) => `<p>${paragraph.split(/\r?\n/).map(escapeHtml).join("<br>")}</p>`)
		.join("");
}

/**
 * A rich text Field's editor: formatted text (bold, italic, links, lists, quotes) in a text box with
 * a toolbar. Pasted HTML goes through the same cleaner the server uses on save, so what shows here is
 * what is kept. Keyboard shortcuts work as in any text box (Ctrl or ⌘ with B and I).
 */
export function RichTextEditor({
	id,
	labelledBy,
	describedBy,
	invalid,
	lang,
	value,
	onChange,
}: {
	id: string;
	labelledBy: string;
	describedBy?: string;
	invalid?: boolean;
	lang?: string;
	value: string | null;
	onChange(html: string): void;
}) {
	const t = useT();
	const editor = useRef<HTMLDivElement>(null);
	// The editor owns its text once it shows: React writes the starting value once and never again,
	// so typing never moves the caret.
	const [initial] = useState(() => value ?? "");
	const [linking, setLinking] = useState(false);
	const selection = useRef<Range | null>(null);
	const linkButton = useRef<HTMLButtonElement>(null);

	const changed = () => {
		const element = editor.current;
		if (!element) return;
		// Browsers start new lines as <div>; rich text keeps paragraphs.
		for (const child of [...element.children]) {
			if (child.tagName === "DIV") {
				const paragraph = document.createElement("p");
				paragraph.append(...child.childNodes);
				child.replaceWith(paragraph);
			}
		}
		onChange(element.innerHTML);
	};

	const run = (command: Command) => {
		const element = editor.current;
		if (!element) return;
		element.focus();
		command.run(element);
		changed();
	};

	const openLink = () => {
		const current = window.getSelection();
		const range = current && current.rangeCount > 0 ? current.getRangeAt(0) : null;
		selection.current = range && editor.current?.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
		setLinking(true);
	};

	const addLink = (url: string) => {
		const element = editor.current;
		if (!element) return;
		element.focus();
		const current = window.getSelection();
		if (selection.current && current) {
			current.removeAllRanges();
			current.addRange(selection.current);
		}
		// The cleaner keeps only addresses the renderer allows (http, https, mailto, tel, paths, #anchors).
		const link = cleanRichText(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
		const href = /href="([^"]*)"/.exec(link)?.[1]?.replace(/&amp;/g, "&") ?? "#";
		if (current && !current.isCollapsed) exec("createLink", href);
		else exec("insertHTML", link);
		changed();
	};

	return (
		<div
			className="data-[invalid=true]:border-destructive dark:bg-input/30 rounded-md border"
			data-invalid={invalid ? true : undefined}
		>
			<div
				role="toolbar"
				aria-label={t("content.richText.toolbar")}
				aria-controls={id}
				className="bg-muted/50 flex flex-wrap gap-1 border-b p-1"
			>
				{COMMANDS.slice(0, 2).map((command) => (
					<ToolbarButton key={command.id} command={command} onRun={run} />
				))}
				<Button
					ref={linkButton}
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("content.richText.link")}
					onMouseDown={(event) => event.preventDefault()}
					onClick={openLink}
				>
					<LinkIcon aria-hidden="true" />
				</Button>
				{COMMANDS.slice(2).map((command) => (
					<ToolbarButton key={command.id} command={command} onRun={run} />
				))}
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: formatted text needs an editable element; no native control holds it. */}
			<div
				ref={editor}
				id={id}
				role="textbox"
				tabIndex={0}
				aria-multiline="true"
				aria-labelledby={labelledBy}
				aria-describedby={describedBy}
				aria-invalid={invalid ? true : undefined}
				lang={lang}
				contentEditable
				suppressContentEditableWarning
				className="focus-visible:ring-ring/50 min-h-28 rounded-b-md px-3 py-2 text-sm outline-none focus-visible:ring-3 [&_a]:underline [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_ol]:list-decimal [&_ol]:ps-6 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:ps-6"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: rich text the server cleaned on save (an allowlist of elements).
				dangerouslySetInnerHTML={{ __html: initial }}
				onFocus={() => exec("defaultParagraphSeparator", "p")}
				onInput={changed}
				onPaste={(event) => {
					event.preventDefault();
					const html = event.clipboardData.getData("text/html");
					const text = event.clipboardData.getData("text/plain");
					exec("insertHTML", html ? cleanRichText(html) : textToHtml(text));
					changed();
				}}
				onDrop={(event) => event.preventDefault()}
			/>
			<LinkDialog open={linking} onOpenChange={setLinking} finalFocus={linkButton} onAdd={addLink} />
		</div>
	);
}

function ToolbarButton({ command, onRun }: { command: Command; onRun(command: Command): void }) {
	const t = useT();
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={t(command.label)}
			// Keeps the selection in the text while the button is pressed.
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => onRun(command)}
		>
			<command.icon aria-hidden="true" />
		</Button>
	);
}

/** Asks for a link's address: the selected text becomes the link (or the address itself, with no selection). */
export function LinkDialog({
	open,
	onOpenChange,
	finalFocus,
	onAdd,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	finalFocus: React.RefObject<HTMLElement | null>;
	onAdd(url: string): void;
}) {
	const t = useT();
	const [url, setUrl] = useState("");
	const [missing, setMissing] = useState(false);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (url.trim() === "") {
			setMissing(true);
			return;
		}
		onOpenChange(false);
		onAdd(url.trim());
		setUrl("");
		setMissing(false);
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("content.richText.close")} finalFocus={finalFocus}>
				<form onSubmit={submit} className="grid gap-6" noValidate>
					<DialogHeader>
						<DialogTitle>{t("content.richText.linkTitle")}</DialogTitle>
					</DialogHeader>
					<Field data-invalid={missing ? true : undefined}>
						<FieldLabel htmlFor="rich-text-link">{t("content.richText.linkAddress")}</FieldLabel>
						<Input
							id="rich-text-link"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							autoComplete="off"
							aria-invalid={missing ? true : undefined}
							aria-describedby={missing ? "rich-text-link-help rich-text-link-error" : "rich-text-link-help"}
						/>
						<FieldDescription id="rich-text-link-help">{t("content.richText.linkHelp")}</FieldDescription>
						{missing ? <FieldError id="rich-text-link-error">{t("content.richText.linkMissing")}</FieldError> : null}
					</Field>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							{t("content.richText.cancel")}
						</DialogClose>
						<Button type="submit">{t("content.richText.addLink")}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
