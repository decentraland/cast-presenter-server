# Phase 1: Dependency upgrade

## Outcome

Three dependencies are pinned exactly, with one copy each of `@napi-rs/canvas` and `pdfjs-dist` in the tree:
- `@livekit/rtc-node` `1.1.0`;
- `@napi-rs/canvas` `1.0.9`;
- `pdfjs-dist` `6.3.289`, the first line whose optional dependency accepts `@napi-rs/canvas ^1.0.0`. The 4.x line pins `^0.1.65`, which would leave a second canvas copy.

`yarn.lock` stays in yarn v1 format. A real one-page PDF still renders through the built renderer. Typecheck, lint, tests and `docker build .` pass.

## Dependencies

None.

## Write ownership

- `package.json`, `yarn.lock`
- `.eslintrc.json`
- `src/adapters/livekit-publisher/`
- `src/adapters/pdf-renderer/`
- `test/unit/livekit-publisher.spec.ts`
- `test/fixtures/one-slide.pdf` (new)

## Context

Base sha `2c6cdd12e0267306818af9540eede56d67203655`.

**Current versions.** `package.json` has `"@livekit/rtc-node": "^0.13.24"` (locked 0.13.24), `"@napi-rs/canvas": "^0.1.97"` (locked 0.1.97) and `"pdfjs-dist": "^4.7.76"` (locked 4.10.38). `pdfjs-dist@4.10.38` declares `optionalDependencies: { "@napi-rs/canvas": "^0.1.65" }`.

**Target versions, checked on the npm registry on 2026-09-25:**
- `pdfjs-dist@6.3.289` declares `@napi-rs/canvas: ^1.0.0` and `engines.node: >=22.13.0 || >=24`. The Dockerfile base is `node:24-trixie-slim`.
- `@livekit/rtc-node@1.1.0` depends on `@livekit/rtc-ffi-bindings@0.12.73`, with native builds as platform packages.

**Lockfile.** The launch checkout's working-tree `yarn.lock` was rewritten into Berry format by a local yarn 4.14.1 and is **not** committed. Your worktree starts from the committed v1 lock. Every yarn command in this phase is `npx --yes yarn@1.22.22 …`. CI (`.github/workflows/node.yml:19`) and Docker (`Dockerfile:8,15`) run v1 `--frozen-lockfile`.

**How pdfjs is used.** `src/adapters/pdf-renderer/component.ts`:
- `:4` `import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'`
- `:55` `await import('pdfjs-dist/legacy/build/pdf.mjs')`. The project is `module: commonjs` (`tsconfig.json:6`), so this compiles to `require()` of an ESM file, which works only through Node 24's `require(esm)`. That is why jest cannot load pdfjs and no test renders a PDF.
- `:56` `getDocument({ data })`
- `:62-76` `getViewport`, then `createCanvas(width, height)`, then `page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport })`
- `:48` `page.getAnnotations()`, narrowed by the local `PDFLinkAnnotation` type (`:7-20`)
- `:139-141` `destroy()`

pdfjs 5.x introduced the `canvas` render parameter, and later releases may drop `canvasContext`. Follow the 6.3.289 type definitions (`node_modules/pdfjs-dist/types/src/display/api.d.ts`, `RenderParameters`).

**How rtc-node is used.**
- `src/adapters/livekit-publisher/component.ts:2-18`: `Room`, `RoomEvent`, `VideoSource`, `LocalVideoTrack`, `AudioSource`, `LocalAudioTrack`, `TrackPublishOptions`, `TrackSource`, `VideoBufferType`, `VideoCodec`, `VideoFrame`, `AudioFrame`, `RemoteVideoTrack`, `RemoteTrackPublication`, `RemoteParticipant`.
- `VideoStream` and `VideoFrame.convert` in `src/adapters/video-compositor/component.ts:5,305-335` and `src/adapters/camera-overlay-compositor/component.ts:1,87`. Phase 2 reuses both.
- Upstream notes: 0.13.25 split native bindings into `@livekit/rtc-ffi-bindings`; 0.13.33 ships a single CJS build with an ESM wrapper; 1.0.0 is a version-number bump.
- `src/adapters/livekit-publisher/component.ts:446-479` manually closes tracks and calls `ffiHandle.dispose()` because of an old leak. Keep it. If 1.1.0's `Room.disconnect()` already disposes the handle and a second dispose throws, wrap only that call in `try/catch` with `logger.warn`, and record it as a learning.
- `test/unit/livekit-publisher.spec.ts:9-22` fully mocks `@livekit/rtc-node`.

**PPTX.** `src/adapters/pptx-renderer/component.ts:5` also uses `@napi-rs/canvas` (`GlobalFonts`, `createCanvas`, `loadImage`). Canvas 1.0.0 declares no breaking changes. There is no PPTX fixture; typecheck is the gate.

## Steps

