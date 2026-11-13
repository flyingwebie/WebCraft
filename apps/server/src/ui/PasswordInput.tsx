import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@webcraft/ui/components/input-group.tsx";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";

import { useT } from "./i18n.tsx";

/** A password field with a button that shows or hides what was typed. */
export function PasswordInput(props: Omit<ComponentProps<"input">, "type">) {
	const t = useT();
	const [visible, setVisible] = useState(false);
	return (
		<InputGroup>
			<InputGroupInput {...props} type={visible ? "text" : "password"} />
			<InputGroupAddon align="inline-end">
				<InputGroupButton
					size="icon-xs"
					aria-label={t("setup.steps.account.showPassword")}
					aria-pressed={visible}
					onClick={() => setVisible(!visible)}
				>
					{visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
				</InputGroupButton>
			</InputGroupAddon>
		</InputGroup>
	);
}
