import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../../controls.tsx";
import { PlaceIconButton } from "../content/ui.tsx";
import { type LoopResultRow, reasonText } from "./data.ts";
import { ColumnLabel, copyText, LoopBadge } from "./parts.tsx";
import { freshness, resultRows } from "./view.ts";

/**
 * The result column (`places-assets/08`, 320 wide): on how many pages the Loop shows, how many items
 * its Draft lists of how many in all and how long ago that was read, and each item as a tree of its
 * values. A click (or Enter) on a key copies the binding that reads it (`{{ item.title }}`) and says
 * so; the first item starts open.
 */
export function Result({
	words,
	loopId,
	result,
	failed,
	limit,
	onRead,
	announce,
}: {
	words: Words;
	loopId: string;
	result: { value: LoopResultRow; readAt: number } | null;
	failed: unknown;
	/** The query's limit, for "N of M"; null for a Loop of its own items. */
	limit: number | null;
	onRead(): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.loops;
	const id = useId();
	const [open, setOpen] = useState<ReadonlySet<number>>(new Set([0]));
	const [now, setNow] = useState(() => Date.now());

	// Another Loop: its first item open.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the Loop changes.
	useEffect(() => setOpen(new Set([0])), [loopId]);
	// "just now" turns into minutes as time goes by.
	useEffect(() => {
		const tick = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(tick);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new read is "just now".
	useEffect(() => setNow(Date.now()), [result?.readAt]);

	const value = result?.value ?? null;
	const pages = value?.pages ?? 0;
	const fresh = result ? freshness(result.readAt, now) : null;
	const count = value
		? limit !== null && value.total > value.items.length
			? fill(shown.countOf, { shown: String(value.items.length), total: String(value.total) })
			: value.total === 1
				? shown.countOne
				: fill(shown.countAll, { total: String(value.total) })
		: null;

	const copy = async (binding: string) => {
		if (await copyText(binding)) announce(fill(shown.copied, { binding }));
		else announce(shown.copyFailed, true);
	};

	return (
		<section
			aria-labelledby={`${id}-heading`}
			aria-describedby={`${id}-note`}
			className="flex min-h-0 w-[320px] shrink-0 flex-col gap-2.5 p-2"
			data-wc-loop-result=""
		>
			<div className="flex min-h-[26px] items-center gap-2">
				<ColumnLabel id={`${id}-heading`}>{shown.result}</ColumnLabel>
				{value ? (
					<LoopBadge>
						<span data-wc-loop-used-on={String(pages)}>
							{pages === 0
								? shown.usedOnNone
								: pages === 1
									? shown.usedOnOne
									: fill(shown.usedOn, { count: String(pages) })}
						</span>
					</LoopBadge>
				) : null}
			</div>
			<div className="flex items-center gap-2">
				<p role="status" className="text-chrome-muted m-0 grow text-[12px]" data-wc-loop-count="">
					{count && fresh
						? `${count} · ${fresh.kind === "justNow" ? shown.justNow : fill(shown.minutesAgo, { count: String(fresh.count) })}`
						: ""}
				</p>
				<PlaceIconButton icon={RefreshCwIcon} label={shown.readAgain} onClick={onRead} />
			</div>
			{failed && !value ? (
				<p role="alert" className="text-chrome-danger m-0 text-[12px]">
					{fill(shown.resultFailed, { reason: reasonText(words, failed) })}
				</p>
			) : null}
			{value && value.items.length === 0 ? <p className="text-chrome-muted m-0 text-[12px]">{shown.noItems}</p> : null}
			{value && value.items.length > 0 ? (
				<ul className="m-0 flex min-h-0 grow list-none flex-col gap-2.5 overflow-y-auto p-2.5" data-wc-loop-tree="">
					{value.items.map((item, index) => {
						const expanded = open.has(index);
						const listId = `${id}-item-${index}`;
						return (
							// Items are listed in order; their place is who they are.
							// biome-ignore lint/suspicious/noArrayIndexKey: the result is read again whole.
							<li key={index} className="flex flex-col gap-0.5">
								<button
									type="button"
									aria-expanded={expanded}
									aria-controls={listId}
									onClick={() =>
										setOpen((was) => {
											const next = new Set(was);
											if (next.has(index)) next.delete(index);
											else next.add(index);
											return next;
										})
									}
									className={`text-chrome-text hover:text-chrome-strong flex h-[22px] items-center gap-1.5 rounded-sm text-start text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
									data-wc-loop-item-toggle={String(index)}
								>
									{expanded ? (
										<ChevronDownIcon aria-hidden="true" className="text-chrome-muted size-3 shrink-0" />
									) : (
										<ChevronRightIcon aria-hidden="true" className="text-chrome-muted size-3 shrink-0" />
									)}
									{fill(shown.item, { index: String(index) })}
									<span className="sr-only">{item.label ? ` · ${item.label}` : ""}</span>
								</button>
								{expanded ? (
									<ul id={listId} className="m-0 flex list-none flex-col p-0 ps-[18px]">
										{resultRows(item.values).map((row) => (
											<li key={row.path} className="group relative">
												<button
													type="button"
													onClick={() => void copy(row.binding)}
													aria-label={`${shown.copyPath}: ${row.binding}`}
													className={`hover:bg-chrome-raised focus-visible:bg-chrome-raised flex h-[22px] w-full min-w-0 items-center gap-1.5 rounded-[4px] ps-2 pe-1 text-start font-mono text-[12px] ${CHROME_EASE} ${FOCUS_RING}`}
													data-wc-loop-key={row.path}
												>
													<span className="text-condition shrink-0">{row.path}</span>
													<span className="text-chrome-muted min-w-0 truncate">{row.shown}</span>
												</button>
												<Tip label={shown.copyPath} keys={row.binding} side="bottom" align="start" />
											</li>
										))}
									</ul>
								) : null}
							</li>
						);
					})}
				</ul>
			) : (
				<div className="grow" />
			)}
			<p id={`${id}-note`} className="text-chrome-muted m-0 text-[11px]">
				{shown.fromDrafts}
			</p>
		</section>
	);
}
