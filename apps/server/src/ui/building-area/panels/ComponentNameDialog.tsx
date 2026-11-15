import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type { Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { componentNameProblem } from "../editing/layer-ops.ts";

const BUTTON = `inline-flex h-8 shrink-0 items-center justify-center rounded-[7px] px-3 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`;

/** What the dialog asks a name for: Make Component (the selection moves into it) or New Component (empty). */
export type ComponentNameRequest = {
	kind: "make" | "new";
	/** The suggestion the name field starts with. */
	suggested: string;
	/** What it says under the title. */
	text: string;
	/** Makes the Component; answers why not (shown under the field), or null once made. */
	submit(name: string): Promise<string | null>;
};

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
		setBusy(true);
		const refused = await request.submit(name.trim());
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
					{request.kind === "make" ? said.makeTitle : said.newTitle}
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
						{request.kind === "make" ? said.make : said.create}
					</button>
				</div>
			</form>
		</dialog>
	);
}
