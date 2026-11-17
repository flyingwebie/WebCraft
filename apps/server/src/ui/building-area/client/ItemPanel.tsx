import { ChevronLeftIcon, ChevronRightIcon, ImageIcon, ListIcon, XIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { type EditRequests, fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { pickMedia } from "../places/media/pick.ts";
import type { ItemField, ItemForm, LoopItems, SelectedItem } from "./loop-items.ts";
import { INPUT } from "./Popover.tsx";

/** How long after typing stops a value is saved (as text typed in place). */
const SAVE_AFTER_MS = 800;

/** The rich text a Field may hold (the server keeps the same when it cleans a save). */
const RICH_TAGS = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "CODE", "SUB", "SUP", "A", "UL", "OL", "LI"]);

type Problems = Record<string, string>;

/**
 * The selected Loop item's side panel (SPEC 13.3, BA-16; `client/05`): "a set of values opens the side
 * panel". 360 wide on the right, pushing the page, one at a time with client editing's other panels.
 * Its header names the item ("Cardamom bun", "Our bakes · item 2 of 4") with the previous and next
 * items and Close; its body has every Field of the item, each saved as it changes (`loop/save`, typed
 * values 0.8 s after typing stops), its problems under it; its foot "Remove this item" and Done.
 * Escape, Close and Done put it away and give focus back to the item on the page.
 */
export function ItemPanel({
	id,
	items,
	words,
	selected,
	request,
	languages,
}: {
	id: string;
	items: LoopItems;
	words: Words;
	selected: SelectedItem;
	request: EditRequests;
	/** How many languages the Site has: a translatable Field's label then says which one it is written in. */
	languages: number;
}) {
	const said = words.client.items;
	const heading = useRef<HTMLHeadingElement>(null);
	const [name, setName] = useState<string | null>(null);
	// Focus goes into the panel as it opens: its heading, so the panel is read from the top.
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, []);
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- another item's name comes with its form.
	useEffect(() => setName(null), [selected.key]);
	const shownName = name || selected.name;
	const close = () => items.closePanel({ deselect: true, focusItem: true });
	const first = selected.index === 0;
	const last = selected.index === selected.count - 1;
	const stepButton = `bg-chrome-raised text-chrome-text hover:bg-chrome-hover grid size-7 shrink-0 place-items-center rounded-[7px] aria-disabled:opacity-35 ${CHROME_EASE} ${FOCUS_RING}`;
	return (
		<aside
			id={id}
			aria-labelledby={`${id}-title`}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				close();
			}}
			className="border-chrome-line bg-chrome col-start-2 row-start-1 flex min-h-0 w-[360px] flex-col border-s"
			data-building-region="right"
			data-wc-side-panel="item"
			data-wc-item-panel={selected.key}
		>
			<header className="flex h-[60px] shrink-0 items-center gap-2.5 px-4">
				<ListIcon aria-hidden="true" className="text-chrome-text size-[18px] shrink-0" />
				<div className="flex min-w-0 grow flex-col">
					<h2
						ref={heading}
						id={`${id}-title`}
						tabIndex={-1}
						className="text-chrome-strong m-0 truncate text-[15px] font-semibold outline-none"
						data-wc-item-panel-name=""
					>
						{shownName}
					</h2>
					<p className="text-chrome-muted m-0 truncate text-[12px]" data-wc-item-panel-position="">
						{selected.position}
					</p>
				</div>
				<button
					type="button"
					aria-label={said.panel.previous}
					title={said.panel.previous}
					aria-disabled={first ? true : undefined}
					onClick={() => {
						if (!first) items.step(-1);
					}}
					className={stepButton}
					data-wc-item-step="previous"
				>
					<ChevronLeftIcon aria-hidden="true" className="size-3.5 rtl:rotate-180" />
				</button>
				<button
					type="button"
					aria-label={said.panel.next}
					title={said.panel.next}
					aria-disabled={last ? true : undefined}
					onClick={() => {
						if (!last) items.step(1);
					}}
					className={stepButton}
					data-wc-item-step="next"
				>
					<ChevronRightIcon aria-hidden="true" className="size-3.5 rtl:rotate-180" />
				</button>
				<button
					type="button"
					aria-label={fill(said.panel.close, { name: shownName })}
					title={fill(said.panel.close, { name: shownName })}
					onClick={close}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-8 shrink-0 place-items-center rounded-lg ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-side-panel-close=""
				>
					<XIcon aria-hidden="true" className="size-4" />
				</button>
			</header>
			<div className="min-h-0 grow overflow-y-auto px-4 pb-4 text-[14px]">
				<ItemFields
					key={selected.key}
					itemKey={selected.key}
					items={items}
					words={words}
					request={request}
					languages={languages}
					onName={setName}
				/>
			</div>
			<footer className="border-chrome-line flex h-[68px] shrink-0 items-center gap-2 border-t px-4">
				<button
					type="button"
					onClick={() => void items.remove(selected.key)}
					className={`inline-flex h-10 items-center rounded-[9px] border border-[#7f1d1d] bg-[#3b1212] px-3.5 text-[13px] font-semibold text-[#fca5a5] hover:bg-[#4c1717] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-item-remove=""
				>
					{said.panel.removeThis}
				</button>
				<span className="grow" />
				<button
					type="button"
					onClick={close}
					className={`bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center rounded-[9px] px-3.5 text-[13px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-item-done=""
				>
					{said.panel.done}
				</button>
			</footer>
		</aside>
	);
}

