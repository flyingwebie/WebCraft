import { InboxIcon, LockIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { fill, type Words } from "../api.ts";
import { formIdOf, formNameOf } from "../canvas/placed-form.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { Popover } from "./Popover.tsx";
import type { RegionPopovers } from "./popovers.ts";

/** Which locked Form's popover is open, and a count that changes each time one opens. */
type Open = { form: HTMLFormElement; seq: number } | null;

export type FormLocks = {
	open(form: HTMLFormElement): void;
	close(returnFocus: boolean): void;
	snapshot(): Open;
	subscribe(listener: () => void): () => void;
};

/** The locked Form whose popover is open in client editing (BA-27). */
export function formLocks(): FormLocks {
	let open: Open = null;
	let seq = 0;
	const listeners = new Set<() => void>();
	const tell = () => {
		for (const listener of listeners) listener();
	};
	return {
		open(form) {
			open = { form, seq: ++seq };
			tell();
		},
		close(returnFocus) {
			const was = open?.form;
			open = null;
			tell();
			if (returnFocus && was?.isConnected) was.focus({ preventScroll: true });
		},
		snapshot: () => open,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** A store of locked Forms, made once for a shell. */
export function useFormLocks(): FormLocks {
	return useMemo(() => formLocks(), []);
}

/**
 * A Form on the page in client editing (SPEC 15.3, `forms/05`): locked, since the agency built it. A
 * click on it, or Enter once it has focus, opens this popover: its name and lock, what that means,
 * and "See what people sent", its Submissions in the admin (a new tab).
 */
export function FormLockPopover({
	locks,
	popovers,
	words,
	admin,
}: {
	locks: FormLocks;
	/** Where the page's elements are on the shell's window, and when they move (the photo popovers'). */
	popovers: RegionPopovers;
	words: Words;
	admin: string;
}) {
	const open = useSyncExternalStore(locks.subscribe, locks.snapshot);
	const [, setMoved] = useState(0);
	useEffect(() => popovers.onMove(() => setMoved((count) => count + 1)), [popovers]);
	if (!open?.form.isConnected) return null;
	const box = popovers.boxOf(open.form);
	const formId = formIdOf(open.form);
	if (!box || !formId) return null;
	const shown = words.forms.onPage;
	const name = formNameOf(formId) ?? shown.unnamed;
	return (
		<Popover
			kind="form"
			icon={LockIcon}
			title={fill(shown.lockedTitle, { name })}
			closeLabel={shown.close}
			box={box}
			where="below"
			focus={null}
			seq={open.seq}
			hidden={false}
			onClose={(returnFocus) => locks.close(returnFocus)}
		>
			<p className="text-chrome-muted m-0 text-[12px]">{shown.lockedText}</p>
			<a
				href={`${admin}/forms/${formId}?tab=submissions`}
				target="_blank"
				rel="noopener noreferrer"
				data-wc-autofocus=""
				className={`bg-chrome-raised text-chrome-strong hover:bg-chrome-hover flex h-8 items-center gap-1.5 self-start rounded-[7px] px-2.5 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-see-sent=""
			>
				<InboxIcon aria-hidden="true" className="size-3.5" />
				{shown.seeSent}
			</a>
		</Popover>
	);
}
