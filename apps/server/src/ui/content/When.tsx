import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/**
 * When something happened, as people say it: "Just now", "5 minutes ago", "2 hours ago",
 * "Yesterday", then the day ("28 Feb", with the year once it is not this year's), counted in UTC as
 * every admin date is (`ui/format.ts`). The exact time is its `title` and `dateTime`.
 */
export function When({ value, now }: { value: Date | string; now?: Date }) {
	const t = useT();
	const date = new Date(value);
	return (
		// The server renders first and the clock moves on before the page wakes: only the words may differ.
		<time dateTime={date.toISOString()} title={formatUtc(date)} suppressHydrationWarning>
			{whenWords(t, date, now ?? new Date())}
		</time>
	);
}

type Translate = ReturnType<typeof useT>;

/** The words `When` shows, for a place that needs them as text. */
export function whenWords(t: Translate, date: Date, now: Date): string {
	const ago = now.getTime() - date.getTime();
	if (ago < MINUTE) return t("content.when.now");
	if (ago < HOUR) return t("content.when.minutes", { count: Math.floor(ago / MINUTE) });
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	if (date.getTime() >= today) return t("content.when.hours", { count: Math.max(1, Math.floor(ago / HOUR)) });
	if (date.getTime() >= today - DAY) return t("content.when.yesterday");
	const month = t(`content.when.months.${MONTHS[date.getUTCMonth()] ?? "jan"}` as MessageKey);
	return date.getUTCFullYear() === now.getUTCFullYear()
		? t("content.when.day", { day: date.getUTCDate(), month })
		: t("content.when.dayYear", { day: date.getUTCDate(), month, year: date.getUTCFullYear() });
}
