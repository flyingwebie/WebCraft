import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { keyFromLabel } from "../../content/field-drafts.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { type BindAsk, bindingPath, type PropBindings } from "../editing/bind-prop.ts";

const BUTTON = `inline-flex h-8 shrink-0 items-center justify-center rounded-[7px] px-3 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`;
const BOX =
	"bg-chrome-well border-chrome-hover text-chrome-strong focus:ring-chrome-focus h-8 rounded-md border px-2 text-[12px] outline-none focus:ring-2";

/**
 * Bind to Prop for a Component's link or image (UI-21): a modal `<dialog>` on the chrome, as the
 * fixed text's question (`FixedTextDialog.tsx`). A new Prop of the setting's type is labelled (its key
 * follows the label, and can be changed), or one the Component has of that type is chosen. The dialog
 * stays open with the reason when it is refused; Escape and Cancel leave everything as it was, and
 * focus goes back where it was.
 */
export function BindPropDialog({
	words,
	ask,
	bindings,
	onDone,
}: {
	words: Words;
	ask: BindAsk;
	bindings: PropBindings;
	onDone(): void;
}) {
	const said = words.bindProp;
	const kind = ask.kind;
	const dialog = useRef<HTMLDialogElement>(null);
	const labelField = useRef<HTMLInputElement>(null);
	const id = useId();
	const options = bindings.existing(ask);
	const [mode, setMode] = useState<"new" | "existing">("new");
	const [label, setLabel] = useState<string>(said.newLabel[kind]);
	const [key, setKey] = useState("");
	const [keyTyped, setKeyTyped] = useState(false);
	const [existing, setExisting] = useState(options[0]?.key ?? "");
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		const opened = dialog.current;
		const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (opened && !opened.open) opened.showModal();
		labelField.current?.focus();
		labelField.current?.select();
		return () => {
			opened?.close();
			if (back?.isConnected) back.focus();
		};
	}, []);

	const shownKey = keyTyped ? key : keyFromLabel(label);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		const refused = bindings.bind(ask, mode === "new" ? { mode, label, key: shownKey } : { mode, key: existing });
		if (refused) {
			setProblem(refused);
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
			className="bg-chrome-menu text-chrome-text border-chrome-hover m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-[10px] border p-4 font-sans shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/50"
			data-wc-bind-prop-dialog={kind}
		>
			<form onSubmit={submit} className="flex flex-col gap-3" noValidate>
				<h2 id={`${id}-title`} className="text-chrome-strong m-0 text-[14px] font-semibold">
					{said.title[kind]}
				</h2>
				<p id={`${id}-text`} className="text-chrome-muted m-0 text-[13px]">
					{said.intro[kind]}
				</p>
				<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
					<legend className="sr-only">{said.title[kind]}</legend>
					{(["new", "existing"] as const).map((option) => (
						<label key={option} className="flex items-center gap-2 text-[12px]">
							<input
								type="radio"
								name={`${id}-mode`}
								checked={mode === option}
								onChange={() => {
									setMode(option);
									setProblem(null);
								}}
								className={`accent-[#6366f1] ${FOCUS_RING}`}
							/>
							{said.mode[option]}
						</label>
					))}
				</fieldset>
				{mode === "new" ? (
					<>
						<label className="flex flex-col gap-1.5 text-[12px] font-medium" htmlFor={`${id}-label`}>
							{words.fixedText.label}
							<input
								ref={labelField}
								id={`${id}-label`}
								value={label}
								onChange={(event) => {
									setLabel(event.target.value);
									setProblem(null);
								}}
								autoComplete="off"
								className={BOX}
								data-wc-bind-prop-label=""
							/>
						</label>
						<label className="flex flex-col gap-1.5 text-[12px] font-medium" htmlFor={`${id}-key`}>
							{words.fixedText.key}
							<input
								id={`${id}-key`}
								value={shownKey}
								onChange={(event) => {
									setKey(event.target.value);
									setKeyTyped(true);
									setProblem(null);
								}}
								aria-describedby={`${id}-key-help`}
								spellCheck={false}
								autoComplete="off"
								className={`${BOX} font-mono`}
							/>
						</label>
						<p id={`${id}-key-help`} className="text-chrome-muted m-0 text-[12px]">
							{fill(words.fixedText.keyHelp, { binding: `{{ ${bindingPath(kind, shownKey || "…")} }}` })}
						</p>
					</>
				) : (
					<label className="flex flex-col gap-1.5 text-[12px] font-medium" htmlFor={`${id}-existing`}>
						{said.existing}
						{options.length === 0 ? (
							<span className="text-chrome-muted text-[12px] font-normal">{said.noneExisting}</span>
						) : (
							<select
								id={`${id}-existing`}
								value={existing}
								onChange={(event) => {
									setExisting(event.target.value);
									setProblem(null);
								}}
								className={BOX}
							>
								<option value="">{said.none}</option>
								{options.map((option) => (
									<option key={option.key} value={option.key}>
										{`${option.label} (${bindingPath(kind, option.key)})`}
									</option>
								))}
							</select>
						)}
					</label>
				)}
				{problem ? (
					<p role="alert" className="text-chrome-danger m-0 text-[12px]">
						{problem}
					</p>
				) : null}
				<div className="flex items-center justify-end gap-2">
					<button type="button" onClick={onDone} className={`${BUTTON} text-chrome-text hover:bg-chrome-hover`}>
						{words.fixedText.cancel}
					</button>
					<button
						type="submit"
						className={`${BUTTON} bg-[#4f46e5] text-white hover:bg-[#4338ca]`}
						data-wc-bind-prop-submit=""
					>
						{said.button}
					</button>
				</div>
			</form>
		</dialog>
	);
}
