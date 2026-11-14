import { cn } from "@webcraft/ui/lib/utils.ts";
import type { ComponentProps } from "react";

/**
 * Pieces the Measure screens (Goals, Funnels) and a Dashboard's Reports share: the list table of the
 * admin's frames (a rounded frame, a grey head 40 high, rows 52 high) and the days "the last 30 days"
 * covers.
 */

/** The rounded frame around a list table. */
export function TableFrame({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("bg-background overflow-hidden rounded-[10px] border", className)} {...props} />;
}

/** The table's head row: grey, without the hover of a body row. */
export const headRowClass = "bg-muted hover:bg-muted";
/** A head cell: small grey words. */
export const headClass = "text-muted-foreground h-10 px-4 text-[13px] font-medium";
/** A body cell: a row is 52 high. */
export const cellClass = "h-13 px-4";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The days "the last 30 days" covers at `now`, as a Dashboard counts its default range: the 30 whole
 * days that end with today, in UTC.
 */
export function lastThirtyDays(now = new Date()): { from: Date; to: Date } {
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return { from: new Date(today - 29 * DAY_MS), to: new Date(today + DAY_MS) };
}
