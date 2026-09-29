<p align="center">
  <img src="media/banner.png" alt="Comment Sidecar" width="100%">
</p>

<p align="center">
  <strong>Explain a line of code without touching the code.</strong><br>
  Comments live in a <code>.comment</code> file beside your source, appear right on the line in your editor,<br>
  follow that line as the code moves, and can be read by AI agents.
</p>

<p align="center">
  <a href="#install">Install</a> &nbsp;·&nbsp;
  <a href="#quick-start">Quick start</a> &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a> &nbsp;·&nbsp;
  <a href="#for-ai-agents">For AI agents</a> &nbsp;·&nbsp;
  <a href="#commands">Commands</a> &nbsp;·&nbsp;
  <a href="#settings">Settings</a> &nbsp;·&nbsp;
  <a href="#faq">FAQ</a>
</p>

<br>

<img src="media/readme/hover.png" alt="An editor showing app.tsx. Lines 4 and 5 are tinted blue and end with a dashed ring marker that reads “comment”. The pointer rests on line 4, and a card above it says: Comment on line 4 — Wait for session restoration before choosing a screen." width="100%">

## Why a sidecar?

| Your source stays clean | Comments keep up | Agents can read them |
| --- | --- | --- |
| Source files are never written. Notes about *why* a line exists stay out of the code, and are reviewed as their own file. | Each comment follows its line as code moves around it, and asks for a review when the line itself changes. | A CLI and an MCP server hand an agent the code and its comments in a single read. |

## Install

