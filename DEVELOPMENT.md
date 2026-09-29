# Development

Plain JavaScript (CommonJS) on Node.js. No npm dependencies, no build step, no compiler.
Python 3 (standard library only) packages the VSIX.

## Requirements

- Node.js 18.17 or newer, with npm.
- Python 3.9 or newer, for packaging only.
- No network access or `npm install` needed.

## Commands

```sh
npm test                 # All tests.
npm run test:aliases     # All tests again, with the temp directory behind a symlink.
npm run check            # Syntax and style checks for every JavaScript file.
npm run verify           # The three commands above.
npm run release          # verify, then build and cross-check dist/*.vsix and dist/*-source.zip.
npm run package          # Build the VSIX only, without tests.
npm run benchmark        # Synthetic timings, written to reports/BENCHMARK.json.
npm run clean            # List generated files that clean would delete. Deletes nothing.
npm run clean -- --apply # Delete only those generated files.
```

Run `npm run verify` before calling a change done. Run `npm run release` when packaging changes.

To debug the extension, open this folder in VS Code and press F5.

## Code layout

```text
src/core/        Pure logic. No filesystem, no VS Code.
  note.js          Create and validate a comment ("note"); size limits.
  format.js        Parse and write the .comment file.
  fingerprints.js  Hash a line and its neighbors.
  anchors.js       Find where each note belongs in the current source.
  edits.js         Move notes through live editor edits.
  render.js        Text output for agents (source + comments).
  sidecar.js       The .comment suffix: source path to sidecar path and back.
  text.js          Line splitting, hashing, newline handling.
src/node/        Filesystem access.
  workspace.js     Path safety, size limits, locking, atomic writes, sidecar search.
  service.js       Load, read, write and check: the operations the CLI, MCP and editor call.
  rules.js         The agent instructions, pointed at a CLI path.
src/extension/   VS Code integration.
  extension.js     Activation, presentation refresh, event wiring.
  commands.js      Command Palette commands.
  store.js         Per-document cache and live edit tracking.
  review-model.js   Pure merge/group logic for the Review tree (no vscode, no fs).
  review-tree.js    Review TreeDataProvider, collector and TreeItem classes.
  review-commands.js Commands behind the Review tree (open/hold/edit/reattach/refresh).
  presentation.js  Markers, hover content, diagnostics, sidecar dimming.
  highlights.js    Line highlight decorations.
  drafts.js        The draft editor for writing a comment.
  documents.js     Open-document lookup and sidecar renames.
  settings.js      Reads settings, using defaults from package.json.
src/cli.js       The `sidecar` command.
src/mcp.js       The read-only MCP server (stdio).
integration/     Agent instructions and a VS Code MCP config example.
media/           Syntax highlighting for .comment files; the extension icon and README images.
examples/        A small annotated file to try the extension on.
test/            Tests; test/fixtures holds a golden .comment file.
scripts/         Test runners, syntax and style checks, packaging, benchmark, cleanup.
site/            The website (Astro). Built from the example and the extension's own code.
dist/, reports/  Generated. Ignored by Git.
```

Dependencies point one way: `extension` and the CLI/MCP call `node/service.js`; `service.js` calls `core`. `core` never touches the filesystem or VS Code.

## Rules that must stay true

Each rule has tests. Keep them passing.

