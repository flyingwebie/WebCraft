import { FIELD_KEY } from "@webcraft/core/field-rules";
import { fixedTextsOf, type TreeNode } from "@webcraft/renderer/builder";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { keyFromLabel } from "../../content/field-drafts.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { excerpt } from "../editing/fixed-text.ts";
import { componentNameProblem, type MadeTexts } from "../editing/layer-ops.ts";

const BUTTON = `inline-flex h-8 shrink-0 items-center justify-center rounded-[7px] px-3 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`;

/**
 * What the dialog asks a name for: Make Component (the selection moves into it), New Component
 * (empty), or Make reusable Component (a Page's Section becomes a library Component, ADR 0038).
 */
export type ComponentNameRequest = {
	kind: "make" | "new" | "reusable";
	/** The suggestion the name field starts with. */
	suggested: string;
	/** What it says under the title. */
	text: string;
	/**
	 * Make Component: what moves into it, whose fixed text the dialog offers to turn into Props (BA-33),
	 * each the Prop's default.
	 */
	node?: TreeNode;
	/** Makes the Component (with the fixed text chosen, by `fixedTextsOf` order); answers why not, or null once made. */
	submit(name: string, texts: MadeTexts): Promise<string | null>;
};

/** The key a piece of fixed text's Prop starts with, from its first words (`openEveryDay`), never one taken. */
function suggestedKey(text: string, taken: Set<string>): string {
	const stem = keyFromLabel(text.split(/\s+/).slice(0, 3).join(" ")) || "text";
	let base = stem.replaceAll(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
	if (!FIELD_KEY.test(base)) base = "text";
	let key = base;
	for (let count = 2; taken.has(key); count++) key = `${base}_${count}`;
	taken.add(key);
	return key;
}

/**
 * Asks a new Component's name (BA-10: Make Component from the tree row's menu and Actions, New
 * Component from Actions and Insert): a modal `<dialog>` on the chrome, the name field focused with
 * its suggestion selected, the rule under it, and Make or Create. Escape and Cancel leave nothing made.
 */
export function ComponentNameDialog({
	words,
	request,
	onDone,
}: {
	words: Words;
	request: ComponentNameRequest;
	onDone(): void;
}) {
	const said = words.componentDialog;
	const dialog = useRef<HTMLDialogElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(request.suggested);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const id = useId();
	const said2 = words.fixedText.component;
	const texts = useMemo(() => (request.kind === "make" && request.node ? fixedTextsOf(request.node) : []), [request]);
	const suggestions = useMemo(() => {
		const taken = new Set<string>();
		return texts.map((text) => suggestedKey(text.text.trim(), taken));
	}, [texts]);
	/** The pieces turned into Props, by their index, with each Prop's key. */
	const [chosen, setChosen] = useState<ReadonlyMap<number, string>>(new Map());
	useEffect(() => {
		const opened = dialog.current;
		const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (opened && !opened.open) opened.showModal();
		field.current?.select();
		return () => {
			opened?.close();
			if (back?.isConnected) back.focus();
		};
	}, []);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const wrong = componentNameProblem(name.trim(), [], words);
		if (wrong) {
			setProblem(wrong);
			field.current?.focus();
			return;
		}
		const picked = [...chosen].map(([index, key]) => ({ index, key: key.trim() }));
		const keys = new Set<string>();
		for (const each of picked) {
			const wrongKey = !FIELD_KEY.test(each.key)
				? fill(said2.keyInvalid, { key: each.key })
				: keys.has(each.key.toLowerCase())
					? fill(said2.keyTwice, { key: each.key })
					: null;
			if (wrongKey) {
				setProblem(wrongKey);
				return;
			}
			keys.add(each.key.toLowerCase());
		}
		setBusy(true);
		const refused = await request.submit(name.trim(), picked);
		setBusy(false);
		if (refused) {
			setProblem(refused);
			field.current?.focus();
			return;
		}
		onDone();
	};
	return (
		<dialog
			ref={dialog}
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-text`}
			onCancel={(event) => {
				event.preventDefault();
				onDone();
			}}
			className="bg-chrome-menu text-chrome-text border-chrome-hover m-auto w-[420px] max-w-[calc(100vw-32px)] rounded-[10px] border p-4 font-sans shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/50"
			data-wc-component-dialog={request.kind}
		>
			<form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" noValidate>
				<h2 id={`${id}-title`} className="text-chrome-strong m-0 text-[14px] font-semibold">
					{request.kind === "make" ? said.makeTitle : request.kind === "reusable" ? said.reusableTitle : said.newTitle}
				</h2>
				<p id={`${id}-text`} className="text-chrome-muted m-0 text-[13px]">
					{request.text}
				</p>
				<label className="flex flex-col gap-1.5 text-[12px] font-medium" htmlFor={`${id}-name`}>
					{said.name}
					<input
						ref={field}
						id={`${id}-name`}
						value={name}
						onChange={(event) => {
							setName(event.target.value);
							setProblem(null);
						}}
						aria-invalid={problem ? true : undefined}
						aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ""}`}
						spellCheck={false}
						autoComplete="off"
						className="bg-chrome-well border-chrome-hover text-chrome-strong focus:ring-chrome-focus h-8 rounded-md border px-2 font-mono text-[12px] outline-none focus:ring-2"
						data-wc-component-name=""
					/>
				</label>
				<p id={`${id}-hint`} className="text-chrome-muted m-0 text-[12px]">
					{said.nameHint}
				</p>
				{texts.length > 0 ? (
					<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" data-wc-component-texts="">
						<legend className="text-chrome-strong mb-1 p-0 text-[12px] font-medium">{said2.texts}</legend>
						<p className="text-chrome-muted m-0 text-[12px]">{said2.textsHelp}</p>
						<ul className="m-0 flex max-h-56 list-none flex-col gap-1.5 overflow-auto p-0">
							{texts.map((text, index) => {
								const key = chosen.get(index);
								return (
									// biome-ignore lint/suspicious/noArrayIndexKey: a piece of text is where it is in what moves.
									<li key={index} className="border-chrome-hover flex flex-col gap-1.5 rounded-md border p-2">
										<label className="flex items-start gap-2 text-[12px]">
											<input
												type="checkbox"
												checked={key !== undefined}
												onChange={(event) =>
													setChosen((before) => {
														const next = new Map(before);
														if (event.target.checked) next.set(index, suggestions[index] ?? "text");
														else next.delete(index);
														return next;
													})
												}
												className={`mt-0.5 accent-[#7c3aed] ${FOCUS_RING}`}
											/>
											<span>
												{said2.turnIntoProp}
												<span className="text-chrome-muted block">{`“${excerpt(text.text, 60)}”`}</span>
											</span>
										</label>
										{key !== undefined ? (
											<label className="flex flex-col gap-1 text-[12px] font-medium" htmlFor={`${id}-key-${index}`}>
												{said2.propKey}
												<input
													id={`${id}-key-${index}`}
													value={key}
													onChange={(event) => {
														const typed = event.target.value;
														setChosen((before) => new Map(before).set(index, typed));
														setProblem(null);
													}}
													spellCheck={false}
													autoComplete="off"
													className="bg-chrome-well border-chrome-hover text-chrome-strong focus:ring-chrome-focus h-8 rounded-md border px-2 font-mono text-[12px] outline-none focus:ring-2"
												/>
											</label>
										) : null}
									</li>
								);
							})}
						</ul>
					</fieldset>
				) : null}
				{problem ? (
					<p id={`${id}-problem`} role="alert" className="text-chrome-danger m-0 text-[12px]">
						{problem}
					</p>
				) : null}
				<div className="flex items-center justify-end gap-2">
					<button type="button" onClick={onDone} className={`${BUTTON} text-chrome-text hover:bg-chrome-hover`}>
						{said.cancel}
					</button>
					<button
						type="submit"
						disabled={busy}
						className={`${BUTTON} bg-[#7c3aed] text-white hover:bg-[#6d28d9] disabled:opacity-60`}
						data-wc-component-submit=""
					>
						{request.kind === "make" ? said.make : request.kind === "reusable" ? said.reusable : said.create}
					</button>
				</div>
			</form>
		</dialog>
	);
}
