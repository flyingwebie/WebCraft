import {
	ArrowDownIcon,
	ArrowUpIcon,
	BoldIcon,
	BoxIcon,
	CodeIcon,
	CodeXmlIcon,
	EllipsisIcon,
	GripVerticalIcon,
	Heading2Icon,
	Heading3Icon,
	Heading4Icon,
	ImageIcon,
	ItalicIcon,
	LinkIcon,
	ListCollapseIcon,
	ListIcon,
	ListOrderedIcon,
	type LucideIcon,
	MessageSquareWarningIcon,
	MinusIcon,
	PilcrowIcon,
	PlusIcon,
	QuoteIcon,
	StrikethroughIcon,
	TableIcon,
	VideoIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import type { BodyInPlace as Controller } from "./body-in-place.ts";

/**
 * The icons the block editor asks its kit for (`icon(name)`), and the Block list's tiles
 * (`choice-<id>`, `choice-component`), drawn once here and copied into what the editor makes.
 */
const ICONS: readonly [string, LucideIcon][] = [
	["grip", GripVerticalIcon],
	["add", PlusIcon],
	["up", ArrowUpIcon],
	["down", ArrowDownIcon],
	["bold", BoldIcon],
	["italic", ItalicIcon],
	["strike", StrikethroughIcon],
	["code", CodeIcon],
	["link", LinkIcon],
	["more", EllipsisIcon],
	["close", XIcon],
	["choice-paragraph", PilcrowIcon],
	["choice-heading2", Heading2Icon],
	["choice-heading3", Heading3Icon],
	["choice-heading4", Heading4Icon],
	["choice-bulleted", ListIcon],
	["choice-numbered", ListOrderedIcon],
	["choice-quote", QuoteIcon],
	["choice-image", ImageIcon],
	["choice-video", VideoIcon],
	["choice-table", TableIcon],
	["choice-callout", MessageSquareWarningIcon],
	["choice-code", CodeXmlIcon],
	["choice-divider", MinusIcon],
	["choice-toggle", ListCollapseIcon],
	["choice-component", BoxIcon],
];

/**
 * The layer a body's tools are drawn in while a Member writes a post (BA-18, `body-in-place.ts`):
 * over the frame's page, in the shell's own document. React draws the layer and the icons; the block
 * editor puts its toolbar, the Block list, its forms and menus in the layer itself. It comes before
 * the frame in the Tab order, so the page stays the last stop; the tools are reached with Alt+F10 and
 * `/`, and give focus back to the text.
 */
export function BodyInPlace({ body }: { body: Controller }) {
	const layer = useRef<HTMLDivElement>(null);
	const icons = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!layer.current || !icons.current) return;
		body.mount({ layer: layer.current, icons: icons.current });
		return () => body.mount(null);
	}, [body]);
	return (
		<>
			<div
				ref={layer}
				className="group/body pointer-events-none fixed top-0 left-0 z-30 origin-top-left"
				data-wc-body-tools=""
			/>
			<div ref={icons} hidden data-wc-body-icons="">
				{ICONS.map(([name, Icon]) => (
					<Icon key={name} data-icon={name} aria-hidden="true" focusable="false" />
				))}
			</div>
		</>
	);
}