- **Source files are never written.** Only `<source>.comment` changes.
- **The MCP server is read-only.** It offers `comment_sidecar_read` and `comment_sidecar_check`. Writes go through the CLI or the editor.
- **Writes need fresh revisions.** Every write passes the source hash and sidecar hash from a recent read. `add` and `reanchor` also pass the exact target line text. Stale input fails.
- **Writes are serialized and atomic.** `withLock` takes `<source>.comment.lock`; `atomicWrite` re-checks the sidecar hash and renames a temp file into place.
- **Unreadable sidecars are never overwritten.** A parse error stops every operation. It is never treated as "no comments".
- **Only three states are saved:** `attached`, `review`, `detached`. `moved` and `ambiguous` are computed on read.
- **Saves only write what changed.** A comment's block is rewritten only when it no longer finds its line on its own (`settleNotes`), so edits elsewhere leave the `.comment` file and its diff alone.
- **No guessing.** Several matching lines give `ambiguous`; the resolver never picks the nearest one.
- **Paths stay inside the workspace.** Symlinked files and links that leave the workspace are rejected. Directory aliases (such as macOS `/var` → `/private/var`) are allowed.
- **Comment text is untrusted.** Hovers use plain text with HTML and commands disabled. Agent output labels comments as data.
- **Settings defaults live in `package.json`.** `settings.js` reads them; do not repeat them in code.

## Code style

- One statement per line. Braced, multi-line `if`, loops and `try`. No nested ternaries. `npm run check` enforces these three.
- One blank line between top-level declarations, between class methods, and between the steps of a function. Keep a value together with the checks on it, and keep a run of guard clauses together.
- Name real decisions (`findMoves`, `isValidEdit`). Do not add wrappers just to shorten code.
- Comments explain a non-obvious reason. Do not narrate the code.
- No new dependencies without a strong reason.
- `.editorconfig` sets indentation, line endings and the final newline in editors that support it.

## Tests

`npm test` runs every `test/*.test.js` file with `node --test`.

| File | Covers |
| --- | --- |
| `format.test.js` | The file format: round trips, golden fixture, limits, malformed and unsupported files, service writes. |
| `core.test.js` | Matching (moved, review, ambiguous, detached), live edit tracking, agent rendering. |
| `service.test.js` | Filesystem safety, revision guards, concurrent writers, CLI and MCP in real subprocesses. |
| `extension.test.js` | Extension code against a **mocked** VS Code API, with a real temp filesystem. |
| `configuration.test.js` | Settings defaults, version consistency, Explorer nesting defaults. |
| `performance.test.js` | Fast paths keep exact results; the cleanup script only deletes generated files. |
| `style.test.js` | The style check: what it accepts and what it flags. |
| `review.test.js` | Review model: grouping, ordering, merge (live-vs-disk, orphan drop). |
| `review-tree.test.js` | Review provider, collector and tooltip (minimal vscode mock + real temp fs). |

`npm run test:aliases` repeats everything with `TMPDIR` behind a directory symlink, to catch path-alias bugs. It is not a macOS desktop test.

What the tests do **not** prove: real VS Code or Cursor rendering, Windows or macOS extension hosts, whether agents follow the instructions, token savings, or safety against a hostile local process.

## Manual check in a real editor

1. Install the VSIX, reload, open `examples/`. Lines 4 and 5 show `◌ comment` and a tint. The hover says **Comment on line N** and shows each note once. The `.comment` file is dimmed and nested under `app.tsx`.
2. Try `markerStyle` `icon` / `off` / `label`, `showMarkers: false`, `highlightStyle` `underline` / `off`, and `showHoverMetadata: true`. Other hovers (TypeScript, other extensions) still appear.
3. Add, edit and delete a multi-line comment. The source file does not change.
4. Insert lines above a comment, edit its line, delete its line, undo, save, reopen. Expect moved, review, detached, then back.
5. Move a commented line with Alt+Up and Alt+Down, then cut it and paste it elsewhere, saving in between. The comment follows each time. Edit a line far from any comment and save: `git diff` shows no change to the `.comment` file.
6. Change the first line of a `.comment` file to `# comment-sidecar v1`. Expect an error in the **Comment Sidecar** output, no markers, and the file unchanged after saving the source.
7. With the source or sidecar unsaved, try to save a draft. It fails without overwriting.
8. Rename a source file in the Explorer. Its `.comment` file follows.
9. Point an agent at the CLI or MCP server and check it reads comments with the source.
10. Open the **Review** activity-bar view. Comments that need attention appear under **Needs review / Detached / Ambiguous** with a workspace-total badge. Click an item to jump to its line; use the inline **Still holds / Update / Reattach** actions and confirm the badge and empty-state message update. Edit an annotated line in an open file and confirm the tree updates live.

