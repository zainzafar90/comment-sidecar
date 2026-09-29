# Review tree walkthrough

A manual, end-to-end demo of the Review view. Run it in VS Code / Cursor with
the extension installed (or from source with `npm run package`).

## Setup

1. Open `examples/app.tsx`. Lines 4 and 5 already carry comments (see
   `examples/app.tsx.comment`).
2. Open the **Comment Sidecar** view in the activity bar.

## The three states

1. **Needs review** — edit line 4 (for example, change `loading` to `pending`).
   Its marker turns amber and the comment appears under **Needs review** in the
   Review view. Click the item to jump to the line, then choose **Still holds**
   to confirm the comment still applies.
2. **Detached** — delete line 5. Its comment moves to **Detached**. Click it,
   place the cursor on a sensible line, then choose **Reattach** (confirm the
   toast) to re-anchor it.
3. **Ambiguous** — duplicate a commented line so two identical lines exist. The
   comment moves to **Ambiguous** and refuses to guess. Reattach it to the
   intended line.

## Checks

- The activity-bar badge shows the workspace total.
- An empty workspace shows the welcome message ("No comments need review…").
- Source files are never modified — only the sibling `.comment` files change.
- `sidecar check` (or the **Check Workspace** command) agrees with the Review
  view's counts.
