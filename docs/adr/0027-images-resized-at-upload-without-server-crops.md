# Images are resized at upload, with no crops made on the server

When a Media image is uploaded, a Node worker job creates a fixed set of widths (320, 640, 960, 1280, 1920 and 2560, never larger than the original), each in AVIF and WebP. The original format stays as the fallback, and the renderer outputs them through `<picture>` and `srcset`. The original is served until the job finishes. The server never crops: when a design shows an image at a different shape, CSS fills the box and the image's Focal point decides which part stays visible. Adding a width later means re-running a job over the library.

## Considered Options

- **Resize on request through a separate resizing service**: flexible, but it adds one more service to every Install, and without a strict allow-list anyone can request endless sizes.
- **Resize on request in the Bun web process**: the image library is known to break under Bun in some Docker images, and it would put slow CPU work in the request path.
- **Cropped files for each aspect ratio a Template uses**: more files and a reprocessing job every time a design changes. The Focal point covers the same need.
