import type { Block } from "@webcraft/renderer/body";
import {
	ChevronRightIcon,
	CodeIcon,
	Heading2Icon,
	Heading3Icon,
	Heading4Icon,
	ImageIcon,
	InfoIcon,
	ListIcon,
	ListOrderedIcon,
	type LucideIcon,
	MinusIcon,
	PilcrowIcon,
	QuoteIcon,
	TableIcon,
	VideoIcon,
} from "lucide-react";

import {
	BLOCK_CHOICES as MODEL_CHOICES,
	type BlockChoice as ModelChoice,
	choiceOf as modelChoiceOf,
} from "../../../body-editor/model.ts";
import type { MessageKey } from "../../i18n.tsx";

export {
	isTextBlock,
	itemsOf,
	keepsText,
	type Line,
	linesOf,
	matches,
	newBlock,
	newComponentBlock,
	SHORTCUTS,
	textOfBlock,
	turnInto,
	WHOLE_SHORTCUTS,
} from "../../../body-editor/model.ts";

/**
 * What the admin's block editor offers to add (from the `/` menu and the toolbar) or turn a Block
 * into: the shared editor model's choices (`body-editor/model.ts`), each with its icon here. Their
 * words are in the message files under `body.choices`.
 */
export type BlockChoice = Omit<ModelChoice, "label"> & { label: MessageKey; icon: LucideIcon };

const ICONS: Readonly<Record<string, LucideIcon>> = {
	paragraph: PilcrowIcon,
	heading2: Heading2Icon,
	heading3: Heading3Icon,
	heading4: Heading4Icon,
	bulleted: ListIcon,
	numbered: ListOrderedIcon,
	quote: QuoteIcon,
	image: ImageIcon,
	video: VideoIcon,
	table: TableIcon,
	callout: InfoIcon,
	code: CodeIcon,
	divider: MinusIcon,
	toggle: ChevronRightIcon,
};

export const BLOCK_CHOICES: readonly BlockChoice[] = MODEL_CHOICES.map((choice) => ({
	...choice,
	label: choice.label as MessageKey,
	icon: ICONS[choice.id] ?? PilcrowIcon,
}));

/** The choice a Block is (its type, level or style), for its name and icon; a paragraph's for a Component. */
export function choiceOf(block: Block): BlockChoice {
	const found = modelChoiceOf(block);
	return BLOCK_CHOICES.find((choice) => choice.id === found?.id) ?? (BLOCK_CHOICES[0] as BlockChoice);
}
