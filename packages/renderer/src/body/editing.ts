/**
 * The part of the Body field's code the block editors run in the browser (#79): Blocks' types and
 * limits, new ids, and formatted text as runs and as HTML. It holds nothing that reads HTML or
 * Markdown (those run on the server), so the editing bar's body module stays small.
 */
export {
	ALWAYS_ON_BLOCKS,
	BLOCK_TYPES,
	type Block,
	type BlockProp,
	type BlockType,
	BODY_LIMITS,
	type BodyBlockType,
	CALLOUT_TONES,
	type CalloutTone,
	type ComponentBlock,
	HEADING_LEVELS,
	type HeadingLevel,
	type ListItem,
	type ListStyle,
} from "./blocks.ts";
export { newBlockId } from "./body.ts";
export {
	canonicalInline,
	type InlineText,
	inlineText,
	isSafeLink,
	MARKS,
	type Mark,
	type Run,
	renderInline,
} from "./inline.ts";
export { videoAt } from "./video.ts";
