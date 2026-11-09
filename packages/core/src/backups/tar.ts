/**
 * A Backup archive is a plain tar file (POSIX ustar, with pax headers for long paths and large
 * sizes), written and read as a stream so no archive is ever held in memory. Only regular files are
 * written; reading skips anything else. Standard tools (`tar -tf`, `tar -xf`) read it too.
 */

const BLOCK = 512;

/** One file to write: its path in the archive, its size in bytes and its content. */
export type TarInput = {
	path: string;
	size: number;
	body: Uint8Array | AsyncIterable<Uint8Array>;
};

/** One file read from an archive. Read `body` to the end, or leave it: the reader skips what is left. */
export type TarEntry = {
	path: string;
	size: number;
	body: AsyncIterable<Uint8Array>;
};

/** The archive isn't a tar file, or it ends part-way through. */
export class TarFormatError extends Error {
	override name = "TarFormatError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Writes the entries as one tar archive, chunk by chunk. A body that isn't `size` bytes long throws. */
export async function* writeTar(entries: AsyncIterable<TarInput> | Iterable<TarInput>): AsyncGenerator<Uint8Array> {
	for await (const entry of entries) {
		const pathBytes = encoder.encode(entry.path);
		const records: string[] = [];
		if (pathBytes.length > 100) records.push(paxRecord("path", entry.path));
		if (entry.size > 0o77777777777) records.push(paxRecord("size", String(entry.size)));
		if (records.length > 0) {
			const pax = encoder.encode(records.join(""));
			yield header({ path: "PaxHeader", size: pax.length, type: "x" });
			yield pax;
			yield padding(pax.length);
		}
		yield header({ path: pathBytes.length > 100 ? "long-path" : entry.path, size: entry.size, type: "0" });
		let written = 0;
		const chunks = entry.body instanceof Uint8Array ? [entry.body] : entry.body;
		for await (const chunk of chunks) {
			written += chunk.length;
			if (written > entry.size) throw new Error(`${entry.path} is longer than the ${entry.size} bytes it said.`);
			yield chunk;
		}
		if (written !== entry.size) throw new Error(`${entry.path} is ${written} bytes, not the ${entry.size} it said.`);
		yield padding(entry.size);
	}
	yield new Uint8Array(BLOCK * 2);
}

/** A pax record: `<length> <key>=<value>\n`, where the length counts the whole record. */
function paxRecord(key: string, value: string): string {
	const rest = ` ${key}=${value}\n`;
	const restLength = encoder.encode(rest).length;
	let length = restLength + 1;
	while (String(length).length + restLength !== length) length = String(length).length + restLength;
	return `${length}${rest}`;
}

function header({ path, size, type }: { path: string; size: number; type: "0" | "x" }): Uint8Array {
	const block = new Uint8Array(BLOCK);
	const put = (offset: number, length: number, text: string) => {
		const bytes = encoder.encode(text);
		block.set(bytes.subarray(0, length), offset);
	};
	const octal = (offset: number, length: number, value: number) =>
		put(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
	put(0, 100, path);
	octal(100, 8, 0o644);
	octal(108, 8, 0);
	octal(116, 8, 0);
	octal(124, 12, size > 0o77777777777 ? 0 : size);
	octal(136, 12, 0);
	put(148, 8, "        ");
	put(156, 1, type);
	put(257, 6, "ustar\0");
	put(263, 2, "00");
	let sum = 0;
	for (const byte of block) sum += byte;
	put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return block;
}

function padding(size: number): Uint8Array {
	const rest = size % BLOCK;
	return new Uint8Array(rest === 0 ? 0 : BLOCK - rest);
}

/** Reads a tar archive entry by entry, from a stream of chunks. */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
	const reader = new ByteReader(source);
	let pax: Map<string, string> | null = null;
	for (;;) {
		const block = await reader.exactly(BLOCK);
		if (!block) throw new TarFormatError("The archive ends before its end marker.");
		if (block.every((byte) => byte === 0)) return;
		if (!checksumHolds(block)) throw new TarFormatError("The archive isn't a tar file, or it is damaged.");
		const type = String.fromCharCode(block[156] ?? 0);
		const size = pax?.has("size") ? Number(pax.get("size")) : readOctal(block, 124, 12);
		const path = pax?.get("path") ?? readPath(block);
		if (type === "x" || type === "g") {
			const body = await reader.exactly(size);
			if (!body) throw new TarFormatError("The archive ends part-way through a header.");
			await reader.skip(padding(size).length);
			if (type === "x") pax = parsePax(body);
			continue;
		}
		pax = null;
		if (type !== "0" && type !== "\0") {
			await reader.skip(size + padding(size).length);
			continue;
		}
		let left = size;
		const body: AsyncIterable<Uint8Array> = {
			async *[Symbol.asyncIterator]() {
				while (left > 0) {
					const chunk = await reader.upTo(left);
					if (!chunk) throw new TarFormatError(`The archive ends part-way through ${path}.`);
					left -= chunk.length;
					yield chunk;
				}
			},
		};
		yield { path, size, body };
		// Whatever the caller left unread is skipped.
		await reader.skip(left + padding(size).length);
		left = 0;
	}
}

function checksumHolds(block: Uint8Array): boolean {
	const stored = readOctal(block, 148, 8);
	let sum = 0;
	for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
	return sum === stored;
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
	const text = decoder
		.decode(block.subarray(offset, offset + length))
		.replace(/[\0 ]+$/g, "")
		.trim();
	return text === "" ? 0 : Number.parseInt(text, 8);
}

function readPath(block: Uint8Array): string {
	const field = (offset: number, length: number) => {
		const bytes = block.subarray(offset, offset + length);
		const end = bytes.indexOf(0);
		return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
	};
	const name = field(0, 100);
	const prefix = decoder.decode(block.subarray(257, 262)) === "ustar" ? field(345, 155) : "";
	return prefix ? `${prefix}/${name}` : name;
}

function parsePax(body: Uint8Array): Map<string, string> {
	const records = new Map<string, string>();
	let offset = 0;
	while (offset < body.length) {
		const space = body.indexOf(32, offset);
		if (space === -1) break;
		const length = Number(decoder.decode(body.subarray(offset, space)));
		if (!Number.isInteger(length) || length <= 0) break;
		const record = decoder.decode(body.subarray(space + 1, offset + length - 1));
		const equals = record.indexOf("=");
		if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
		offset += length;
	}
	return records;
}

/** Reads exact amounts of bytes from a stream of chunks of any size. */
class ByteReader {
	private readonly iterator: AsyncIterator<Uint8Array>;
	private buffer: Uint8Array = new Uint8Array(0);
	private done = false;

