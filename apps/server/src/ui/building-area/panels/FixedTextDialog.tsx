import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { keyFromLabel } from "../../content/field-drafts.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { bindingOf, excerpt, type FixedTextAsk, type FixedTexts } from "../editing/fixed-text.ts";

const BUTTON = `inline-flex h-8 shrink-0 items-center justify-center rounded-[7px] px-3 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`;
const BOX =
	"bg-chrome-well border-chrome-hover text-chrome-strong focus:ring-chrome-focus h-8 rounded-md border px-2 text-[12px] outline-none focus:ring-2";

/**
 * "Bind to Prop", "Make it a Field" or "Make it a Global" for a piece of fixed text (BA-33): a modal
 * `<dialog>` on the chrome. A new one is labelled (its key follows the label, and can be changed), or
 * one already there of text or rich text is chosen. The dialog stays open with the reason when it is
 * refused; Escape and Cancel leave everything as it was, and focus goes back where it was.
 */
export function FixedTextDialog({
	words,
	ask,
	texts,
	onDone,
}: {
	words: Words;
	ask: FixedTextAsk;
	texts: FixedTexts;
	onDone(): void;
}) {
	const said = words.fixedText;
	const target = ask.target;
	const dialog = useRef<HTMLDialogElement>(null);
	const labelField = useRef<HTMLInputElement>(null);
	const id = useId();
	const [mode, setMode] = useState<"new" | "existing">("new");
	const [label, setLabel] = useState("");
	const [key, setKey] = useState("");
	const [keyTyped, setKeyTyped] = useState(false);
	const [existing, setExisting] = useState("");
	const [options, setOptions] = useState<{ key: string; label: string }[] | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const opened = dialog.current;
		const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (opened && !opened.open) opened.showModal();
		labelField.current?.focus();
		return () => {
			opened?.close();
			if (back?.isConnected) back.focus();
		};
	}, []);

	const loadOptions = () => {
		if (options) return;
		void texts.existing(ask).then(setOptions, () => setOptions([]));
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		setBusy(true);
		const refused = await texts.make(
			ask,
			mode === "new" ? { mode, label, key: keyTyped ? key : keyFromLabel(label) } : { mode, key: existing },
		);
		setBusy(false);
		if (refused) {
			setProblem(refused);
			return;
		}
		onDone();
	};

	const shownKey = keyTyped ? key : keyFromLabel(label);
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
			data-wc-fixed-text-dialog={target}
		>
			<form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" noValidate>
				<h2 id={`${id}-title`} className="text-chrome-strong m-0 text-[14px] font-semibold">
					{said.make[target]}
				</h2>
				<p id={`${id}-text`} className="text-chrome-muted m-0 text-[13px]">
					{fill(said.intro[target], { text: excerpt(ask.location.text, 80) })}
				</p>
				<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
					<legend className="sr-only">{said.make[target]}</legend>
					{(["new", "existing"] as const).map((option) => (
						<label key={option} className="flex items-center gap-2 text-[12px]">
							<input
								type="radio"
								name={`${id}-mode`}
								checked={mode === option}
								onChange={() => {
									setMode(option);
									setProblem(null);
									if (option === "existing") loadOptions();
								}}
								className={`accent-[#6366f1] ${FOCUS_RING}`}
							/>
							{said.mode[option][target]}
						</label>
					))}
				</fieldset>
				{mode === "new" ? (
					<>
						<label className="flex flex-col gap-1.5 text-[12px] font-medium" htmlFor={`${id}-label`}>
							{said.label}
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
								data-wc-fixed-text-label=""
							/>
						</label>
						<label className="flex flex-col gap-1.5 text-[12px] font-medium" htmlFor={`${id}-key`}>
							{said.key}
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
							{fill(said.keyHelp, { binding: `{{ ${bindingOf(target, shownKey || "…")} }}` })}
						</p>
					</>
				) : (
					<label className="flex flex-col gap-1.5 text-[12px] font-medium" htmlFor={`${id}-existing`}>
						{said.existing[target]}
						{options && options.length === 0 ? (
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
								{(options ?? []).map((option) => (
									<option key={option.key} value={option.key}>
										{`${option.label} (${option.key})`}
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
						{said.cancel}
					</button>
					<button
						type="submit"
						disabled={busy}
						className={`${BUTTON} bg-[#4f46e5] text-white hover:bg-[#4338ca] disabled:opacity-60`}
						data-wc-fixed-text-submit=""
					>
						{said.make[target]}
					</button>
				</div>
			</form>
		</dialog>
	);
}
