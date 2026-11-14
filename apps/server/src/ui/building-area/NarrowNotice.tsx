import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { Words } from "./api.ts";
import { FOCUS_RING } from "./controls.tsx";

/**
 * Below 1024 px the building area is covered by a notice (as Code mode and the Builder are, #126):
 * nothing under it can be reached or closes, and once the window is wide enough again focus goes back
 * where it was. Only the window's width counts; no device is detected.
 */
export function NarrowNotice({ covered, words, back }: { covered: boolean; words: Words; back: string }) {
	const notice = useRef<HTMLDivElement>(null);
	const returnTo = useRef<Element | null>(null);

	useEffect(() => {
		if (!covered) {
			const before = returnTo.current;
			returnTo.current = null;
			if (!(before instanceof HTMLElement) || !before.isConnected) return;
			before.focus();
			// Back in the page: the page's own focused element (a text region) takes it again.
			if (before instanceof HTMLIFrameElement) before.contentWindow?.focus();
			return;
		}
		returnTo.current = document.activeElement;
		const shown = notice.current;
		const coveredParts: Element[] = [];
		for (const part of shown?.parentElement?.children ?? []) {
			if (part === shown || part.hasAttribute("inert")) continue;
			part.setAttribute("inert", "");
			coveredParts.push(part);
		}
		shown?.focus();
		return () => {
			for (const part of coveredParts) part.removeAttribute("inert");
		};
	}, [covered]);

	if (!covered) return null;
	return (
		<div
			ref={notice}
			role="dialog"
			aria-modal="true"
			aria-labelledby="wc-narrow-title"
			aria-describedby="wc-narrow-text"
			tabIndex={-1}
			className="bg-chrome text-chrome-text fixed inset-0 z-[100] grid place-items-center p-6 outline-none"
			data-wc-narrow=""
		>
			<div className="grid max-w-md justify-items-center gap-3 text-center">
				<h2 id="wc-narrow-title" className="text-chrome-strong m-0 text-[18px] font-semibold">
					{words.narrow.title}
				</h2>
				<p id="wc-narrow-text" className="text-chrome-muted m-0 text-[13px]">
					{words.narrow.text}
				</p>
				<a
					href={back}
					className={`border-chrome-hover text-chrome-text hover:bg-chrome-hover flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium ${FOCUS_RING}`}
				>
					<ArrowLeftIcon aria-hidden="true" className="size-3.5 rtl:rotate-180" />
					{words.backToAdmin}
				</a>
			</div>
		</div>
	);
}
