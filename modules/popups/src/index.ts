import { defineModule } from "@webcraft/module-sdk";
import { POPUP_SCRIPT } from "./script.ts";
export default defineModule({
	manifest: {
		id: "popups",
		name: { en: "Popups", it: "Popup" },
		description: {
			en: "Promotions with visitor-friendly triggers and Necessary local frequency storage.",
			it: "Promozioni con attivazione rispettosa dei visitatori e frequenza memorizzata localmente come Necessaria.",
		},
		version: "1.0.0",
		sdk: "^1.3.0",
		level: "site",
		onByDefault: true,
		adminLanguages: ["en", "it"],
		permissions: [],
		siteScript: "necessary",
	},
	siteScript: { code: POPUP_SCRIPT },
});
