import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { useEffect, useId, useState } from "react";
import { getApi } from "../../api.ts";
import { errorMessage } from "../../errors.ts";
import { useT } from "../../i18n.tsx";

/** A Body field's allow-list is Structure, saved with its other Field settings. */
export function AllowedComponents({
	siteId,
	value,
	onChange,
}: {
	siteId: string;
	value: readonly string[];
	onChange(ids: string[]): void;
}) {
	const t = useT();
	const id = useId();
	const [components, setComponents] = useState<{ id: string; name: string }[]>([]);
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		void getApi()
			.then((api) => api.components.list({ siteId }))
			.then((result) => {
				if (active) setComponents(result.components.filter((component) => !component.module));
			})
			.catch((error) => {
				if (active) setError(t(errorMessage(error)));
			});
		return () => {
			active = false;
		};
	}, [siteId, t]);
	return (
		<fieldset className="grid gap-2" aria-describedby={`${id}-help`}>
			<legend className="mb-1 text-sm font-medium">{t("body.components.allowed")}</legend>
			<p id={`${id}-help`} className="text-muted-foreground text-sm">
				{t("body.components.allowedHelp")}
			</p>
			{components.map((component) => (
				<div key={component.id} className="flex items-center gap-2">
					<Checkbox
						id={`${id}-${component.id}`}
						checked={value.includes(component.id)}
						onCheckedChange={(checked) =>
							onChange(checked === true ? [...value, component.id] : value.filter((each) => each !== component.id))
						}
					/>
					<Label htmlFor={`${id}-${component.id}`} className="font-normal">
						{component.name}
					</Label>
				</div>
			))}
			<p role="alert" className="text-destructive empty:hidden">
				{error}
			</p>
		</fieldset>
	);
}
