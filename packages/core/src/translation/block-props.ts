import { type ComponentBlock, cleanRichText, richTextTranslation } from "@webcraft/renderer";
import type { FieldDefinition, Json } from "../content/field-types.ts";
import { mapPropLeaves } from "../content/prop-leaves.ts";
import { readPropText } from "../content/props.ts";

/** A Module Block uses its declared Fields to extract human text. Rebuilding changes only those
 * leaves: Media ids, URLs, select keys, boolean settings and other references stay untouched. */
export function blockPropsPlan(block: ComponentBlock, fields: readonly FieldDefinition[]) {
	const pieces: string[] = [];
	const rebuild = block.props.map((prop) => {
		const field = fields.find((f) => f.key === prop.name);
		if (!field) return () => prop;
		const read = readPropText(field, prop.value);
		if ("problem" in read) return () => prop;
		const readers: ((texts: readonly string[]) => Json)[] = [];
		mapPropLeaves(field, read.value, (leaf, value) => {
			if (!leaf.translatable) return value;
			if (leaf.type === "richText" && typeof value === "string") {
				const rich = richTextTranslation(value);
				const start = pieces.length;
				pieces.push(...rich.pieces);
				readers.push((texts) => cleanRichText(rich.rebuild(texts.slice(start, start + rich.pieces.length))));
			} else if (leaf.type === "text" && typeof value === "string") {
				const index = pieces.length;
				pieces.push(value);
				readers.push((texts) => texts[index] ?? value);
			} else if (leaf.type === "link" && value && typeof value === "object" && !Array.isArray(value)) {
				const text = typeof value.text === "string" ? value.text : "";
				const index = pieces.length;
				pieces.push(text);
				readers.push((texts) => ({ ...value, text: texts[index] ?? text }));
			}
			return value;
		});
		if (!readers.length) return () => prop;
		return (texts: readonly string[]) => {
			let index = 0;
			const value = mapPropLeaves(field, read.value, (leaf, value) => {
				if (
					leaf.translatable &&
					(((leaf.type === "text" || leaf.type === "richText") && typeof value === "string") ||
						(leaf.type === "link" && value && typeof value === "object" && !Array.isArray(value)))
				)
					return readers[index++]?.(texts) ?? value;
				return value;
			});
			return { ...prop, value: typeof value === "string" ? value : JSON.stringify(value) };
		};
	});
	return {
		pieces,
		finish: (texts: readonly string[]): ComponentBlock => ({ ...block, props: rebuild.map((read) => read(texts)) }),
	};
}
