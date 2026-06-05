# Phase 1: Overlay config plumbing

## Dependencies

- None.

## Goal

Accept `overlayCorner` and `overlaySize` on the `POST /presentations` payload, validate them, and store them on the `PresentationSession`. No behavioural change yet — later phases consume these fields.

## Files to modify (3)

| File | Change |
|------|--------|
| `src/logic/presentation-manager/types.ts` | Add `OverlayCorner`, `OverlaySize`, `OverlayConfig` types; extend `PresentationSession`; extend `createPresentation()` signature. |
| `src/logic/presentation-manager/component.ts` | Accept `overlayConfig` in `createPresentation()` and store it on the session record. |
| `src/controllers/handlers/create-presentation-handler.ts` | Parse + validate `overlayCorner` / `overlaySize` from both JSON and multipart bodies; forward to `createPresentation()`. |

## Steps

### 1. `src/logic/presentation-manager/types.ts` — Add overlay types and extend `PresentationSession`

At the top of the file, after the existing imports (last `import` is at line 3), insert the new types. Then extend `PresentationSession` (currently ends at line 19) with the new optional field. AFTER for the types insertion:

```typescript
/** Where the camera circle is drawn on the slide. */
export type OverlayCorner = 'TL' | 'TR' | 'BL' | 'BR'

/** Discrete size buckets: 15% / 20% / 25% of the slide width. */
export type OverlaySize = 'small' | 'medium' | 'large'

/** Per-session camera-overlay configuration; immutable once the session starts. */
export interface OverlayConfig {
  corner: OverlayCorner
  size: OverlaySize
}
```

Then inside the `PresentationSession` interface, at line 18 (right before the closing `}` of the interface, currently after the `videoState` field), add:

```typescript
  /** Camera-overlay layout for this session. Undefined disables the overlay entirely. */
  overlayConfig?: OverlayConfig
```

### 2. `src/logic/presentation-manager/types.ts` — Extend `IPresentationManager.createPresentation` signature

The `createPresentation` method is declared at line 81-87. Add an `overlayConfig` optional parameter after `fileName`. AFTER:

```typescript
  createPresentation(
    fileBuffer: Buffer,
    fileType: FileType,
    livekitToken: string,
    livekitUrl: string,
    fileName?: string,
    overlayConfig?: OverlayConfig
  ): Promise<PresentationInfo>
```

Update the JSDoc just above (lines 67-80) by adding a new `@param overlayConfig - Camera-overlay layout (corner + size); omit to disable the overlay.` line right after the existing `@param fileName` line.

### 3. `src/logic/presentation-manager/component.ts` — Accept and store `overlayConfig`

The `createPresentation` function signature is at lines 235-241. Extend it with the new parameter, matching the interface. The function reads:

```typescript
async function createPresentation(
  fileBuffer: Buffer,
  fileType: FileType,
  livekitToken: string,
  livekitUrl: string,
  fileName?: string,
  overlayConfig?: OverlayConfig
): Promise<PresentationInfo> {
```

Add the corresponding `import` for `OverlayConfig` to the existing types import at the top of the file (grep for `from './types'` near the top — the import path is `./types`).

Then, in the session object literal (the `const session: InternalSession = { … }` block currently at lines 327-356), add `overlayConfig` as a new field right after `videoState: 'idle'` (line 339). AFTER:

```typescript
        videoState: 'idle',
        overlayConfig,
```

If `InternalSession` is declared as a separate `interface` in this file (not the public `PresentationSession`), grep for `interface InternalSession` and add `overlayConfig?: OverlayConfig` there too. Otherwise the extension on `PresentationSession` in step 1 already covers it.

### 4. `src/controllers/handlers/create-presentation-handler.ts` — Parse + validate overlay fields (JSON path)

Inside the `if (contentType.includes('application/json'))` branch (lines 44-83), right after `const lkUrl = typeof body.livekitUrl === 'string' ? body.livekitUrl : undefined` at line 64, add the parse + validate logic. AFTER (the new lines go immediately *before* the existing `if (!url)` check at line 66):

```typescript
      const overlayConfig = parseOverlayConfigFromBody(body)
```

