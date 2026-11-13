/**
 * A few choices side by side, one pressed (Live or On submit, Any or All): toggle buttons in a fieldset,
 * each saying whether it is pressed, so every choice is one Tab stop and Space or Enter picks it.
 */
export function Segmented<Value extends string>({
	label,
	labelledBy,
	value,
	options,
	onChange,
	size = "default",
}: {
	/** The group's name for screen readers, when no visible label names it (`labelledBy`). */
	label?: string;
	labelledBy?: string;
	value: Value;
	options: readonly { value: Value; label: string; disabled?: boolean }[];
	onChange(value: Value): void;
	size?: "default" | "sm";
}) {
	return (
		<fieldset
			aria-label={labelledBy ? undefined : label}
			aria-labelledby={labelledBy}
			className="bg-muted m-0 inline-flex w-fit min-w-0 flex-wrap gap-0.5 rounded-md border-0 p-0.5"
		>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={option.value === value}
					disabled={option.disabled}
					onClick={() => onChange(option.value)}
					className={`focus-visible:ring-ring/50 aria-pressed:bg-background aria-pressed:text-foreground text-muted-foreground rounded-sm font-medium outline-none focus-visible:ring-3 disabled:opacity-50 aria-pressed:shadow-sm ${size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"}`}
				>
					{option.label}
				</button>
			))}
		</fieldset>
	);
}
