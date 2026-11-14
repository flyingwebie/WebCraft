import { ChevronsUpDownIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { fill, type Words } from "./api.ts";
import { type Choice, type ChoiceGroup, ChoiceMenu } from "./ChoiceMenu.tsx";
import { CHROME_EASE, FOCUS_RING } from "./controls.tsx";
import type { BuildingDocument } from "./documents.ts";
import type { GoToData, PostTypeRow } from "./management.ts";

/** What the open document is called: its name, and the kind beside it (`Blog posts` · `Entry template`). */
export type DocumentTitle = { name: string; kind: string | null };

/** The Site's Pages, Templates and Components that the switcher lists, from Go to's data. */
export type Switchable = { goTo: GoToData; postTypes: readonly PostTypeRow[] };

/** What the open document is called, from what the shell knows of the Site. */
export function documentTitle(
	words: Words,
	document: BuildingDocument | null,
	known: { page: string | null; postTypes: readonly PostTypeRow[]; goTo: GoToData | null },
): DocumentTitle {
	const shown = words.documents;
	const postType = (id: string) => known.postTypes.find((each) => each.id === id)?.name ?? "";
	switch (document?.kind) {
		case undefined:
			return { name: shown.missingTitle, kind: null };
		case "page":
			return { name: known.page || shown.untitled, kind: null };
		case "siteTemplate":
			return { name: shown.siteTemplate, kind: null };
		case "searchTemplate":
			return { name: shown.searchTemplate, kind: null };
		case "entryTemplate":
			return { name: postType(document.postTypeId), kind: shown.entryTemplate };
		case "archiveTemplate":
			return { name: postType(document.postTypeId), kind: shown.archiveTemplate };
		case "component":
			return {
				name: known.goTo?.components.find((each) => each.id === document.componentId)?.name ?? "",
				kind: shown.component,
			};
		case "form":
			return { name: shown.form, kind: null };
	}
}

/** A document title as one line of words (`Blog posts · Entry template`). */
export function titleText(words: Words, title: DocumentTitle): string {
	return title.kind && title.name
		? fill(words.documents.titled, { name: title.name, kind: title.kind })
		: title.name || (title.kind ?? "");
}

/** The documents the switcher lists, in its three groups, each with the document it opens. */
function switchable(words: Words, data: Switchable, current: BuildingDocument | null) {
	const shown = words.documents;
	const opens = new Map<string, BuildingDocument>();
	const choice = (key: string, label: string, document: BuildingDocument, detail?: string): Choice => {
		opens.set(key, document);
		const isCurrent =
			current !== null &&
			(current.kind === "entryTemplate" && document.kind === "entryTemplate"
				? current.postTypeId === document.postTypeId
				: JSON.stringify(current) === JSON.stringify(document));
		return { key, label, detail, current: isCurrent };
	};
	const pages = data.goTo.pages.map((page) =>
		choice(`page:${page.id}`, page.title || shown.untitled, { kind: "page", page: page.path }, page.path),
	);
	const templates: Choice[] = [
		choice("siteTemplate", shown.siteTemplate, { kind: "siteTemplate" }),
		choice("searchTemplate", shown.searchTemplate, { kind: "searchTemplate" }),
	];
	for (const postType of data.postTypes) {
		templates.push(
			choice(`entryTemplate:${postType.id}`, fill(shown.titled, { name: postType.name, kind: shown.entryTemplate }), {
				kind: "entryTemplate",
				postTypeId: postType.id,
				entryId: null,
			}),
		);
		if (data.goTo.postTypes.find((each) => each.id === postType.id)?.archive) {
			templates.push(
				choice(
					`archiveTemplate:${postType.id}`,
					fill(shown.titled, { name: postType.name, kind: shown.archiveTemplate }),
					{ kind: "archiveTemplate", postTypeId: postType.id },
				),
			);
		}
	}
	const components = data.goTo.components.map((component) =>
		choice(`component:${component.id}`, component.name, { kind: "component", componentId: component.id }),
	);
	const groups: ChoiceGroup[] = [
		{ label: shown.pages, choices: pages },
		{ label: shown.templates, choices: templates },
		...(components.length ? [{ label: shown.components, choices: components }] : []),
	];
	return { groups, opens };
}

/**
 * The open document's name, at the head of the Layers panel (SPEC 5, `places-content/06`): its name
 * strong and its kind beside it, and a click lists the Site's Pages, Templates and Components to switch
 * to (Go to's lists). Choosing one opens it as the next document.
 */
export function DocumentSwitcher({
	words,
	title,
	current,
	data,
	onOpen,
}: {
	words: Words;
	title: DocumentTitle;
	current: BuildingDocument | null;
	/** What it lists; null while it is read (the title shows, the menu waits). */
	data: Switchable | null;
	onOpen(document: BuildingDocument): void;
}) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const label = fill(words.documents.switch, { document: titleText(words, title) });
	const list = open && data ? switchable(words, data, current) : null;
	return (
		<div className="relative flex min-w-0 grow">
			<button
				ref={button}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				aria-label={label}
				disabled={!data}
				onClick={() => setOpen((was) => !was)}
				onKeyDown={(event) => {
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault();
						setOpen(true);
					}
				}}
				className={`hover:bg-chrome-hover flex h-6 min-w-0 grow items-center gap-1.5 rounded-[5px] px-1 text-start text-[12px] ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-document-title=""
			>
				<span className="text-chrome-strong truncate font-semibold">{title.name}</span>
				{title.kind ? <span className="text-chrome-muted shrink-0">{title.kind}</span> : null}
				<ChevronsUpDownIcon aria-hidden="true" className="text-chrome-muted ms-auto size-3.5 shrink-0" />
			</button>
			{list ? (
				<ChoiceMenu
					id={id}
					label={label}
					groups={list.groups}
					button={button}
					side="bottom"
					onChoose={(choice) => {
						const document = list.opens.get(choice.key);
						if (document) onOpen(document);
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