**VS Code:** install [Comment Sidecar](https://marketplace.visualstudio.com/items?itemName=zainzafar90.comment-sidecar) from the Marketplace, or run:

```sh
code --install-extension zainzafar90.comment-sidecar
```

**Cursor, VSCodium and other editors that use Open VSX:** search for **Comment Sidecar** in the Extensions view, or install it from [Open VSX](https://open-vsx.org/extension/zainzafar90/comment-sidecar).

**From source:** `npm run release` writes `dist/comment-sidecar-<version>.vsix`; install it with **Extensions → … → Install from VSIX**. Building needs Node.js 18.17+ and Python 3.9+; see [DEVELOPMENT.md](DEVELOPMENT.md).

## Quick start

1. Open a file and **save** it.
2. Put the cursor on a line and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>;</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>;</kbd> on macOS).
3. A draft opens beside your code. Write why the line is the way it is, then **save the draft**.

The line now ends in `◌ comment`. Hover it to read the note. Only the sidecar was written (`app.tsx.comment` for `app.tsx`); your source file is untouched.

> Cloned this repository? Open the `examples` folder and hover lines 4 and 5 of `app.tsx`.

<table>
  <tr>
    <td width="50%"><img src="media/readme/tracking.png" alt="Three new lines were added near the top of app.tsx. The commented line moved from line 4 to line 7, and its marker moved with it."></td>
    <td width="50%"><img src="media/readme/review.png" alt="Line 7 was edited to add “|| !theme”. Its highlight and marker turned amber, and the hover card ends with “Needs review”."></td>
  </tr>
  <tr>
    <td valign="top"><strong>Follows its line.</strong> Add or remove code above a comment and it moves with its line.</td>
    <td valign="top"><strong>Flags what changed.</strong> Edit the line itself and its comment turns amber until you confirm the note still holds.</td>
  </tr>
</table>

## How it works

<img src="media/readme/sidecar.png" alt="The file app.tsx.comment. Numbered badges mark its parts: 1, a header with the format version and file names; 2, the line number, a stable ID and the comment's state; 3, fingerprints — hashes of the line and its neighbors, never a copy of the code; 4, the comment itself in plain text." width="100%">

Every source file can have one sidecar: `app.tsx` → `app.tsx.comment`. For each comment it stores the line number and *fingerprints* (hashes of the line and the two lines on either side of it), never the code itself. When the source changes, the fingerprints decide where each comment belongs now:

| Status | What happened | In the editor |
| --- | --- | --- |
| **Attached** | The line is where it was. | `◌ comment` |
| **Moved** | Lines were added or removed above it, or it was moved or cut and pasted, and it followed. | `◌ comment` |
| **Needs review** | The line itself was edited, or only the line (not its neighbors) still matches. | `◌ comment !` in amber |
| **Ambiguous** | Several lines match, so it won't guess. | A warning, no marker |
| **Detached** | The line was deleted, split or rewritten. | A warning, no marker |

Resolve the last three with **Mark Comment Reviewed** or **Reattach Comment to This Line**. *Attached* means the position still matches, not that the note is still true.

A `.comment` file changes only when a comment, or the code right around it, changes. Edits elsewhere in the file leave it untouched, so its diff stays small.

Renaming a file in the editor renames its `.comment` file too. Renames made outside the editor aren't tracked; **Check Workspace** reports the orphaned sidecar. The file format is specified in [FORMAT.md](FORMAT.md).

## For AI agents

<img src="media/readme/agents.png" alt="A terminal running “sidecar read app.tsx --start 4 --end 5”. The output interleaves each source line with its comment and marks comments as repository data, not instructions. Below it are the two read-only MCP tools: comment_sidecar_read and comment_sidecar_check." width="100%">

Agents don't see editor decorations, so give them a tool and tell them to use it.

1. **Instructions.** Run **Comment Sidecar: Copy Agent Instructions** and paste the result into your `AGENTS.md` or a Cursor rule. It explains how to read and write comments, and what a good one is: a non-obvious rule or reason, in one or two sentences, on the line that enforces it.
2. **MCP server.** Run **Comment Sidecar: Copy Cursor MCP Configuration** and merge the entry into `.cursor/mcp.json`. For VS Code, start from [`integration/vscode-mcp.example.json`](integration/vscode-mcp.example.json).

| Tool | What it does |
| --- | --- |
| `comment_sidecar_read` | Returns source and comments together, with the original line numbers. |
| `comment_sidecar_check` | Lists comments that need review, are ambiguous, or are detached. |

The MCP server is read-only: it can't change any file. To add or edit a comment, an agent runs the `sidecar` CLI, which the copied instructions describe.

Copied configurations point at the installed extension, so copy them again after an update. Comment text always reaches the agent as untrusted data, never as instructions.

<details>
<summary><strong>Using the CLI directly</strong></summary>
<br>

The copied instructions already contain the full path to the CLI on your machine. From a clone of this repository:

```sh
node src/cli.js read examples/app.tsx --start 1 --end 8                   # source and comments
node src/cli.js read examples/app.tsx --start 1 --end 8 --mode comments   # comments only
node src/cli.js check examples/app.tsx                                    # problems only
node src/cli.js --help                                                    # write commands
```

Pass `--root /path/to/repo` to work on another repository. `read` prints the original line numbers and two revision hashes. Every write needs both hashes from a fresh read, so an agent can't overwrite changes it hasn't seen; `add` and `reanchor` also need the exact text of the target line.

</details>

## Commands

Everything lives in the Command Palette under **Comment Sidecar:**.

| Command | What it does |
| --- | --- |
| **Add Comment at Line** | Opens a draft for the current line. <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>;</kbd> · <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>;</kbd> |
| **Edit Comment** | Opens the comment on the current line as a draft. |
| **Delete Comment** | Deletes it after you confirm. |
| **Mark Comment Reviewed** | Confirms that a comment needing review still fits its line. |
| **Reattach Comment to This Line** | Moves a lost or misplaced comment to the current line. |
| **List File Comments** | Jumps to any comment in the file. |
| **Open Annotated Preview** | Shows the source with its comments inline. |
| **Copy Annotated Selection** | Copies source and comments with line numbers. |
| **Open .comment Patch** | Opens the raw sidecar file. |
| **Check Workspace** | Reports every comment that needs attention. |
| **Copy Agent Instructions** | See [For AI agents](#for-ai-agents). |
| **Copy Cursor MCP Configuration** | See [For AI agents](#for-ai-agents). |

The **Review** activity-bar view groups comments that need attention into
**Needs review**, **Detached**, and **Ambiguous**, with a workspace-total badge.
Click an item to jump to its line; use the inline actions **Still holds**,
**Update**, and **Reattach** to resolve it. **Refresh Review** re-scans the
workspace.

## Settings

| Setting | Default | Options |
| --- | --- | --- |
| `commentSidecar.markerStyle` | `label` | `label` shows `◌ comment` · `icon` shows `◌` · `off` hides it |
| `commentSidecar.showMarkers` | `true` | `false` hides markers in every style |
| `commentSidecar.highlightStyle` | `line` | `line` (tint and left edge) · `underline` · `off` |
| `commentSidecar.showHoverMetadata` | `false` | `true` adds the comment's ID, status and reason to the hover |

<details>
<summary><strong>Colors</strong></summary>
<br>

Every color is a theme token. Override any of them in your settings, for example:

```json
{
  "workbench.colorCustomizations": {
    "commentSidecar.highlightBackground": "#4CA6FF12",
    "commentSidecar.highlightBorder": "#71B7FF88",
    "commentSidecar.reviewBackground": "#E6AF2E16",
    "commentSidecar.reviewBorder": "#E6AF2EA0",
    "commentSidecar.sidecarForeground": "#7F93B2"
  }
}
```

</details>

## FAQ

<details>
<summary><strong>Does it ever change my source files?</strong></summary>
<br>

No. Only `.comment` files are written. A `.comment` file that can't be read is reported as an error; it is never treated as empty or overwritten.

</details>

<details>
<summary><strong>Why won't my comment save?</strong></summary>
<br>

Save the source file first, and its `.comment` file if it's open. A draft is refused when either one changed after the draft opened, so nothing you haven't seen gets overwritten. Adding and editing also need a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust); untrusted workspaces are read-only.

</details>

<details>
<summary><strong>Should I commit <code>.comment</code> files?</strong></summary>
<br>

Yes. They're plain text and belong with the code they describe, so they travel through branches and code review like everything else. A pull request shows comment changes as the `.comment` file's own diff.

</details>

<details>
<summary><strong>Can I hide <code>.comment</code> files?</strong></summary>
<br>

By default each one is dimmed and nested, collapsed, under its source file in the Explorer. The extension does this by setting VS Code defaults:

```json
{
  "explorer.fileNesting.enabled": true,
  "explorer.fileNesting.expand": false,
  "explorer.fileNesting.patterns": { "*": "${capture}.comment" }
}
```

These settings are VS Code-wide, so the built-in nesting (such as lockfiles under `package.json`) shows up too. Anything you set yourself wins; if you define `explorer.fileNesting.patterns`, add `"*": "${capture}.comment"` to it. To hide sidecars completely, add `"files.exclude": { "**/*.comment": true }`. Hovers, markers and agent tools keep working.

</details>

<details>
<summary><strong>Which languages does it support?</strong></summary>
<br>

Any UTF-8 text file. Comments attach to physical lines rather than symbols, so there's no parser or language server involved.

</details>

<details>
<summary><strong>Does anything leave my machine?</strong></summary>
<br>

No. There is no network access, telemetry or model call, and hovers are computed locally. An agent you connect may send the tool output to its model; that part is up to the agent. See [SECURITY.md](SECURITY.md).

</details>

<details>
<summary><strong>What are the limits?</strong></summary>
<br>

- Source and `.comment` files: up to 2 MiB each.
- Up to 1,000 comments per file and 16,000 characters per comment.
- Dependency, build and version-control folders (`node_modules`, `dist`, `.git`, …) are skipped.

</details>

## Learn more

- [FORMAT.md](FORMAT.md): the `.comment` file format.
- [SECURITY.md](SECURITY.md): trust boundaries and what is not protected.
- [DEVELOPMENT.md](DEVELOPMENT.md): building, testing, releasing and the code layout.

<br>

<p align="center">
  <img src="media/icon.png" alt="" width="44"><br>
  <sub>MIT License · Comments next to code, not inside it.</sub>
</p>
