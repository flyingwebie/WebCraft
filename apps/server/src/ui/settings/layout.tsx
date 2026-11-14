import { cn } from "@webcraft/ui/lib/utils.ts";
import { type ComponentProps, type ReactNode, useId } from "react";

/**
 * The pieces a settings screen is drawn with (frame 02): cards with a title and one line, rows inside
 * them with hairlines between, a switch, and a badge that says a thing's state in words. The state of
 * what the screen edits and its foot bar are in `form.tsx`.
 */

/**
 * A card of a settings screen: its title, one line about it, an action at its end (such as "Add
 * domain"), then its rows or fields. Rows (`SettingsRow`, `SettingsListRow`) get a hairline between
 * them; put fields over the full width straight inside.
 */
export function SettingsCard({
	title,
	description,
	action,
	children,
	className,
	...props
}: Omit<ComponentProps<"section">, "title"> & {
	title: ReactNode;
	/** The one line under the title. */
	description?: ReactNode;
	/** A button or two at the end of the header: the card's own action, never "Save". */
	action?: ReactNode;
}) {
	const id = useId();
	return (
		<section
			aria-labelledby={`${id}-title`}
			data-slot="settings-card"
			className={cn(
				"bg-card text-card-foreground ring-foreground/10 flex flex-col gap-4 rounded-xl p-6 text-sm shadow-xs ring-1",
				className,
			)}
			{...props}
		>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1 space-y-1">
					<h2 id={`${id}-title`} className="text-base leading-normal font-medium">
						{title}
					</h2>
					{description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
				</div>
				{action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
			</div>
			{children}
		</section>
	);
}

/** Rows one under the other, with a hairline between them (inside a `SettingsCard`). */
export function SettingsRows({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="settings-rows" className={cn("flex flex-col divide-y", className)} {...props} />;
}

/**
 * One setting: its label and help on the left, its control on the right. Give `htmlFor` the control's
 * `id` and the help is its description too (`aria-describedby` on the control: `describedBy(id)`).
 */
export function SettingsRow({
	label,
	help,
	htmlFor,
	children,
	className,
}: {
	label: ReactNode;
	help?: ReactNode;
	/** The `id` of the control the label names. */
	htmlFor?: string;
	/** The control. */
	children?: ReactNode;
	className?: string;
}) {
	const Label = htmlFor ? "label" : "div";
	return (
		<div
			data-slot="settings-row"
			className={cn(
				"flex flex-col gap-3 py-4 first:pt-0 last:pb-0 @2xl/page:flex-row @2xl/page:items-center @2xl/page:justify-between @2xl/page:gap-6",
				className,
			)}
		>
			<div className="min-w-0 flex-1 space-y-0.5">
				<Label htmlFor={htmlFor} className="block text-sm font-medium">
					{label}
				</Label>
				{help ? (
					<p id={htmlFor ? describedBy(htmlFor) : undefined} className="text-muted-foreground text-[13px]">
						{help}
					</p>
				) : null}
			</div>
			{children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
		</div>
	);
}

/** The `id` of a `SettingsRow`'s help, for its control's `aria-describedby`. */
export function describedBy(controlId: string): string {
	return `${controlId}-help`;
}

/**
 * A row of a list inside settings (a domain, a webhook, a key, a token): what it is (often in
 * monospace) with its state as a badge, a line under it, and its actions at the right.
 */
export function SettingsListRow({
	children,
	detail,
	badge,
	actions,
	className,
}: {
	/** The thing's name. */
	children: ReactNode;
	badge?: ReactNode;
	/** A line under the name. */
	detail?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div
			data-slot="settings-list-row"
			className={cn(
				"flex flex-col gap-3 py-3 first:pt-0 last:pb-0 @2xl/page:flex-row @2xl/page:items-center @2xl/page:justify-between @2xl/page:gap-6",
				className,
			)}
		>
			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
					{children}
					{badge}
				</div>
				{detail ? <div className="text-muted-foreground text-[13px]">{detail}</div> : null}
			</div>
			{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
		</div>
	);
}

/** How a badge looks: what its state means. */
export type StateTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONES: Record<StateTone, string> = {
	success: "bg-emerald-600/10 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
	warning: "bg-amber-500/15 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
	danger: "bg-destructive/10 text-red-800 dark:bg-destructive/20 dark:text-red-200",
	info: "bg-sky-500/10 text-sky-900 dark:bg-sky-400/15 dark:text-sky-200",
	neutral: "border-border text-foreground border",
};

/** A thing's state in words, as a small badge ("Active", "Waiting for DNS", "Off"). */
export function StateBadge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: StateTone }) {
	return (
		<span
			data-slot="state-badge"
			data-tone={tone}
			className={cn(
				"inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap",
				TONES[tone],
				className,
			)}
			{...props}
		/>
	);
}

/**
 * An on/off control: a checkbox that says it is a switch. Name it with a `<label htmlFor>` (a
 * `SettingsRow`) or `aria-label`.
 */
export function Switch({
	className,
	checked,
	onCheckedChange,
	...props
}: Omit<ComponentProps<"input">, "type" | "onChange"> & {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<span className={cn("relative inline-flex h-[18px] w-8 shrink-0", className)}>
			<input
				type="checkbox"
				role="switch"
				aria-checked={checked}
				checked={checked}
				onChange={(event) => onCheckedChange(event.target.checked)}
				className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
				{...props}
			/>
			<span
				aria-hidden="true"
				className="bg-input peer-checked:bg-primary peer-focus-visible:ring-ring/50 peer-focus-visible:border-ring dark:bg-input/80 pointer-events-none absolute inset-0 rounded-full border border-transparent transition-colors duration-150 ease-in-out peer-focus-visible:ring-3 peer-disabled:opacity-50"
			/>
			<span
				aria-hidden="true"
				className="bg-background dark:bg-foreground peer-checked:dark:bg-primary-foreground pointer-events-none absolute top-0.5 left-0.5 size-3.5 rounded-full shadow-xs transition-transform duration-150 ease-in-out peer-checked:translate-x-3.5"
			/>
		</span>
	);
}
