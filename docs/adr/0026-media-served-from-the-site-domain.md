# Media is served from the Site's own domain

Every Media file is served from the Site's own domain on a reserved path (`/_media/…`). The Install streams it from storage, which is local disk or an S3-compatible bucket, chosen once per Install. File names carry a content hash, so the page cache or a CDN in front of the Site can cache them forever. Form uploads use the same storage but never get a public path: they are streamed only through the admin, after the same `can()` check that lets someone see that Form's Submissions.

This keeps the strict `script-src 'self'` / `img-src 'self'` policy free of extra hosts, makes Staging and custom domains work with no setup, and means switching storage never changes a published URL.

## Considered Options

- **Serve straight from the bucket or a storage CDN domain**: less work for the web process, but every Site's CSP would have to list that host, URLs would change when storage changes, and private files would need signed URLs with their own expiry rules.
- **Short-lived signed bucket links for Form uploads**: they don't work on local disk, and downloads would skip the Audit log.
