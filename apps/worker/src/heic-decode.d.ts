// Types for `heic-decode`, which ships none. The default export decodes the first image of a HEIC
// file to RGBA pixels; `all` reads every image's size first and decodes one only when asked.
declare module "heic-decode" {
	type Decoded = { width: number; height: number; data: Uint8ClampedArray };
	type Undecoded = { width: number; height: number; decode(): Promise<Decoded> };
	function decode(input: { buffer: Uint8Array | ArrayBuffer }): Promise<Decoded>;
	namespace decode {
		function all(input: { buffer: Uint8Array | ArrayBuffer }): Promise<Undecoded[] & { dispose(): void }>;
	}
	export default decode;
}
