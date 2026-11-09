import { Input } from "@webcraft/ui/components/input.tsx";
import { LoaderIcon, LockIcon, RadioIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { changeOf, type FilterProblem, type FilterVersion, problemsOf } from "./model.ts";
import { Segmented } from "./Segmented.tsx";

/** Where the canvas document is on the admin host: an empty page that runs no script (the visual builder's). */
const CANVAS_URL = "/api/builder/canvas";

/** How wide the preview shows the page: a desktop's width, scaled to fit, or a phone's. */
const WIDTHS = { desktop: 1280, phone: 390 } as const;

export type Previewed = Awaited<ReturnType<Awaited<ReturnType<typeof getApi>>["filters"]["preview"]>>;

/**
 * The live preview: the Filter's Draft as it is being changed, rendered by the Site's own renderer
 * where the Filter is placed, with its Loop's published Entries and real counts (`filters.preview`),
 * in the canvas frame the visual builder uses (on the admin host, sandboxed, its page's policy
 * allowing no script), styled by the Site's Design system. The admin writes what the server rendered
 * into it; the Filter's own script never runs there. Its address shows the choices previewed: typed
 * there, or made with the pointer in the frame (ticking an option, a chip, a preset). The frame is
 * out of the tab order; the address is how the keyboard sets choices. The selected control is
 * outlined.
 */
export function Preview({
	siteId,
	filterId,
	filterName,
	version,
	selected,
	onSelect,
	onShown,
	languages,
}: {
	siteId: string;
	filterId: string;
	filterName: string;
	version: FilterVersion;
	/** The selected control's place in the version, outlined in the frame. */
	selected: number;
	onSelect(index: number): void;
	/** Hears each preview shown (where phones end, from the Design system). */
	onShown?(previewed: Previewed): void;
	languages: { default: string; all: readonly string[] };
}) {
	const t = useT();
	const frame = useRef<HTMLIFrameElement>(null);
	const holder = useRef<HTMLDivElement>(null);
	const [ready, setReady] = useState(false);
	const [query, setQuery] = useState("");
	const [language, setLanguage] = useState(languages.default);
	const [width, setWidth] = useState<keyof typeof WIDTHS>("desktop");
	const [shown, setShown] = useState<Previewed | null>(null);
	const [problems, setProblems] = useState<FilterProblem[]>([]);
	const [failed, setFailed] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [address, setAddress] = useState("");
	const [scale, setScale] = useState(1);
	const callbacks = useRef({ setQuery, onSelect, onShown, t });
	callbacks.current = { setQuery, onSelect, onShown, t };

	// The canvas page loads once; it may have loaded before the preview was ready to hear it.
	useEffect(() => {
		const document = frame.current?.contentDocument;
		if (document?.readyState === "complete" && document.URL.endsWith(CANVAS_URL)) setReady(true);
	}, []);

	// The Draft as it is now, previewed a moment after it stops changing.
	const change = JSON.stringify(changeOf(version));
	useEffect(() => {
		let current = true;
		const timer = setTimeout(async () => {
			setBusy(true);
			try {
				const api = await getApi();
				const previewed = await api.filters.preview({
					siteId,
					filterId,
					...(JSON.parse(change) as ReturnType<typeof changeOf>),
					query,
					language,
				});
				if (!current) return;
				setShown(previewed);
				setAddress(previewed.url);
				callbacks.current.onShown?.(previewed);
				setProblems([]);
				setFailed(null);
			} catch (error) {
				if (!current) return;
				const found = problemsOf(error);
				setProblems(found);
				setFailed(found.length > 0 ? null : callbacks.current.t(errorMessage(error)));
			} finally {
				if (current) setBusy(false);
			}
		}, 250);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [siteId, filterId, change, query, language]);

	// What the server rendered, written into the frame with the Site's stylesheet.
	useEffect(() => {
		const iframe = frame.current;
		const document = iframe?.contentDocument;
		const view = iframe?.contentWindow as (Window & typeof globalThis) | null | undefined;
		if (!ready || !document || !view || !shown) return;
		const root = document.documentElement;
		root.lang = shown.language.code;
		root.dir = shown.language.direction;
		const sheet = new view.CSSStyleSheet();
		const outline = `#wc-filter-${filterName}-${selected + 1}-control{outline:3px solid #ea580c;outline-offset:6px;border-radius:2px}`;
		sheet.replaceSync(`${shown.css}\n${outline}\n*{cursor:default}input,select,label,a,summary,button{cursor:pointer}`);
		document.adoptedStyleSheets = [sheet];
		document.body.innerHTML = shown.html;
		// Nothing in the frame is a tab stop: the address sets the choices from the keyboard.
		for (const element of document.body.querySelectorAll<HTMLElement>(
			"a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]",
		)) {
			element.tabIndex = -1;
		}
		const height = Math.max(document.documentElement.scrollHeight, 480);
		iframe.style.height = `${height}px`;
		const box = holder.current;
		if (box) box.style.height = `${Math.ceil(height * scale)}px`;
	}, [ready, shown, selected, filterName, scale]);

	// The frame keeps a desktop's or a phone's width, scaled down to fit the panel.
	useEffect(() => {
		const box = holder.current;
		const iframe = frame.current;
		if (!box || !iframe) return;
		const fit = () => {
			const wanted = WIDTHS[width];
			const next = Math.min(1, box.clientWidth / wanted);
			iframe.style.width = `${wanted}px`;
			iframe.style.transform = `scale(${next})`;
			setScale(next);
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(box);
		return () => observer.disconnect();
	}, [width]);

	// Choices made with the pointer in the frame: an option ticked, the form sent, a chip or preset followed.
	useEffect(() => {
		const document = frame.current?.contentDocument;
		if (!ready || !document) return;
		const fromForm = (form: HTMLFormElement | null | undefined) => {
			if (!form) return;
			const fields = new URLSearchParams();
			for (const [name, value] of new FormData(form)) if (typeof value === "string") fields.append(name, value);
			callbacks.current.setQuery(fields.toString());
		};
		const onChange = (event: Event) => {
			const field = event.target as HTMLInputElement;
			fromForm(field.form);
		};
		const onSubmit = (event: Event) => {
			event.preventDefault();
			fromForm(event.target as HTMLFormElement);
		};
		const onClick = (event: MouseEvent) => {
			const target = event.target as Element;
			const control = target.closest?.("[data-wc-control]");
			const at = /-(\d+)-control$/.exec(control?.id ?? "");
			if (at) callbacks.current.onSelect(Number(at[1]) - 1);
			const link = target.closest?.("a[href]");
			if (!link) return;
			event.preventDefault();
			const url = new URL(link.getAttribute("href") ?? "", "https://preview.invalid");
			callbacks.current.setQuery(url.search.slice(1));
		};
		document.addEventListener("change", onChange);
		document.addEventListener("submit", onSubmit);
		document.addEventListener("click", onClick);
		return () => {
			document.removeEventListener("change", onChange);
			document.removeEventListener("submit", onSubmit);
			document.removeEventListener("click", onClick);
		};
	}, [ready]);

	const go = (event: FormEvent) => {
		event.preventDefault();
		const url = new URL(address.trim() || "/", "https://preview.invalid");
		setQuery(url.search.slice(1));
	};

	return (
		<section aria-labelledby="filter-preview-heading" className="grid min-w-0 content-start gap-3" aria-busy={busy}>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<RadioIcon className="size-4 text-emerald-600" aria-hidden="true" />
					<h2 id="filter-preview-heading" className="text-sm font-semibold">
						{t("filters.preview.heading")}
					</h2>
					<p className="text-muted-foreground truncate text-xs">
						{shown ? t("filters.preview.realCounts", { count: shown.count }) : t("filters.preview.loading")}
					</p>
					{busy ? <LoaderIcon className="text-muted-foreground size-3 animate-spin" aria-hidden="true" /> : null}
				</div>
				<div className="flex flex-wrap gap-2">
					{languages.all.length > 1 ? (
						<Segmented
							label={t("filters.preview.language")}
							size="sm"
							value={language}
							onChange={setLanguage}
							options={languages.all.map((code) => ({ value: code, label: code.toUpperCase() }))}
						/>
					) : null}
					<Segmented<keyof typeof WIDTHS>
						label={t("filters.preview.width")}
						size="sm"
						value={width}
						onChange={setWidth}
						options={[
							{ value: "desktop", label: t("filters.preview.desktop") },
							{ value: "phone", label: t("filters.preview.phone") },
						]}
					/>
				</div>
			</div>
			<form onSubmit={go} className="flex items-center gap-2">
				<label htmlFor="filter-preview-address" className="sr-only">
					{t("filters.preview.address")}
				</label>
				<LockIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				<Input
					id="filter-preview-address"
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					className="font-mono text-xs"
					spellCheck={false}
					autoComplete="off"
					aria-describedby="filter-preview-address-help"
				/>
			</form>
			<p id="filter-preview-address-help" className="text-muted-foreground text-xs">
				{t("filters.preview.addressHelp")}
			</p>
			{problems.length > 0 || failed ? (
				<div className="border-destructive/50 rounded-md border p-3 text-sm" role="status">
					<p className="font-medium">{failed ?? t("filters.preview.waiting")}</p>
					{problems.length > 0 ? (
						<ul className="mt-2 list-disc ps-5">
							{problems.map((problem) => (
								<li key={`${problem.at}-${problem.message}`}>
									<span className="font-mono">{problem.at}</span>: {problem.message}
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
			<div ref={holder} className="bg-muted/40 relative overflow-hidden rounded-md border">
				<iframe
					ref={frame}
					src={CANVAS_URL}
					title={t("filters.preview.frame", { name: filterName })}
					sandbox="allow-same-origin"
					tabIndex={-1}
					onLoad={() => setReady(true)}
					className="bg-background absolute start-0 top-0 origin-top-left border-0 rtl:origin-top-right"
				/>
			</div>
		</section>
	);
}