1. **Test first.** Create `test/fixtures/one-slide.pdf`: a minimal one-page PDF (US-letter landscape `MediaBox [0 0 792 612]`) whose content stream fills a black rectangle `100 100 200 200 re f`. It can be a hand-written text PDF; pdfjs repairs an inexact xref table.

   Build and run the smoke check from Verification below on the **unchanged** dependencies. It must print `ok 960 …`. Record that baseline in the learning output. It proves the gate works before the upgrade.

2. Run `npx --yes yarn@1.22.22 add --exact @livekit/rtc-node@1.1.0 @napi-rs/canvas@1.0.9 pdfjs-dist@6.3.289`.

3. **Check the install.**
   - `head -2 yarn.lock` prints the v1 header.
   - `package.json` shows the three exact versions with no caret.
   - `find node_modules -name package.json -path '*/@napi-rs/canvas/package.json' | wc -l` prints `1`.
   - `find node_modules -name package.json -path '*/pdfjs-dist/package.json' | wc -l` prints `1`.

   If the lock is in Berry format, restore it with `git -C <checkout> checkout -- yarn.lock` and repeat step 2. If a second canvas copy remains, stop and return `partial` with the output of `npx --yes yarn@1.22.22 why @napi-rs/canvas`.

4. Run `npx --yes yarn@1.22.22 typecheck`.
   - Fix errors inside `src/adapters/livekit-publisher/` by adapting to the new export names or types.
   - Fix errors inside `src/adapters/pdf-renderer/` by following the 6.3.289 types: the `render` parameters, the annotation shape, and the `getDocument` options.
   - If an error appears in any other file, stop and return `partial` with the exact error text, because later phases own those files.

5. Run the tests. If `test/unit/livekit-publisher.spec.ts` fails because the module mock lacks a newly imported symbol, add it to the `jest.mock('@livekit/rtc-node', …)` factory at `:9-22`.

6. Re-run the PDF smoke check on the upgraded dependencies. It must print `ok 960 …` again, and the rendered buffer must still contain the black rectangle. The check tests the pixel at x=240, y=500 of the RGBA output (inside the rectangle after the 960/792 scale and the y-flip) for a red channel `< 50`, and the pixel at x=50, y=50 (outside the rectangle) for an opaque white-ish background: red `> 200`, alpha `255`. A fresh canvas is all zeros, so the background check is what catches a render that silently draws nothing.

7. Add `"root": true` as the first key of `.eslintrc.json`. Without it, ESLint 8 also loads a parent directory's `.eslintrc.json`, and in a plan-plus worktree nested under the main checkout it loads a second `@typescript-eslint` plugin copy and exits 2, breaking `lint` and the pre-commit hook. The user approved this during the run on 2026-09-25.

8. Run `docker build .` from the worktree root. If Docker is unavailable, record it as skipped in the learning output.

## Verification

```sh
head -2 yarn.lock | grep -q 'yarn lockfile v1'
node -e 'const d=require("./package.json").dependencies;if(d["@livekit/rtc-node"]!=="1.1.0"||d["@napi-rs/canvas"]!=="1.0.9"||d["pdfjs-dist"]!=="6.3.289")process.exit(1)'
test "$(find node_modules -name package.json -path '*/@napi-rs/canvas/package.json' | wc -l | tr -d ' ')" = 1
npx --yes yarn@1.22.22 install --frozen-lockfile
npx --yes yarn@1.22.22 lint:fix && npx --yes yarn@1.22.22 typecheck && npx --yes yarn@1.22.22 lint && npx --yes yarn@1.22.22 test
npx --yes yarn@1.22.22 build
node -e 'const {createPdfRendererComponent}=require("./dist/adapters/pdf-renderer");const r=createPdfRendererComponent().createRenderer();r.initialize(require("fs").readFileSync("test/fixtures/one-slide.pdf")).then(()=>r.renderSlide(0)).then(s=>{const px=(500*s.width+240)*4,bg=(50*s.width+50)*4;if(s.width!==960||s.buffer.length!==s.width*s.height*4||s.buffer[px]>=50||s.buffer[bg]<=200||s.buffer[bg+3]!==255){console.error("bad",s.width,s.height,s.buffer[px]);process.exit(1)}console.log("ok",s.width,s.height);r.destroy()})'
docker build .
```

## Completion criteria

- The three dependencies are exact-pinned, there is one copy each of canvas and pdfjs, and `yarn.lock` is v1 and passes `--frozen-lockfile`.
- The PDF smoke check passed both before (baseline) and after the upgrade.
- Typecheck, lint and tests pass. `docker build .` passes or is recorded as skipped with the reason.
- The diff touches only the owned paths.

## Learning output

Write only `docs/specs/loom-overlay-runtime/learnings/phase-1.json` using plan-plus `docs/learning-schema.md` (schema v2, `scope: "project"`). Record the smoke baseline, and every pdfjs 6 or rtc-node 1.x API break with its fix as `kind: compatibility`.
