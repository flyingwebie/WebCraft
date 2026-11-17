import { cn } from "@webcraft/ui/lib/utils.ts";
import { type ComponentProps, useState } from "react";

const DIGITS = 6;

/**
 * The six boxes of an authenticator code. One real input lies over them, so typing, pasting, the
 * phone's offer of a code from a text message, password managers and screen readers all meet a plain
 * field; the boxes only show its digits and where the next one goes. Anything but digits is dropped (a pasted "123 456" too), and only the first six are kept.
 */
export function CodeInput({
	value,
	onValueChange,
	className,
	...props
}: Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & {
	value: string;
	onValueChange(value: string): void;
}) {
	const [focused, setFocused] = useState(false);
	const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true";
	const next = Math.min(value.length, DIGITS - 1);
	return (
		<div className={cn("relative flex w-fit gap-2", className)}>
			{Array.from({ length: DIGITS }, (_, index) => (
				<span
					// oxlint-disable-next-line react/no-array-index-key -- the boxes are positions, never reordered.
					key={index}
					aria-hidden="true"
					className={cn(
						"border-input dark:bg-input/30 flex h-12 w-11 items-center justify-center rounded-lg border font-mono text-lg font-semibold shadow-xs transition-[color,box-shadow]",
						invalid && "border-destructive dark:border-destructive/50",
						focused && index === next && "border-ring ring-ring/50 ring-3",
						focused && index === next && invalid && "ring-destructive/20 dark:ring-destructive/40",
					)}
				>
					{value[index] ?? ""}
				</span>
			))}
			<input
				{...props}
				type="text"
				value={value}
				inputMode="numeric"
				pattern="[0-9]*"
				autoComplete="one-time-code"
				spellCheck={false}
				onChange={(event) => onValueChange(event.target.value.replace(/\D/g, "").slice(0, DIGITS))}
				onFocus={(event) => {
					setFocused(true);
					props.onFocus?.(event);
				}}
				onBlur={(event) => {
					setFocused(false);
					props.onBlur?.(event);
				}}
				className="absolute inset-0 size-full cursor-text opacity-0"
			/>
		</div>
	);
}