### 5. `src/controllers/handlers/create-presentation-handler.ts` — Parse + validate overlay fields (multipart path)

Inside the `else if (contentType.includes('multipart/form-data'))` branch (lines 84-109), right after the `const lkUrl = result.fields.livekitUrl || null` at line 100, add:

```typescript
      const overlayConfig = parseOverlayConfigFromFields(result.fields)
```

### 6. `src/controllers/handlers/create-presentation-handler.ts` — Forward `overlayConfig` to the manager

The `presentationManager.createPresentation(...)` call is at lines 130-136. The branches above each set their own `overlayConfig`; declare it once at the outer scope so both branches assign to the same variable. Replace the existing block of declarations at lines 39-42 (the four `let` declarations) by adding one more line so the block reads:

```typescript
    let fileBuffer: Buffer
    let fileName: string
    let livekitToken: string
    let livekitUrl: string
    let overlayConfig: OverlayConfig | undefined
```

Then update the call at lines 130-136 to pass it as the sixth argument:

```typescript
    const info = await presentationManager.createPresentation(
      fileBuffer,
      fileType,
      livekitToken,
      livekitUrl,
      rawFileName,
      overlayConfig
    )
```

### 7. `src/controllers/handlers/create-presentation-handler.ts` — Add the two parser helpers

Insert two new private helpers near `validateLivekitUrl` (currently at lines 11-24). Place them immediately after `validateLivekitUrl` so the imports and helper block read top-to-bottom. AFTER:

```typescript
const VALID_CORNERS: ReadonlySet<string> = new Set(['TL', 'TR', 'BL', 'BR'])
const VALID_SIZES: ReadonlySet<string> = new Set(['small', 'medium', 'large'])

function parseOverlayConfigFromBody(body: Record<string, unknown>): OverlayConfig | undefined {
  const corner = typeof body.overlayCorner === 'string' ? body.overlayCorner : undefined
  const size = typeof body.overlaySize === 'string' ? body.overlaySize : undefined
  if (!corner && !size) return undefined
  if (!corner || !size) {
    throw new ValidationError('overlayCorner and overlaySize must both be set, or both omitted')
  }
  if (!VALID_CORNERS.has(corner)) {
    throw new ValidationError(`overlayCorner must be one of TL, TR, BL, BR (got ${corner})`)
  }
  if (!VALID_SIZES.has(size)) {
    throw new ValidationError(`overlaySize must be one of small, medium, large (got ${size})`)
  }
  return { corner: corner as OverlayCorner, size: size as OverlaySize }
}

function parseOverlayConfigFromFields(fields: Record<string, string>): OverlayConfig | undefined {
  return parseOverlayConfigFromBody(fields as unknown as Record<string, unknown>)
}
```

Add the type imports at the top of the file (the existing imports start at line 1). Add a new import line after the last existing import:

```typescript
import type { OverlayConfig, OverlayCorner, OverlaySize } from '../../logic/presentation-manager/types'
```

(Path is relative from `src/controllers/handlers/`.)

## Edge cases

| Scenario | Handling |
|----------|----------|
| Both `overlayCorner` and `overlaySize` omitted | `overlayConfig = undefined`. Overlay disabled. |
| One omitted, the other present | `ValidationError` → HTTP 400. |
| Invalid corner value (e.g. `"middle"`) | `ValidationError` → HTTP 400. |
| Invalid size value (e.g. `"xlarge"`) | `ValidationError` → HTTP 400. |
| Multipart body sends a non-string value (e.g. numeric corner) | The `typeof === 'string'` guard already rejects it; the `&& !size` branch then throws "must both be set". |

## Verification

```bash
yarn typecheck
yarn lint
yarn test
```

Plus a manual `curl` smoke test (must succeed and not error):

```bash
curl -X POST http://localhost:3000/presentations \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/test.pdf","livekitUrl":"wss://x","livekitToken":"y","overlayCorner":"BR","overlaySize":"medium"}'
```

A second curl with an invalid corner must return HTTP 400 with an `error` body mentioning `overlayCorner`.

## Learnings (post-execution)

After running this phase, append to `learnings/phase-1.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
