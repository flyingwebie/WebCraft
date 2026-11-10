import { blockType, type ComponentProp, defineModule } from "@webcraft/module-sdk";
import { SCRIPT } from "./script.ts";

const items: ComponentProp = {
	key: "items",
	label: { en: "Items", it: "Elementi" },
	type: "repeater",
	max: 50,
	fields: [
		{ key: "heading", label: { en: "Heading", it: "Titolo" }, type: "text", required: true },
		{ key: "text", label: { en: "Text", it: "Testo" }, type: "richText" },
	],
};
export default defineModule({
	manifest: {
		id: "extra-blocks",
		version: "1.0.0",
		sdk: "^1.12.0",
		level: "site",
		onByDefault: true,
		name: { en: "Extra blocks", it: "Blocchi aggiuntivi" },
		description: {
			en: "Galleries, accordions, tabs and maps for Body fields and Templates.",
			it: "Gallerie, fisarmoniche, schede e mappe per corpi e modelli.",
		},
		adminLanguages: ["en", "it"],
		permissions: [],
		uses: [],
		outsideHosts: ["www.openstreetmap.org"],
		siteScript: "media",
	},
	siteScript: { code: SCRIPT, whenUsed: ["Tabs", "MapEmbed"] },
	blockTypes: [
		blockType({
			name: "Gallery",
			label: { en: "Gallery", it: "Galleria" },
			props: [
				{
					key: "images",
					label: { en: "Images", it: "Immagini" },
					type: "repeater",
					max: 50,
					fields: [
						{ key: "image", label: { en: "Image", it: "Immagine" }, type: "media", required: true },
						{ key: "alt", label: { en: "Alt text", it: "Testo alternativo" }, type: "text" },
						{ key: "decorative", label: { en: "Decorative", it: "Decorativa" }, type: "boolean" },
						{ key: "caption", label: { en: "Caption", it: "Didascalia" }, type: "text" },
					],
				},
			],
			markup:
				'<div data-extra-block="gallery">{{@loop props.images as image}}<figure>{{@if image.decorative}}<img src="{{ image.image }}" data-wc-decorative="true">{{@else}}<img src="{{ image.image }}" alt="{{ image.alt }}">{{/if}}{{@if image.caption}}<figcaption>{{ image.caption }}</figcaption>{{/if}}</figure>{{/loop}}</div>',
		}),
		blockType({
			name: "Accordion",
			label: { en: "Accordion", it: "Fisarmonica" },
			props: [items],
			markup:
				'<section data-extra-block="accordion">{{@loop props.items as item}}<details><summary>{{ item.heading }}</summary><div>{{ item.text }}</div></details>{{/loop}}</section>',
		}),
		blockType({
			name: "Tabs",
			label: { en: "Tabs", it: "Schede" },
			props: [{ key: "label", label: { en: "Label", it: "Etichetta" }, type: "text", required: true }, items],
			markup:
				'<section data-extra-block="tabs" aria-label="{{ props.label }}">{{@loop props.items as item}}<section><h2>{{ item.heading }}</h2><div>{{ item.text }}</div></section>{{/loop}}</section>',
		}),
		blockType({
			name: "MapEmbed",
			label: { en: "Map embed", it: "Mappa incorporata" },
			props: [
				{ key: "label", label: { en: "Map title", it: "Titolo della mappa" }, type: "text", required: true },
				{
					key: "url",
					label: { en: "OpenStreetMap embed URL", it: "URL di incorporamento OpenStreetMap" },
					type: "text",
					required: true,
					translatable: false,
					pattern: "^https://www\\.openstreetmap\\.org/export/embed\\.html\\?[^\\s<>]+$",
				},
			],
			markup: '<div data-extra-block="map"><a href="{{ props.url }}">{{ props.label }}</a></div>',
		}),
	],
});
