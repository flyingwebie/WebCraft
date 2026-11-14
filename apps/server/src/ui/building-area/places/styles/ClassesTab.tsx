import { CLASS_NAME, isReservedName } from "@webcraft/renderer/builder";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useCodeFormat } from "../../../code-format/FormatControl.tsx";
import type { Editing } from "../../../design-system/editing.ts";
import type { EditableClass } from "../../../design-system/model.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { buttonLook } from "../content/ui.tsx";
import { CodeBox, FormatControl, NoteLine } from "./CodeBox.tsx";
import { canvasWidth } from "./canvas.ts";
import { QuickActions, type RuleEdit, useFavourites } from "./QuickActions.tsx";
import { piecesOf, type RuleBreakpoint, renamedRule, ruleOf, samePieces } from "./rule.ts";
import { CLASS_KINDS, type StylesView, shownClasses } from "./view.ts";

/** How widely a Class is used: elements of the Templates' and Components' Drafts, and published pages. */
export type ClassUsage = { elements: number; pages: number };

/** The breakpoints a rule's `@media` blocks name, with their ids. */
function ruleBreakpoints(editing: Editing): RuleBreakpoint[] {
	return editing.draft.tokens.breakpoints.flatMap((each) =>
		each.id ? [{ id: each.id, name: each.name, width: each.width }] : [],
	);
}

/** A Class's usage in words: "on 3 elements · 2 pages". */
function usageWords(words: Words, usage: ClassUsage | undefined): string {
	const shown = words.styles.classes;
	const elements = usage?.elements ?? 0;
	const pages = usage?.pages ?? 0;
	return fill(shown.usage, {
		elements: elements === 1 ? shown.elementsOne : fill(shown.elements, { count: String(elements) }),
		pages: pages === 1 ? shown.pagesOne : fill(shown.pages, { count: String(pages) }),
	});
}

/**
 * Styles › Classes (`places-assets/05`): the Site's Classes on the left (a search, New, the kind
 * filter: All, Class, Generated, In use, Unused; each Class with the elements it is on), and the
 * chosen Class's rule on the right: its name with Rename (elements keep a Class by its id, so every
 * element and page follows the new name), how widely it is used, the quick actions and Format over
 * the rule's code box. What is typed in the rule saves to the Class's pieces a moment later.
 */
