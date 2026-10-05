# AI Agent Instructions

## Project Context

See [docs/ai-agent-context.md](docs/ai-agent-context.md) for service architecture, tech stack, key concepts, and API surface.

For broader Decentraland contributor guidelines, see <https://docs.decentraland.org/llms.txt>

## Skills

This project uses skills from [decentraland/ai-toolkit](https://github.com/decentraland/ai-toolkit). Load the relevant skill **before** making changes:

| Skill | When to load |
|---|---|
| `dcl-testing` | Writing, modifying, or reviewing `*.spec.ts` / `*.test.ts` files |
| `dcl-wkc-components` | Working on files in `src/components.ts`, `src/adapters/`, `src/logic/`, `src/controllers/`, `src/types.ts`, or any file importing from `@well-known-components` |

## Git Hooks

Pre-commit and pre-push hooks are enforced via `simple-git-hooks` + `nano-staged`:

- **Pre-commit**: Runs `eslint` and `prettier --check` on staged `*.{js,ts}` files
- **Pre-push**: Runs `yarn typecheck && yarn test`

Fix lint issues before committing: `yarn lint:fix`

## Gotchas

- **Yarn v1 only.** A global `yarn` may be Yarn 4, which rewrites `yarn.lock` into Berry format. Run scripts as `npx --yes yarn@1.22.22 <script>`. The pre-push hook calls bare `yarn`, so push with a v1 `yarn` shim first on `PATH`.
- **Sidecar checks.** Verify Go changes under `sidecar/` with `(cd sidecar && GOTOOLCHAIN=local go vet ./... && GOTOOLCHAIN=local go test -race ./...)`.
- **Local v2 runs.** With `CLIENT_COMPOSITION_ENABLED=true`, set `SIDECAR_BINARY_PATH` to a binary built with `(cd sidecar && CGO_ENABLED=0 go build -o cast-sidecar ./cmd/cast-sidecar)`. The default `/usr/local/bin/cast-sidecar` exists only in the Docker image.

## Testing

- **Unit tests** (`test/unit/`): Required for all business logic components
- **Integration tests** (`test/integration/`): Required for all HTTP endpoints
- Load the `dcl-testing` skill for full testing standards

## Development Commands

| Task | Command |
|---|---|
| Install dependencies | `yarn install` |
| Build | `yarn build` |
| Run dev server | `yarn start:dev` |
| Run all tests | `yarn test` |
| Run unit tests | `yarn test test/unit` |
| Run integration tests | `yarn test test/integration` |
| Lint (check) | `yarn lint` |
| Lint (fix) | `yarn lint:fix` |
| Format (check) | `yarn format:check` |
| Format (fix) | `yarn format:fix` |
| Type check | `yarn typecheck` |
