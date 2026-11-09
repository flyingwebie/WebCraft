import { createHash } from "node:crypto";

import { SCRIPT_PATH } from "../design-system/theme-toggle.ts";

const SCRIPT = `(() => {})();
`;

/** The Filter script: its file name (`<hash>.js`), address and text. */
export const FILTER_SCRIPT = (() => {
	const name = `${createHash("sha256").update(SCRIPT).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text: SCRIPT };
})();