export function ClassesTab({
	words,
	editing,
	view,
	setView,
	usage,
	refreshUsage,
	announce,
}: {
	words: Words;
	editing: Editing;
	view: StylesView;
	setView(view: StylesView, replace?: boolean): void;
	usage: ReadonlyMap<string, ClassUsage>;
	refreshUsage(): Promise<void>;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.styles.classes;
	const id = useId();
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newProblem, setNewProblem] = useState<string | null>(null);
	const newInput = useRef<HTMLInputElement>(null);
	const newButton = useRef<HTMLButtonElement>(null);
	const { classes } = editing.draft;
	const listed = shownClasses(classes, view, (classId) => usage.get(classId)?.elements ?? 0);
	const current = classes.find((each) => each.id === view.selected) ?? null;

	useEffect(() => {
		if (creating) newInput.current?.focus();
	}, [creating]);

	const create = async () => {
		const name = newName.trim().replace(/^\./, "");
		if (!CLASS_NAME.test(name) || isReservedName(name)) {
			setNewProblem(shown.nameInvalid);
			return;
		}
		if (classes.some((each) => each.name === name)) {
			setNewProblem(fill(shown.nameTaken, { name }));
			return;
		}
		setNewProblem(null);
		const made = await editing.now(async () => {
			const client = await editing.api();
			return client.designSystem.createClass({ siteId: editing.siteId, name });
		});
		if (!made) return;
		editing.replaceDraft(made.designSystem.draft);
		setCreating(false);
		setNewName("");
		announce(fill(shown.created, { name }));
		setView({ ...view, query: "", kind: "all", selected: made.class.id }, true);
		void refreshUsage();
	};

	const kindWords: Record<(typeof CLASS_KINDS)[number], string> = {
		all: shown.kinds.all,
		class: shown.kinds.class,
		generated: shown.kinds.generated,
		used: shown.kinds.used,
		unused: shown.kinds.unused,
	};

	return (
		<div className="flex min-h-0 min-w-0 grow gap-2.5" data-wc-styles-classes="">
			<div className="flex w-[405px] shrink-0 flex-col gap-2.5">
				<div className="flex gap-2">
					<search className="contents">
						<label className="bg-chrome-raised focus-within:ring-chrome-focus flex h-[30px] min-w-0 grow items-center gap-2 rounded-md px-2 focus-within:ring-2">
							<SearchIcon aria-hidden="true" className="text-chrome-muted size-3.5 flex-none" />
							<span className="sr-only">{shown.search}</span>
							<input
								type="search"
								value={view.query}
								placeholder={shown.search}
								onChange={(event) => setView({ ...view, query: event.target.value }, true)}
								aria-controls={`${id}-list`}
								autoComplete="off"
								className="text-chrome-strong placeholder:text-chrome-muted min-w-0 grow border-0 bg-transparent text-[12px] font-medium outline-none"
								data-wc-class-search=""
							/>
						</label>
					</search>
					<button
						ref={newButton}
						type="button"
						aria-expanded={creating}
						onClick={() => {
							setCreating(true);
							setNewProblem(null);
							newInput.current?.focus();
						}}
						className={buttonLook("primary")}
						data-wc-class-new=""
					>
						<PlusIcon aria-hidden="true" className="size-3.5" />
						{shown.new}
					</button>
				</div>
				<fieldset className="m-0 flex gap-1 border-0 p-0">
					<legend className="sr-only">{shown.kinds.label}</legend>
					{CLASS_KINDS.map((kind) => (
						<button
							key={kind}
							type="button"
							aria-pressed={view.kind === kind}
							onClick={() => setView({ ...view, kind })}
							className={`flex h-[27px] grow items-center justify-center rounded-md text-[10px] font-bold tracking-[0.5px] uppercase ${
								view.kind === kind
									? "bg-chrome-raised text-chrome-strong"
									: "text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text"
							} ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-class-kind={kind}
						>
							{kindWords[kind]}
						</button>
					))}
				</fieldset>
				<div className="border-chrome-hover flex min-h-0 grow flex-col gap-0.5 overflow-y-auto rounded-[10px] border p-2">
					{creating ? (
						<form
							noValidate
							onSubmit={(event) => {
								event.preventDefault();
								void create();
							}}
							className="flex flex-col gap-1 pb-1"
							data-wc-class-create=""
						>
							<label className="sr-only" htmlFor={`${id}-new`}>
								{shown.newName}
							</label>
							<input
								ref={newInput}
								id={`${id}-new`}
								value={newName}
								placeholder={shown.newName}
								onChange={(event) => setNewName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.preventDefault();
										event.stopPropagation();
										setCreating(false);
										setNewName("");
										setNewProblem(null);
										newButton.current?.focus();
									}
								}}
								aria-invalid={newProblem ? true : undefined}
								aria-describedby={newProblem ? `${id}-new-problem` : undefined}
								spellCheck={false}
								autoComplete="off"
								className="border-chrome-hover bg-chrome text-chrome-strong placeholder:text-chrome-muted focus:border-chrome-focus focus:ring-chrome-focus h-[27px] rounded-md border px-2 font-mono text-[12px] outline-none focus:ring-1"
							/>
							{newProblem ? (
								<p id={`${id}-new-problem`} className="m-0 px-0.5 text-[11px] text-red-200">
									{newProblem}
								</p>
							) : null}
						</form>
					) : null}
					<ul id={`${id}-list`} aria-label={shown.list} className="m-0 flex list-none flex-col gap-0.5 p-0">
						{listed.map((each) => {
							const on = each.id === view.selected;
							const elements = usage.get(each.id)?.elements ?? 0;
							return (
								<li key={each.id}>
									<button
										type="button"
										aria-current={on ? "true" : undefined}
										onClick={() => setView({ ...view, selected: each.id }, true)}
										className={`flex h-[27px] w-full items-center gap-2 rounded-md border-s-2 px-2 text-start ${
											on ? "border-selection bg-chrome-raised" : "hover:bg-chrome-raised border-transparent"
										} ${CHROME_EASE} ${FOCUS_RING}`}
										data-wc-class-row={each.name}
									>
										<span
											className={`min-w-0 grow truncate font-mono text-[12px] ${on ? "text-chrome-accent" : "text-chrome-text"}`}
										>
											.{each.name}
										</span>
										{each.generated ? (
											<span className="text-chrome-muted text-[10px] font-semibold uppercase">{shown.generated}</span>
										) : null}
										<span className="text-chrome-muted text-[11px]" data-wc-class-count="">
											<span className="sr-only">{`, ${usageWords(words, usage.get(each.id))}`}</span>
											<span aria-hidden="true">{elements}</span>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
					{listed.length === 0 ? (
						<p className="text-chrome-muted m-0 px-2 py-1.5 text-[12px]">
							{classes.length === 0 ? shown.empty : shown.none}
						</p>
					) : null}
					<p role="status" className="sr-only">
						{fill(shown.count, { shown: String(listed.length), count: String(classes.length) })}
					</p>
				</div>
			</div>
			<section
				aria-label={current ? fill(shown.ruleOf, { name: current.name }) : shown.list}
				className="border-chrome-hover flex min-w-0 grow flex-col gap-2 overflow-hidden rounded-[10px] border p-2"
			>
				{current ? (
					<ClassRule
						key={current.id}
						words={words}
						editing={editing}
						found={current}
						usage={usage.get(current.id)}
						announce={announce}
					/>
				) : (
					<p className="text-chrome-muted m-auto text-[12px]">{shown.pick}</p>
				)}
			</section>
		</div>
	);
}

/** One Class's rule: its name and Rename, its usage, the quick actions and Format, and the code box. */
function ClassRule({
	words,
	editing,
	found,
	usage,
	announce,
}: {
	words: Words;
	editing: Editing;
	found: EditableClass;
	usage: ClassUsage | undefined;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.styles.classes;
	const id = useId();
	const current = editing.draft.classes.find((each) => each.id === found.id) ?? found;
	const breakpoints = ruleBreakpoints(editing);
	const [text, setText] = useState(() => ruleOf(found.name, found, breakpoints));
	const [name, setName] = useState(found.name);
	const [renaming, setRenaming] = useState(false);
	const area = useRef<HTMLTextAreaElement>(null);
	const formatting = useCodeFormat("css", area, text);
	const [favourites, toggleFavourite] = useFavourites(editing.siteId);
	const read = piecesOf(text, current.name, breakpoints);
	const nameValid = CLASS_NAME.test(name) && !isReservedName(name);
	const nameTaken = editing.draft.classes.some((each) => each.id !== current.id && each.name === name);
	const canRename = name !== current.name && nameValid && !nameTaken && !renaming;

	const change = (next: string) => {
		setText(next);
		const pieces = piecesOf(next, current.name, breakpoints);
		if (pieces.ok && !samePieces(pieces.pieces, current)) {
			editing.changeClass(current.id, {
				styles: pieces.pieces.styles,
				css: pieces.pieces.css,
				breakpoints: pieces.pieces.breakpoints,
			});
		}
	};

	const edit = ({ text: next, caret }: RuleEdit) => {
		change(next);
		requestAnimationFrame(() => area.current?.setSelectionRange(caret, caret));
	};

	const rename = async () => {
		if (!canRename) return;
		setRenaming(true);
		const answer = await editing.now(async () => {
			const client = await editing.api();
			return client.designSystem.updateClass({ siteId: editing.siteId, classId: current.id, name });
		});
		setRenaming(false);
		if (!answer) return;
		editing.replaceDraft(answer.designSystem.draft);
		setText((was) => renamedRule(was, name));
		announce(fill(shown.renamed, { name }));
	};

	const problem = read.ok
		? null
		: {
				text: fill(shown.problems[read.problem], { name: current.name, line: String(read.line) }),
				line: read.line,
			};

	return (
		<>
			<div className="flex h-8 min-w-0 items-center gap-3">
				<label className="sr-only" htmlFor={`${id}-name`}>
					{shown.name}
				</label>
				<input
					id={`${id}-name`}
					value={name}
					onChange={(event) => setName(event.target.value.replace(/^\./, ""))}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void rename();
						}
					}}
					aria-invalid={nameValid && !nameTaken ? undefined : true}
					aria-describedby={`${id}-name-note`}
					spellCheck={false}
					autoComplete="off"
					className="border-chrome-hover bg-chrome text-chrome-strong focus:border-chrome-focus focus:ring-chrome-focus h-8 w-[420px] min-w-0 rounded-md border px-2.5 font-mono text-[12px] font-medium outline-none focus:ring-1"
					data-wc-class-name=""
				/>
				<button
					type="button"
					disabled={!canRename}
					onClick={() => void rename()}
					className={`${buttonLook("outline")} disabled:opacity-50`}
					data-wc-class-rename=""
				>
					{shown.rename}
				</button>
				{current.generated ? (
					<span className="bg-chrome-hover text-chrome-text rounded-[5px] px-1.5 text-[11px] font-medium">
						{shown.generated}
					</span>
				) : null}
				<span className="text-chrome-muted ms-auto shrink-0 text-[11px]" data-wc-class-usage="">
					{usageWords(words, usage)}
				</span>
			</div>
			<p id={`${id}-name-note`} className={nameValid && !nameTaken ? "sr-only" : "m-0 px-0.5 text-[11px] text-red-200"}>
				{!nameValid ? shown.nameInvalid : nameTaken ? fill(shown.nameTaken, { name }) : shown.renameHelp}
			</p>
			<div className="flex min-w-0 items-center gap-2">
				<QuickActions
					words={words}
					text={text}
					readable={read.ok}
					onEdit={edit}
					tokens={editing.draft.tokens}
					sizes={Object.fromEntries(
						[...editing.preview.scales.space, ...editing.preview.scales.text].map((step) => [step.id, step.size]),
					)}
					breakpoints={breakpoints}
					canvasWidth={canvasWidth}
					favourites={favourites}
					toggleFavourite={toggleFavourite}
					announce={announce}
				/>
				<span className="ms-auto inline-flex shrink-0">
					<FormatControl format={formatting} words={words} />
				</span>
			</div>
			<CodeBox
				ref={area}
				value={text}
				onChange={change}
				onKeyDown={(event) => {
					formatting.onKeyDown(event);
				}}
				label={fill(shown.ruleOf, { name: current.name })}
				describedBy={`${id}-note`}
				problemLine={formatting.problemLine ?? (read.ok ? null : read.line)}
				data={{ "data-wc-class-rule": current.name }}
			/>
			<NoteLine id={`${id}-note`} format={formatting} words={words} problem={problem} help={shown.ruleHelp} />
		</>
	);
}