## Release

`npm run release` builds `dist/comment-sidecar-<version>.vsix`, `dist/comment-sidecar-<version>-source.zip` and `dist/SHA256SUMS`, then checks:

- both archives pass ZIP integrity checks;
- the source ZIP matches the working tree byte for byte;
- every runtime file in the VSIX matches the source, and every local `require()` resolves;
- the VSIX has no tests, scripts, examples, reports or stale runtime files;
- the VSIX manifest version matches `package.json`.

Rebuilding from an extracted source ZIP produces identical archives.

### Publishing

Publish one file to both stores. Package it with `vsce`, which rewrites the README's relative image links to GitHub URLs so they load on the store pages:

```sh
npx @vscode/vsce package --no-dependencies                # writes comment-sidecar-<version>.vsix
npx ovsx publish comment-sidecar-<version>.vsix -p <token>  # Open VSX
```

- **Visual Studio Marketplace:** upload the file at marketplace.visualstudio.com/manage → zainzafar90 → ⋯ → Update. A version number can be published only once, so bump `package.json` first.
- **Open VSX** (Cursor, VSCodium): the token comes from open-vsx.org → Settings → Access Tokens. To keep it out of your shell history, save it as `OVSX_PAT=<token>` in a `.env` file at the repository root (Git and `vsce` both ignore it), run `set -a; source .env; set +a`, and leave off `-p`. A new version can take a few minutes to appear. The `zainzafar90` namespace shows as unverified until an ownership claim at github.com/EclipseFdn/open-vsx.org is approved.

## Benchmarks

`npm run benchmark` times note creation, parsing, writing, matching, live edit tracking and rendering on 1,000- and 10,000-line files. Results go to `reports/BENCHMARK.json`.

`npm run benchmark -- --baseline /path/to/other/checkout` also times another checkout of this code in the same run.

These are single-process micro-benchmarks, not editor latency. Compare only runs from the same machine.

Known cost: creating a note splits the whole file, so saving many comments in a large file is O(notes × lines).

## Website

`site/` is a separate Astro project with its own `package.json`; the extension itself stays dependency-free.

```sh
cd site
npm install
npm run build    # writes site/dist/
npm run dev      # local preview with reload
npm run deploy   # builds, then deploys site/dist/ to comment-sidecar.zainzafar.net
```

`site/wrangler.jsonc` serves `dist/` as static assets on Cloudflare Workers, with `comment-sidecar.zainzafar.net` as its custom domain. Wrangler asks you to log in to Cloudflare the first time you deploy.

The page imports `src/core` and `src/node` at build time, so the demo's hashes, states and CLI output are what the extension produces for `examples/app.tsx`. The build fails if the demo no longer matches the example. Fonts are self-hosted and preloaded, and the demo only animates transforms, clipping and opacity, so the page has no layout shift.

## References

- VS Code language features, hover and diagnostics: https://code.visualstudio.com/api/language-extensions/programmatic-language-features
- VS Code API at the minimum supported version (1.85): https://raw.githubusercontent.com/microsoft/vscode/1.85.0/src/vscode-dts/vscode.d.ts
- Decorations and hover providers: https://code.visualstudio.com/api/references/vscode-api#DecorationRenderOptions
- Contributed colors and configuration defaults: https://code.visualstudio.com/api/references/contribution-points
- Workspace trust: https://code.visualstudio.com/api/extension-guides/workspace-trust
- VSIX packaging: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Cursor extensions, rules and MCP: https://cursor.com/help/customization/extensions, https://cursor.com/docs/rules, https://cursor.com/docs/mcp
- MCP stdio transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
