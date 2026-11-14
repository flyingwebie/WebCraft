import { useId, useRef } from "react";

import { useCodeFormat } from "../../../code-format/FormatControl.tsx";
import type { Editing } from "../../../design-system/editing.ts";
import type { Words } from "../../api.ts";
import { CodeBox, FormatControl, NoteLine } from "./CodeBox.tsx";

/**
 * Styles › Site CSS (SPEC 8): the Site's own CSS as one code file with Format, in the stylesheet's
 * last layer (so it never needs `!important`). Saved to the Design system's Draft a moment after typing
 * stops; the server checks it as it saves, and says where a problem is.
 */
export function SiteCssTab({ words, editing }: { words: Words; editing: Editing }) {
	const shown = words.styles.siteCss;
	const id = useId();
	const area = useRef<HTMLTextAreaElement>(null);
	const value = editing.draft.customCss;
	const formatting = useCodeFormat("css", area, value);
	return (
		<section
			aria-labelledby={`${id}-title`}
			className="border-chrome-hover flex min-w-0 grow flex-col gap-2 rounded-[10px] border p-2"
			data-wc-site-css=""
		>
			<div className="flex h-8 items-center gap-2 px-1">
				<h2 id={`${id}-title`} className="text-chrome-strong m-0 text-[14px] font-semibold">
					{shown.title}
				</h2>
				<span className="ms-auto inline-flex">
					<FormatControl format={formatting} words={words} />
				</span>
			</div>
			<CodeBox
				ref={area}
				value={value}
				onChange={(text) => editing.setSection("customCss", text)}
				onKeyDown={(event) => {
					formatting.onKeyDown(event);
				}}
				label={shown.title}
				describedBy={`${id}-note`}
				problemLine={formatting.problemLine}
				data={{ "data-wc-site-css-box": "" }}
			/>
			<NoteLine id={`${id}-note`} format={formatting} words={words} help={shown.help} />
		</section>
	);
}
