// Existing SDK 1.7 file-source consumers must still compile against the additive live-source API.
// This public type contract is checked by the tests workspace's normal typecheck.
import {
	type AnyModuleDefinition,
	defineModule,
	type ImportSource,
	importSource,
	type LiveImportSourceDefinition,
	type ModuleContext,
	type ModuleDefinition,
	type SourceFile,
	type SourceItem,
} from "@webcraft/module-sdk";

const fileSource = importSource({
	key: "existing-file",
	label: { en: "Existing file" },
	description: { en: "A Module's existing file reader." },
	permission: "structure.edit",
	file: { maxBytes: 1024, extensions: [".txt"] },
	async *read(file) {
		for await (const _part of file.text()) yield { kind: "type", key: "notes", label: "Notes", holds: "entries" };
	},
});

export const existingFileLimit: number = fileSource.file.maxBytes;

export function readExistingFile(file: SourceFile, context: ModuleContext): AsyncIterable<SourceItem> {
	return fileSource.read(file, context);
}

export function readDeclaredFile(
	source: ImportSource,
	file: SourceFile,
	context: ModuleContext,
): AsyncIterable<SourceItem> {
	return source.read(file, context);
}

export function declaredFileSources(definition: ModuleDefinition): readonly ImportSource[] {
	return definition.importSources ?? [];
}

export function readDeclaredModule(
	definition: ModuleDefinition,
	file: SourceFile,
	context: ModuleContext,
): AsyncIterable<SourceItem> | undefined {
	return definition.importSources?.[0]?.read(file, context);
}

export function declaredModuleFileLimit(definition: ModuleDefinition): number | undefined {
	return definition.importSources?.[0]?.file.maxBytes;
}

const fileDefinition = defineModule({
	manifest: {
		id: "type-contract",
		name: { en: "Type contract" },
		description: { en: "Public SDK import-source contracts." },
		version: "1.0.0",
		sdk: "^1.13.0",
		level: "site",
		onByDefault: false,
		adminLanguages: ["en"],
	},
	importSources: [fileSource],
});
export const existingDefinition: ModuleDefinition = fileDefinition;
export const inferredFileLimit: number = fileDefinition.importSources[0].file.maxBytes;

const liveSource = importSource({
	key: "live",
	label: { en: "Live source" },
	description: { en: "Read a live source through the public SDK." },
	permission: "structure.edit",
	live: {
		async test() {
			return { roles: [], types: [] };
		},
		async *read() {},
	},
});
export const mixedDefinition: AnyModuleDefinition = defineModule({
	...fileDefinition,
	importSources: [fileSource, liveSource],
});
export const liveDefinition: ModuleDefinition<LiveImportSourceDefinition> = defineModule({
	...fileDefinition,
	importSources: [liveSource],
});
// @ts-expect-error A live catalogue does not promise file readers without narrowing its sources.
export const liveAsFiles: ModuleDefinition = liveDefinition;
