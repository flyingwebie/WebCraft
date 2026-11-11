import { Button } from "@webcraft/ui/components/button.tsx";
import { useT } from "../i18n.tsx";
import type { InsertWhere } from "./InsertDialog.tsx";

export function InsertToolbar({
	where,
	canInside,
	onWhere,
	onPick,
	onPreview,
}: {
	where: InsertWhere;
	canInside: boolean;
	onWhere(value: InsertWhere): void;
	onPick(item: string | null, trigger: HTMLButtonElement): void;
	onPreview?(show: boolean): void;
}) {
	const t = useT();
	return (
		<fieldset className="grid gap-2 border-b p-2" aria-label={t("builder.insert.open")}>
			<div className="flex gap-1">
				{(["inside", "after"] as const).map((value) => (
					<Button
						key={value}
						type="button"
						size="sm"
						variant="outline"
						disabled={value === "inside" && !canInside}
						aria-pressed={where === value}
						onClick={() => onWhere(value)}
					>
						{t(`builder.toolbar.${value}`)}
					</Button>
				))}
			</div>
			<div className="flex flex-wrap gap-1">
				{(
					[
						["h2", "heading"],
						["p", "paragraph"],
						["image", "image"],
						["command-loop", "loop"],
						["components", "component"],
						[null, "more"],
					] as const
				).map(([item, word]) => (
					<Button
						key={word}
						type="button"
						size="sm"
						variant="outline"
						onFocus={() => onPreview?.(true)}
						onBlur={() => onPreview?.(false)}
						onMouseEnter={() => onPreview?.(true)}
						onMouseLeave={() => onPreview?.(false)}
						onClick={(event) => onPick(item, event.currentTarget)}
					>
						{t(`builder.toolbar.${word}`)}
					</Button>
				))}
			</div>
		</fieldset>
	);
}
