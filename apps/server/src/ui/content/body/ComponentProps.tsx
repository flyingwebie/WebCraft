import type { ComponentBlock } from "@webcraft/renderer/body";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@webcraft/ui/components/dialog.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useId, useState } from "react";
import { type BodyComponentChoice, propDefaultText, propNeeded } from "../../../body-editor/model.ts";
import { useT } from "../../i18n.tsx";
import { MediaPicker } from "../../media/MediaPicker.tsx";
import type { MediaItem } from "../../media/preview.ts";

/** Fixed Prop text uses the same defaults and required rules as the editing bar's form. */
export function ComponentProps({
	siteId,
	component,
	block,
	media,
	onMediaChosen,
	onSave,
	onClose,
}: {
	siteId: string;
	component: BodyComponentChoice;
	block?: ComponentBlock;
	media: Readonly<Record<string, MediaItem>>;
	onMediaChosen(item: MediaItem): void;
	onSave(props: ComponentBlock["props"]): void;
	onClose(): void;
}) {
	const t = useT();
	const id = useId();
	const [values, setValues] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			component.props.map((prop) => [
				prop.key,
				block?.props.find((each) => each.name === prop.key)?.value ?? propDefaultText(prop),
			]),
		),
	);
	const [problem, setProblem] = useState("");
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent closeLabel={t("body.cancel")} className="max-h-[85dvh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("body.components.title", { name: component.name })}</DialogTitle>
				</DialogHeader>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						const props: ComponentBlock["props"] = [];
						for (const prop of component.props) {
							const value = (values[prop.key] ?? "").trim();
							if (!value && propNeeded(prop)) {
								setProblem(t("body.components.missing", { prop: prop.label }));
								return;
							}
							if (value || prop.type === "boolean")
								props.push({ name: prop.key, value: prop.type === "boolean" && !value ? "false" : value });
						}
						onSave(props);
					}}
				>
					{component.props.map((prop) => {
						const controlId = `${id}-${prop.key}`;
						const value = values[prop.key] ?? "";
						const set = (value: string) => setValues((before) => ({ ...before, [prop.key]: value }));
						const label = `${prop.label}${propNeeded(prop) ? ` (${t("body.components.required")})` : ""}`;
						return (
							<div key={prop.key} className="grid gap-2">
								{prop.type === "media" ? (
									<>
										<span id={`${controlId}-label`} className="text-sm font-medium">
											{label}
										</span>
										<MediaPicker
											siteId={siteId}
											id={controlId}
											labelledBy={`${controlId}-label`}
											value={value.slice(6) || null}
											item={media[value.slice(6)] ?? null}
											onChange={(next) => {
												if (next) onMediaChosen(next.item);
												set(next ? `media:${next.id}` : "");
											}}
										/>
									</>
								) : (
									<>
										<Label htmlFor={controlId}>{label}</Label>
										{prop.type === "boolean" ? (
											<input
												id={controlId}
												type="checkbox"
												className="size-5"
												checked={
													value === "true" ||
													(value === "" && block?.props.some((each) => each.name === prop.key)) ||
													false
												}
												onChange={(e) => set(e.target.checked ? "true" : "false")}
											/>
										) : prop.type === "select" ? (
											<select
												id={controlId}
												className="border-input bg-background min-h-9 rounded-md border px-3"
												multiple={prop.multiple}
												value={prop.multiple ? value.split(",") : value}
												onChange={(e) => set([...e.target.selectedOptions].map((option) => option.value).join(","))}
											>
												{!prop.multiple ? <option value="">—</option> : null}
												{prop.options?.map((option) => (
													<option key={option.value} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
										) : ["richText", "group", "repeater"].includes(prop.type) ? (
											<Textarea id={controlId} value={value} onChange={(e) => set(e.target.value)} />
										) : (
											<Input
												id={controlId}
												value={value}
												type={prop.type === "email" ? "email" : "text"}
												inputMode={prop.type === "number" ? "decimal" : undefined}
												onChange={(e) => set(e.target.value)}
											/>
										)}
									</>
								)}
								{prop.help ? <p className="text-muted-foreground text-sm">{prop.help}</p> : null}
								{["group", "repeater"].includes(prop.type) ? (
									<p className="text-muted-foreground text-sm">{t("body.components.json")}</p>
								) : null}
							</div>
						);
					})}
					<p role="alert" className="text-destructive empty:hidden">
						{problem}
					</p>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							{t("body.cancel")}
						</Button>
						<Button type="submit">{t(block ? "body.components.save" : "body.components.insert")}</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
