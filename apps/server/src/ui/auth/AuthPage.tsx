import { useRouteContext } from "@tanstack/react-router";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { CircleAlertIcon, CircleCheckIcon, CircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useT } from "../i18n.tsx";
import { initials } from "../shell/context.ts";

const WIDTHS = {
	/** Signing in, the second step, passwords. */
	default: "max-w-[400px]",
	/** An invitation: it carries the Workspace's own mark too. */
	invite: "max-w-[440px]",
	/** The setup and other two-column cards: the steps at the left, the current one at the right. */
	wide: "max-w-[640px]",
} as const;

/**
 * The page a person meets before the admin: the window in the sidebar's colour, one card in the
 * middle on the page colour, the Install's mark above it (WebCraft's own on the setup, before the
 * agency has a name), an optional quiet line under it, and "Made with WebCraft" at the foot.
 */
export function AuthPage({
	mark = "install",
	width = "default",
	below,
	className,
	children,
}: {
	/** Whose mark sits above the card: the Install's (its name as the app knows it), or WebCraft's. */
	mark?: "install" | "webcraft";
	width?: keyof typeof WIDTHS;
	/** A quiet line under the card. */
	below?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const t = useT();
	const { shell } = useRouteContext({ from: "__root__" });
	const name = (mark === "install" ? shell.install.name : null) ?? t("app.name");
	return (
		<main id="main" tabIndex={-1} className="bg-sidebar text-foreground flex min-h-svh flex-col outline-none">
			<div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-10">
				<BrandMark name={name} />
				<div
					className={cn(
						"bg-background text-foreground flex w-full flex-col gap-5 rounded-xl border p-6 shadow-md",
						WIDTHS[width],
						className,
					)}
				>
					{children}
				</div>
				{below ? <div className="text-muted-foreground text-center text-[13px]">{below}</div> : null}
			</div>
			<p className="text-muted-foreground flex h-12 shrink-0 items-center justify-center text-xs">
				{t("auth.madeWith")}
			</p>
		</main>
	);
}

/** A square tile with the initials, and the name beside it. */
export function BrandMark({ name, size = "default" }: { name: string; size?: "default" | "small" }) {
	return (
		<p className="flex items-center gap-2.5">
			<span
				aria-hidden="true"
				className={cn(
					"bg-primary text-primary-foreground flex shrink-0 items-center justify-center font-bold",
					size === "default" ? "size-10 rounded-[10px] text-sm" : "size-7 rounded-lg text-xs",
				)}
			>
				{initials(name)}
			</span>
			<span className={cn("font-semibold", size === "default" ? "text-[15px]" : "text-sm")}>{name}</span>
		</p>
	);
}

/** The card's heading. `size="large"` is the sign-in card's own; every other state is a step smaller. */
export function AuthHeading({
	size = "default",
	className,
	...props
}: ComponentProps<"h1"> & { size?: "default" | "large" }) {
	return (
		<h1
			tabIndex={-1}
			className={cn(
				"font-semibold tracking-[-0.01em] outline-none",
				size === "large" ? "text-2xl" : "text-[22px] leading-tight",
				className,
			)}
			{...props}
		/>
	);
}

/** The muted line under a heading. */
export function AuthLead({ className, ...props }: ComponentProps<"p">) {
	return <p className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

/** One line of warning above a form's fields: what went wrong and what to do next. */
export function FormAlert({ className, children, ...props }: ComponentProps<"div">) {
	return (
		<div
			role="alert"
			className={cn(
				"bg-destructive/10 dark:bg-destructive/20 flex items-start gap-2 rounded-lg p-2.5 text-[13px] text-red-800 dark:text-red-200",
				className,
			)}
			{...props}
		>
			<CircleAlertIcon className="mt-px size-4 shrink-0" aria-hidden="true" />
			<span className="min-w-0 flex-1">{children}</span>
		</div>
	);
}

/** The shortest password the server takes (`MIN_PASSWORD_LENGTH` in `@webcraft/auth`), in characters. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * The rule a new password must meet that the page can check, ticked off as it is typed; its id is for
 * `aria-describedby`. The rest (the longest length, a password found in leaked lists when the Install
 * checks that) only the server knows: its refusal shows under the field as before.
 */
export function PasswordRules({ id, password }: { id: string; password: string }) {
	const t = useT();
	const rules = [
		{ key: "length", text: t("auth.passwordRules.length"), met: Array.from(password).length >= MIN_PASSWORD_LENGTH },
	];
	return (
		<ul id={id} className="grid gap-1.5">
			{rules.map((rule) => (
				<li
					key={rule.key}
					className={cn(
						"flex items-center gap-1.5 text-[13px]",
						rule.met ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{rule.met ? (
						<CircleCheckIcon className="size-3.5 shrink-0 text-green-700 dark:text-green-400" aria-hidden="true" />
					) : (
						<CircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
					)}
					{rule.text}
					<span className="sr-only"> ({rule.met ? t("auth.passwordRules.met") : t("auth.passwordRules.notMet")})</span>
				</li>
			))}
		</ul>
	);
}
