// The WordPress import Module (ADR 0024): agencies move a WordPress site in from an export file or REST.
// Its streaming readers turn a WordPress export (WXR) or paginated REST responses into items the
// Import pipeline takes (types, posts, pages, custom post types, terms and Media files). Mapping,
// the preview, the Drafts, fetching Media, Redirect rules, the Import report and Undo are WebCraft's,
// the same for every source. Staff only: a run may create Post Types, which is Structure. It
// imports nothing from WebCraft but the Module SDK.
import { defineModule, IMPORT_FILE_MAX_BYTES, importSource } from "@webcraft/module-sdk";
import { exportItems } from "./export.ts";
import { liveSource } from "./live.ts";

export const wordpressImport = defineModule({
	manifest: {
		id: "wordpress-import",
		name: { en: "WordPress import", it: "Importazione da WordPress" },
		description: {
			en: "Moves a WordPress site in from its export file or a live connection: posts, pages, custom post types, categories, tags and Media come in as Drafts, with Redirect rules from the old addresses.",
			it: "Porta dentro un sito WordPress dal suo file di esportazione o da una connessione online: articoli, pagine, tipi di contenuto personalizzati, categorie, tag e Media arrivano come Bozze, con le regole di reindirizzamento dai vecchi indirizzi.",
		},
		version: "1.1.0",
		sdk: "^1.13.0",
		uses: ["importSourceHttp"],
		level: "site",
		onByDefault: true,
		adminLanguages: ["en", "it"],
	},

	importSources: [
		importSource({
			key: "live",
			label: { en: "WordPress live site", it: "Sito WordPress online" },
			description: { en: "Connect with an application password", it: "Collega con una password applicazione" },
			permission: "structure.edit",
			live: liveSource,
		}),
		importSource({
			key: "export",
			label: { en: "WordPress export file", it: "File di esportazione WordPress" },
			description: { en: "Upload the .xml file", it: "Carica il file .xml" },
			permission: "structure.edit",
			file: { maxBytes: IMPORT_FILE_MAX_BYTES, extensions: [".xml"] },
			read: (file) => exportItems(file),
		}),
	],
});

export default wordpressImport;
