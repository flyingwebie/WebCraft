import { ChevronUpIcon, CornerUpLeftIcon, FileCode2Icon, FileTextIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { type Choice, ChoiceMenu } from "../ChoiceMenu.tsx";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";

/** A filled control of the bar's left cluster (28 high, as the frames draw them). */
const PILL = `bg-chrome-raised text-chrome-text hover:bg-chrome-hover flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`;

/** One of the Entries an Entry template can preview. */
export type PreviewEntry = { id: string; title: string; path: string };

/**
 * The document's part of the bottom bar's left cluster (SPEC 2, `places-content/06`, `builder/08`),
 * after Undo and Redo:
 * - on a Template or Component opened from a page, "Back to {page}" (it goes back there);
 * - on an Entry template, the Entry it previews ("Preview: {Entry}"), a menu that swaps the page;
 * - on an Entry's page, for Staff, the Template that renders it ("Rendered by: …"), which opens it.
 */
export function DocumentNav({
	words,
	back,
	preview,
	renderedBy,
}: {
	words: Words;
	back: { title: string; onBack(): void } | null;
	preview: { entries: readonly PreviewEntry[]; current: string | null; onChoose(entry: PreviewEntry): void } | null;
	renderedBy: { template: string; onOpen(): void } | null;
}) {
	const shown = words.documents;
	return (
		<div className="flex min-w-0 items-center gap-2" data-wc-document-nav="">
			{back ? (
				<span className="group relative inline-flex min-w-0 shrink-0">
					<button
						type="button"
						onClick={back.onBack}
						aria-label={fill(shown.backTo, { page: back.title })}
						className={`${PILL} max-w-36`}
						data-wc-bar="back"
					>
						<CornerUpLeftIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
						<span className="truncate">{back.title}</span>
					</button>
					<Tip label={fill(shown.backTo, { page: back.title })} side="top" />
				</span>
			) : null}
			{preview ? <EntryPicker words={words} {...preview} /> : null}
			{renderedBy ? (
				<span className="group relative inline-flex min-w-0">
					<button
						type="button"
						onClick={renderedBy.onOpen}
						className={`${PILL} text-chrome-muted font-normal`}
						data-wc-bar="rendered-by"
					>
						<FileCode2Icon aria-hidden="true" className="size-3.5 shrink-0" />
						<span className="truncate">{fill(shown.renderedBy, { template: renderedBy.template })}</span>
					</button>
					<Tip label={fill(shown.renderedByLabel, { template: renderedBy.template })} side="top" />
				</span>
			) : null}
		</div>
	);
}

/** The Entry an Entry template previews (`places-content/06`): a menu, opening upwards, of its Post Type's Entries. */
function EntryPicker({
	words,
	entries,
	current,
	onChoose,
}: {
	words: Words;
	entries: readonly PreviewEntry[];
	current: string | null;
	onChoose(entry: PreviewEntry): void;
}) {
	const shown = words.documents;
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const entry = entries.find((each) => each.id === current);
	const title = entry ? entry.title || shown.untitled : null;
	const label = title ? fill(shown.previewLabel, { entry: title }) : shown.previewNone;
	const choices: Choice[] = entries.map((each) => ({
		key: each.id,
		label: each.title || shown.untitled,
		detail: each.path,
		current: each.id === current,
	}));
	return (
		<div className="relative min-w-0">
			<button
				ref={button}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				disabled={entries.length === 0}
				onClick={() => setOpen((was) => !was)}
				onKeyDown={(event) => {
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault();
						setOpen(true);
					}
				}}
				className={`${PILL} w-full max-w-56 disabled:opacity-60`}
				data-wc-bar="preview"
			>
				<FileTextIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
				<span className="truncate">{title ? fill(shown.preview, { entry: title }) : shown.previewNone}</span>
				<ChevronUpIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
			</button>
			{open ? (
				<ChoiceMenu
					id={id}
					label={label}
					groups={[{ label: null, choices }]}
					button={button}
					side="top"
					onChoose={(choice) => {
						const chosen = entries.find((each) => each.id === choice.key);
						if (chosen) onChoose(chosen);
					}}
					onClose={(focusButton) => {
						setOpen(false);
						if (focusButton) button.current?.focus();
					}}
				/>
			) : null}
		</div>
	);
}