/** Sets a value at a path (`address.city`) as the item's values hold it. */
function nested(path: string, value: unknown): Record<string, unknown> {
	return path.split(".").reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;
}

/** The item's name: its first text Field's value. */
function firstText(fields: readonly ItemField[], values: Record<string, unknown>): string | null {
	const field = fields.find((each) => each.type === "text");
	const value = field ? values[field.key] : null;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The item's Fields and values (`loop/get`), each saved as it changes. Pending typed values are saved
 * at once when the panel shows another item or goes away.
 */
function ItemFields({
	itemKey,
	items,
	words,
	request,
	languages,
	onName,
}: {
	itemKey: string;
	items: LoopItems;
	words: Words;
	request: EditRequests;
	languages: number;
	onName(name: string | null): void;
}) {
	const said = words.client.items.panel;
	const [form, setForm] = useState<{ ok: true; data: ItemForm } | { ok: false; reason: string } | null>(null);
	const [problems, setProblems] = useState<Problems>({});
	const values = useRef<Record<string, unknown>>({});
	const pending = useRef(new Map<string, { timer: number; value: unknown }>());

	useEffect(() => {
		let current = true;
		void items.load(itemKey).then((answer) => {
			if (!current) return;
			if (!answer.ok) {
				setForm({ ok: false, reason: answer.code });
				return;
			}
			values.current = { ...answer.data.item };
			setForm({ ok: true, data: answer.data });
			onName(firstText(answer.data.fields, values.current));
		});
		return () => {
			current = false;
		};
	}, [items, itemKey, onName]);

	const save = useCallback(
		async (path: string, value: unknown) => {
			const answer = await items.save(itemKey, nested(path, value));
			if (!answer.ok) return;
			const found: Problems = {};
			for (const problem of answer.data.problems) {
				const at = problem.at.replace(/^items\[\d+\]\./, "");
				found[at] =
					(words.editing.problems as Record<string, string>)[problem.rule ?? "other"] ?? words.editing.problems.other;
			}
			setProblems(found);
		},
		[items, itemKey, words],
	);

	/** A change to a value: saved after `wait` (typing), or at once. */
	const change = useCallback(
		(path: string, value: unknown, wait = SAVE_AFTER_MS) => {
			const [top = path] = path.split(".");
			if (path === top) values.current = { ...values.current, [top]: value };
			if (form?.ok) onName(firstText(form.data.fields, values.current));
			const was = pending.current.get(path);
			if (was) window.clearTimeout(was.timer);
			if (wait === 0) {
				pending.current.delete(path);
				void save(path, value);
				return;
			}
			pending.current.set(path, {
				value,
				timer: window.setTimeout(() => {
					pending.current.delete(path);
					void save(path, value);
				}, wait),
			});
		},
		[form, onName, save],
	);

	// What was typed and not saved yet is saved as the panel shows another item or goes away.
	useEffect(() => {
		const waiting = pending.current;
		return () => {
			for (const [path, { timer, value }] of waiting) {
				window.clearTimeout(timer);
				void items.save(itemKey, nested(path, value));
			}
			waiting.clear();
		};
	}, [items, itemKey]);

	if (!form) {
		return (
			<p className="text-chrome-muted m-0 text-[13px]" role="status">
				{said.loading}
			</p>
		);
	}
	if (!form.ok) {
		return (
			<p className="text-chrome-danger m-0 text-[13px]" role="alert">
				{fill(said.loadFailed, { reason: form.reason })}
			</p>
		);
	}
	const language = items.language();
	return (
		<div className="flex flex-col gap-4" data-wc-item-fields="">
			{form.data.fields.map((field) => (
				<FieldControl
					key={field.key}
					field={field}
					path={field.key}
					value={form.data.item[field.key]}
					words={words}
					request={request}
					language={languages > 1 ? (language?.name ?? null) : null}
					problems={problems}
					change={change}
				/>
			))}
		</div>
	);
}

type ControlProps = {
	field: ItemField;
	path: string;
	value: unknown;
	words: Words;
	request: EditRequests;
	/** The page's language's name, when the Site has more than one. */
	language: string | null;
	problems: Problems;
	change(path: string, value: unknown, wait?: number): void;
};

/** One Field of the item, by its type; what the panel can't change here is changed in the admin. */
function FieldControl(props: ControlProps) {
	const { field, path, value, words, language, problems, change } = props;
	const said = words.client.items.panel;
	const id = useId();
	const problemId = `${id}-problem`;
	const problem = problems[path] ?? null;
	const label = language && field.translatable ? fill(said.inLanguage, { field: field.label, language }) : field.label;
	const invalid = problem ? { "aria-invalid": true as const, "aria-describedby": problemId } : {};
	const note = problem ? (
		<p id={problemId} className="text-chrome-danger m-0 text-[12px]" data-wc-item-problem={path}>
			{problem}
		</p>
	) : null;

	switch (field.type) {
		case "text":
		case "email":
		case "number":
		case "date": {
			const type =
				field.type === "number"
					? "number"
					: field.type === "email"
						? "email"
						: field.type === "date"
							? field.mode === "time"
								? "time"
								: field.mode === "dateTime"
									? "datetime-local"
									: "date"
							: "text";
			const shown =
				value === null || value === undefined
					? ""
					: field.type === "date" && field.mode === "dateTime"
						? String(value).slice(0, 16)
						: String(value);
			return (
				<Labelled label={label} htmlFor={id}>
					<input
						id={id}
						type={type}
						defaultValue={shown}
						autoComplete="off"
						className={`${INPUT} h-10`}
						data-wc-item-field={path}
						onChange={(event) => {
							const text = event.currentTarget.value;
							const read =
								text === ""
									? null
									: field.type === "number"
										? Number(text)
										: field.type === "date" && field.mode === "dateTime"
											? `${text}:00Z`
											: text;
							change(path, read);
						}}
						{...invalid}
					/>
					{note}
				</Labelled>
			);
		}
		case "richText":
			return (
				<RichText
					id={id}
					label={label}
					path={path}
					value={typeof value === "string" ? value : ""}
					change={change}
					invalid={invalid}
					note={note}
				/>
			);
		case "boolean":
			return (
				<div className="flex w-full flex-col gap-1.5">
					<div className="flex w-full items-center gap-3">
						<span id={`${id}-label`} className="text-chrome-strong flex-1 text-[13px] font-medium">
							{label}
						</span>
						<Switch labelledBy={`${id}-label`} on={value === true} path={path} onChange={(on) => change(path, on, 0)} />
					</div>
					{note}
				</div>
			);
		case "select": {
			const chosen = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
			return (
				<Labelled label={label} htmlFor={id}>
					<select
						id={id}
						multiple={field.multiple === true}
						defaultValue={field.multiple ? chosen : (chosen[0] ?? "")}
						className={`${INPUT} ${field.multiple ? "py-2" : "h-10"}`}
						data-wc-item-field={path}
						onChange={(event) => {
							const picked = [...event.currentTarget.selectedOptions].map((option) => option.value).filter(Boolean);
							change(path, field.multiple ? picked : (picked[0] ?? null), 0);
						}}
						{...invalid}
					>
						{field.multiple ? null : <option value="">{said.noChoice}</option>}
						{(field.options ?? []).map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					{note}
				</Labelled>
			);
		}
		case "media":
			return <MediaField {...props} id={id} label={label} note={note} />;
		case "link": {
			const link = (value ?? {}) as { url?: string | null; text?: string | null; newTab?: boolean };
			return (
				<LinkField id={id} label={field.label} path={path} link={link} words={words} change={change} note={note} />
			);
		}
		case "group": {
			const inner = (value ?? {}) as Record<string, unknown>;
			return (
				<fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
					<legend className="text-chrome-strong mb-2 p-0 text-[13px] font-semibold">{field.label}</legend>
					{(field.fields ?? []).map((each) => (
						<FieldControl key={each.key} {...props} field={each} path={`${path}.${each.key}`} value={inner[each.key]} />
					))}
				</fieldset>
			);
		}
		default:
			return (
				<div className="flex w-full flex-col gap-1">
					<span className="text-chrome-strong text-[13px] font-medium">{label}</span>
					<p className="text-chrome-muted m-0 text-[12px]">{said.inAdmin}</p>
				</div>
			);
	}
}

function Labelled({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
	return (
		<div className="flex w-full flex-col gap-1.5">
			<label htmlFor={htmlFor} className="text-chrome-strong text-[13px] font-medium">
				{label}
			</label>
			{children}
		</div>
	);
}

function Switch({
	labelledBy,
	on: initial,
	path,
	onChange,
}: {
	labelledBy: string;
	on: boolean;
	path: string;
	onChange(on: boolean): void;
}) {
	const [on, setOn] = useState(initial);
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-labelledby={labelledBy}
			onClick={() => {
				setOn(!on);
				onChange(!on);
			}}
			className={`flex h-6 w-10 shrink-0 items-center rounded-full px-[3px] ${
				on ? "bg-chrome-ok justify-end" : "justify-start bg-[#3f3f46]"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			data-wc-item-field={path}
		>
			<span aria-hidden="true" className={`size-[18px] rounded-full ${on ? "bg-[#052e16]" : "bg-[#e4e4e7]"}`} />
		</button>
	);
}

/**
 * Rich text, written in a box that takes formatting (as the page's own rich text regions do). What it
 * shows of the stored value is read element by element: only the formatting a rich text Field keeps.
 */
function RichText({
	id,
	label,
	path,
	value,
	change,
	invalid,
	note,
}: {
	id: string;
	label: string;
	path: string;
	value: string;
	change(path: string, value: unknown, wait?: number): void;
	invalid: Record<string, unknown>;
	note: ReactNode;
}) {
	const box = useRef<HTMLDivElement>(null);
	// Shown once: what is typed afterwards is the person's.
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- the stored value is read once, as the form opens.
	useEffect(() => {
		const element = box.current;
		if (!element) return;
		element.replaceChildren(...richNodes(value, element.ownerDocument));
	}, []);
	return (
		<div className="flex w-full flex-col gap-1.5">
			<span id={`${id}-label`} className="text-chrome-strong text-[13px] font-medium">
				{label}
			</span>
			{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a box that takes formatting is a textbox, not an input.*/}
			<div
				ref={box}
				id={id}
				role="textbox"
				tabIndex={0}
				aria-multiline="true"
				aria-labelledby={`${id}-label`}
				contentEditable
				suppressContentEditableWarning
				onInput={(event) => change(path, event.currentTarget.innerHTML)}
				className={`${INPUT} min-h-20 py-2.5 [&_ol]:ps-5 [&_p]:m-0 [&_ul]:ps-5`}
				data-wc-item-field={path}
				{...invalid}
			/>
			{note}
		</div>
	);
}

/** The stored rich text as nodes of `owner`: the kept tags with their words, links only to safe addresses. */
function richNodes(html: string, owner: Document): Node[] {
	const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
	const copy = (node: Node): Node[] => {
		if (node.nodeType === Node.TEXT_NODE) return [owner.createTextNode(node.textContent ?? "")];
		if (node.nodeType !== Node.ELEMENT_NODE) return [];
		const element = node as Element;
		const children = [...element.childNodes].flatMap(copy);
		if (!RICH_TAGS.has(element.tagName)) return children;
		const made = owner.createElement(element.tagName.toLowerCase());
		const href = element.tagName === "A" ? element.getAttribute("href") : null;
		if (href && /^(https?:|mailto:|tel:|\/|#)/i.test(href.trim())) made.setAttribute("href", href);
		made.append(...children);
		return [made];
	};
	return [...parsed.childNodes].flatMap(copy);
}

/** A photo: its thumbnail, Change (the Media picker) and Remove photo. */
function MediaField({
	id,
	label,
	path,
	value,
	words,
	request,
	change,
	note,
}: ControlProps & { id: string; label: string; note: ReactNode }) {
	const said = words.client.items.panel;
	const [media, setMedia] = useState<string | null>(typeof value === "string" ? value : null);
	const [thumbnail, setThumbnail] = useState<string | null>(null);
	useEffect(() => {
		setThumbnail(null);
		if (!media) return;
		let current = true;
		void request<{ media: { thumbnail: string | null; url: string | null } }>("media/get", { media }).then((answer) => {
			if (current && answer.ok) setThumbnail(answer.data.media.thumbnail ?? answer.data.media.url);
		});
		return () => {
			current = false;
		};
	}, [media, request]);
	const choose = async () => {
		const picked = await pickMedia({ kind: "image", current: media });
		if (!picked) return;
		setMedia(picked.id);
		change(path, picked.id, 0);
	};
	const button = `inline-flex h-10 items-center rounded-[9px] border border-[#3f3f46] px-3.5 text-[13px] font-semibold text-chrome-text hover:bg-chrome-hover ${CHROME_EASE} ${FOCUS_RING}`;
	return (
		<div className="flex w-full flex-col gap-1.5">
			<span id={`${id}-label`} className="text-chrome-strong text-[13px] font-medium">
				{label}
			</span>
			<div className="flex items-center gap-2.5">
				<span className="bg-chrome-raised grid size-14 shrink-0 place-items-center overflow-hidden rounded-[10px]">
					{thumbnail ? (
						<img src={thumbnail} alt="" className="size-full object-cover" data-wc-item-thumbnail="" />
					) : (
						<ImageIcon aria-hidden="true" className="text-chrome-faint size-5" />
					)}
				</span>
				<button
					id={`${id}-choose`}
					type="button"
					aria-labelledby={`${id}-choose ${id}-label`}
					onClick={() => void choose()}
					className={button}
					data-wc-item-field={path}
				>
					{media ? said.change : said.choose}
				</button>
				{media ? (
					<button
						type="button"
						onClick={() => {
							setMedia(null);
							change(path, null, 0);
						}}
						className={`text-chrome-muted hover:text-chrome-strong rounded-md px-1 text-[12px] font-semibold hover:underline ${FOCUS_RING}`}
					>
						{said.removePhoto}
					</button>
				) : (
					<span className="text-chrome-muted text-[12px]">{said.noPhoto}</span>
				)}
			</div>
			{note}
		</div>
	);
}

/** A link: where it goes and its words, saved together. */
function LinkField({
	id,
	label,
	path,
	link,
	words,
	change,
	note,
}: {
	id: string;
	label: string;
	path: string;
	link: { url?: string | null; text?: string | null; newTab?: boolean };
	words: Words;
	change(path: string, value: unknown, wait?: number): void;
	note: ReactNode;
}) {
	const said = words.client.items.panel;
	const now = useRef({ url: link.url ?? "", text: link.text ?? "" });
	const changed = () => {
		const { url, text } = now.current;
		change(path, url || text ? { url, text, ...(link.newTab ? { newTab: true } : {}) } : null);
	};
	return (
		<div className="flex w-full flex-col gap-3">
			<Labelled label={fill(said.address, { field: label })} htmlFor={`${id}-url`}>
				<input
					id={`${id}-url`}
					type="text"
					defaultValue={now.current.url}
					autoComplete="off"
					className={`${INPUT} h-10`}
					data-wc-item-field={`${path}.url`}
					onChange={(event) => {
						now.current = { ...now.current, url: event.currentTarget.value };
						changed();
					}}
				/>
			</Labelled>
			<Labelled label={fill(said.words, { field: label })} htmlFor={`${id}-text`}>
				<input
					id={`${id}-text`}
					type="text"
					defaultValue={now.current.text}
					autoComplete="off"
					className={`${INPUT} h-10`}
					data-wc-item-field={`${path}.text`}
					onChange={(event) => {
						now.current = { ...now.current, text: event.currentTarget.value };
						changed();
					}}
				/>
			</Labelled>
			{note}
		</div>
	);
}
