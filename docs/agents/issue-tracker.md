# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `bhfgeeichsolo3047-byte/dsh-antigravity-bridge`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..." / --remove-label "..."
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Editing an issue body

Try the `deck_issue_*` tools first. On the GitHub backend a whole-body replacement is
**not supported** — it returns `{"ok":false,"status":"unsupported","reason":"backend-unsupported"}`,
and passing the `body.digest` from `deck_issue_get` does not change that. A failure here is
not something to hide: record it, then fall back.

Fallback: `gh issue edit <n> --body-file <path>`. It is a **fallback, not the default**, and
only three conditions make it safe:

1. **Try the deck tool first and record the failure.** Don't reach for `gh` on the assumption
   that the deck path will fail — the fallback is unlocked by an observed `backend-unsupported`,
   not by expectation.
2. **Re-read the current body immediately before writing.** `gh issue view <n> --json body`, or
   `deck_issue_get` with `body: "full"` (full text in `data.body.chunks`, digest in
   `data.body.digest`). Never edit against a body you read earlier in the session — another
   session may have edited it since, and a whole-body write overwrites that edit silently.
3. **Read back after writing.** Confirm the `<!-- DSH-IDEMPOTENCY-KEY: ... -->` line still
   leads the body and the Chinese text is not mangled, then diff what landed against what you
   wrote (`gh issue view <n> --json body` against your source file). Only the trailing newline
   should differ.

## Pull requests as a request surface

**PRs as a request surface: no.**

When set to **yes**, PRs run through the same labels and states as issues, using `gh pr` equivalents in place of `gh issue` (`gh pr view`, `gh pr comment`, `gh pr list`, `gh pr close`), with the one difference that a PR is fetched with `gh pr view <number> --comments` and its labels come from the same field.

Leave this **no** unless the user asks for external PRs to enter the triage queue; with it off, pull requests are not a request surface and the skills do not read or label them.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue carrying `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`); add it to the map with `gh`'s sub-issues (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, fall back to a task list in the map body and put the map number in the child's body. **Blocking**: GitHub's **native issue relationships** — the canonical, UI-visible blocked-by dependency. Add it with `gh api .../dependencies/blocked_by -X POST -F issue_id=<child database id>` (or the GraphQL `addBlockedBy` mutation); the child is blocked by the blocker. A body `Blocked by: #n, #n` line is a fallback only where relationships aren't available. A ticket is unblocked when every blocker is closed; the **frontier** is the open, unblocked, unclaimed children.
- **Blocking edges**: record with the native issue relationship (see Child ticket); a body `Blocked by: #n, #n` line is the fallback only where relationships aren't available.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the sub-issues), drop any with an open blocker (relationship, or `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.