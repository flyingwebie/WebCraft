// Types for `heic-decode`, which ships none: it decodes the first image of a HEIC file to RGBA pixels.
declare module "heic-decode" {
	type Decoded = { width: number; height: number; data: Uint8ClampedArray };
	function decode(input: { buffer: Uint8Array | ArrayBuffer }): Promise<Decoded>;
	export default decode;
}
