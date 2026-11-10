import type { QualityCheck } from "@webcraft/renderer";
import type { PopupSettings } from "./index.ts";

/** Advisory like every other Check: a short delay never prevents saving or publishing. */
export function popupChecks(settings: PopupSettings, attached = false): QualityCheck[] {
	return (attached || settings.rules.devices.includes("phone")) &&
		[settings.trigger, ...settings.additionalTriggers].some(
			(trigger) => trigger.kind === "load" || (trigger.kind === "delay" && trigger.seconds < 5),
		)
		? [{ check: "popupPhoneEarly", at: "trigger" }]
		: [];
}