	constructor(source: AsyncIterable<Uint8Array>) {
		this.iterator = source[Symbol.asyncIterator]();
	}

	/** Fills the buffer with at least one more byte; false at the end of the stream. */
	private async fill(): Promise<boolean> {
		while (!this.done) {
			const next = await this.iterator.next();
			if (next.done) {
				this.done = true;
				return false;
			}
			if (next.value.length === 0) continue;
			this.buffer = this.buffer.length === 0 ? next.value : concat(this.buffer, next.value);
			return true;
		}
		return false;
	}

	/** Exactly `length` bytes, or null when the stream ends first. */
	async exactly(length: number): Promise<Uint8Array | null> {
		while (this.buffer.length < length) if (!(await this.fill())) return null;
		const taken = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return taken;
	}

	/** Between 1 and `length` bytes, or null at the end of the stream. */
	async upTo(length: number): Promise<Uint8Array | null> {
		if (this.buffer.length === 0 && !(await this.fill())) return null;
		const taken = this.buffer.subarray(0, Math.min(length, this.buffer.length));
		this.buffer = this.buffer.subarray(taken.length);
		return taken;
	}

	async skip(length: number): Promise<void> {
		let left = length;
		while (left > 0) {
			const chunk = await this.upTo(left);
			if (!chunk) throw new TarFormatError("The archive ends part-way through a file.");
			left -= chunk.length;
		}
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const joined = new Uint8Array(a.length + b.length);
	joined.set(a);
	joined.set(b, a.length);
	return joined;
}
