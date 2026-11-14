import { FilePlusIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { CHROME_EASE } from "../../controls.tsx";
import { BARE_INPUT, Card, Locked } from "../content/post-types/controls.tsx";
import { buttonLook } from "../content/ui.tsx";
import { type FormsApi, reasonText } from "./data.ts";
import { STARTERS, type Starter, starterFields } from "./starters.ts";
import { keyFromName } from "./view.ts";

/** The look of each starter's picture: lines where its fields go, the button below (`forms-builder/06`). */
const PICTURE_LINES: Record<Starter, number> = { blank: 0, contact: 3, booking: 4, newsletter: 1, job: 4 };

/**
 * New Form (SPEC 15.2, `forms-builder/06`): its name, the key made from it (locked: Template markup
 * places the Form by it), and what it starts from: blank, or a starter's fields (Contact, Booking
 * request, Newsletter sign-up, Job application). Create makes the Form (`forms.create`), saves the
 * starter's fields as its first Draft (`forms.saveDraft`) and opens it on its Build tab. A modal
 * `<dialog>`: Escape and Cancel close it, and focus goes back to what opened it.
 */
export function NewFormDialog({
	words,
	api,
	siteId,
	onClose,
	onMade,
}: {
	words: Words;
	api: FormsApi;
	siteId: string;
	onClose(): void;
	onMade(formId: string, name: string): void;
}) {
	const shown = words.forms;
	const dialog = useRef<HTMLDialogElement>(null);
	const nameBox = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");
	const [starter, setStarter] = useState<Starter>("blank");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const title = useId();
	const nameId = useId();
	const startLabel = useId();

	useEffect(() => {
		const shownDialog = dialog.current;
		if (shownDialog && !shownDialog.open) shownDialog.showModal();
		nameBox.current?.focus();
		return () => shownDialog?.close();
	}, []);

	const close = () => {
		dialog.current?.close();
		onClose();
	};

	const key = keyFromName(name);
	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		if (name.trim() === "") {
			setProblem(shown.newForm.nameRequired);
			nameBox.current?.focus();
			return;
		}
		setBusy(true);
		setProblem(null);
		try {
			const { form } = await api.create({ siteId, name: name.trim() });
			const fields = starterFields(starter, words);
			if (fields.length > 0) await api.saveDraft({ siteId, formId: form.id, form: { fields } });
			dialog.current?.close();
			onMade(form.id, form.name);
		} catch (error) {
			setBusy(false);
			setProblem(reasonText(words, error));
			nameBox.current?.focus();
		}
	};

	return (
		<dialog
			ref={dialog}
			aria-labelledby={title}
			aria-busy={busy}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				close();
			}}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			className="bg-chrome-menu text-chrome-text border-chrome-hover m-auto w-[560px] max-w-[calc(100vw-32px)] rounded-[12px] border p-4 shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/60"
			data-wc-new-form=""
		>
			<form className="flex flex-col gap-2.5" onSubmit={(event) => void create(event)} noValidate>
				<h2 id={title} className="text-chrome-strong m-0 flex items-center gap-2 text-[14px] font-semibold">
					<FilePlusIcon aria-hidden="true" className="size-4 shrink-0" />
					{shown.newForm.title}
				</h2>
				<Card label={shown.newForm.name} htmlFor={nameId} problem={problem}>
					<input
						ref={nameBox}
						id={nameId}
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder={shown.newForm.namePlaceholder}
						maxLength={200}
						autoComplete="off"
						aria-invalid={problem ? true : undefined}
						className={BARE_INPUT}
						data-wc-new-form-name=""
					/>
				</Card>
				<Card label={shown.newForm.key}>
					<Locked value={key || shown.newForm.keyPending} why={shown.newForm.keyWhy} mono />
				</Card>
				<fieldset className="m-0 mt-1 flex flex-col gap-2 border-0 p-0">
					<legend
						id={startLabel}
						className="text-chrome-muted mb-2 p-0 text-[11px] font-semibold tracking-wide uppercase"
					>
						{shown.newForm.startFrom}
					</legend>
					<div className="grid grid-cols-5 gap-2">
						{STARTERS.map((each) => (
							<label
								key={each}
								className={`bg-chrome-raised has-[:focus-visible]:ring-chrome-focus flex cursor-pointer flex-col gap-2 rounded-[8px] p-2 has-[:focus-visible]:ring-2 ${
									starter === each ? "ring-selection ring-2" : "hover:bg-chrome-hover"
								} ${CHROME_EASE}`}
								data-wc-starter={each}
							>
								<input
									type="radio"
									name="starter"
									value={each}
									checked={starter === each}
									onChange={() => setStarter(each)}
									className="sr-only"
								/>
								<StarterPicture lines={PICTURE_LINES[each]} />
								<span className="text-chrome-strong text-[12px] leading-tight font-medium">{shown.starters[each]}</span>
							</label>
						))}
					</div>
				</fieldset>
				<div className="mt-2 flex justify-end gap-2">
					<button type="button" className={buttonLook("outline")} onClick={close}>
						{shown.newForm.cancel}
					</button>
					<button type="submit" className={buttonLook("primary")} disabled={busy} data-wc-new-form-create="">
						{busy ? shown.newForm.creating : shown.newForm.create}
					</button>
				</div>
				<p className="sr-only" aria-live="polite">
					{busy ? fill(shown.newForm.creatingNamed, { name }) : ""}
				</p>
			</form>
		</dialog>
	);
}

/** A starter's picture: the lines of its fields and a button, as the frame draws them. */
function StarterPicture({ lines }: { lines: number }) {
	return (
		<span
			aria-hidden="true"
			className={`bg-chrome flex h-11 flex-col justify-center gap-1 rounded-[5px] px-2 ${
				lines === 0 ? "border-chrome-hover border border-dashed" : ""
			}`}
		>
			{Array.from({ length: lines }, (_, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the lines of a picture never change.
				<span key={at} className="bg-chrome-hover block h-[3px] rounded-full" />
			))}
			{lines > 0 ? <span className="bg-selection block h-[5px] w-5 rounded-full" /> : null}
		</span>
	);
}
