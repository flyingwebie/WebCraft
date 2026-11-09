#!/bin/sh
# Run inside an image build, after `bun install --production`: removes packages that some dependencies
# list as their own dependencies but that neither process ever loads when it runs (the admin's
# bundler, CSS and component tooling, type definitions, better-auth's schema generator), and native
# files built for musl, which these Debian images don't use. The Compose smoke test
# (`bun run test:deploy`) starts both images and loads the admin, so a package removed here that is
# needed after all shows up there.
set -eu
cd "${1:-.}/node_modules/.bun"
rm -rf \
	@babel+* @esbuild+* @rolldown+* @tailwindcss+* @tanstack+router-generator@* @tanstack+router-plugin@* \
	@tanstack+start-plugin-core@* @ts-morph+* @types+* @vitejs+* bun-types@* caniuse-lite@* drizzle-kit@* \
	esbuild@* lightningcss* prettier@* rolldown@* shadcn@* tailwindcss@* ts-morph@* typescript@* vite@* \
	@img+sharp-libvips-linuxmusl-* @img+sharp-linuxmusl-*
