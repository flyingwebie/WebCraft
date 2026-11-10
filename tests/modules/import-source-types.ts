// Existing SDK 1.7 file-source consumers must still compile against the additive live-source API.
// This public type contract is checked by the tests workspace's normal typecheck.
import {
	type ImportSource,
	importSource,
	type ModuleContext,
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
