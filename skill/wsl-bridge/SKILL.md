---
name: wsl-bridge
description: Collaborate on local WSL projects through the WSL Web Bridge browser extension and local Go bridge server. Use whenever the user asks to inspect, search, debug, edit, test, or run commands in a local WSL workspace via web chat, mentions WSL Web Bridge, or sends [WSL ...] execution/read results.
---
# WSL Bridge

Model-agnostic protocol for collaborating on local WSL codebases from web chat via the WSL Web Bridge Chrome/Edge extension (v3.1).

## When to Use

- The user wants to read, search, modify, or test files in a local WSL project from browser chat.
- The user pastes `[WSL 文件读取结果]`, `[WSL 命令执行结果]`, `[WSL 文件写入完成]`, or `[WSL 补丁已应用]` feedback (including virtual file attachments such as `wsl-read-*.txt` or `wsl-cmd-*.txt`).
- The user asks to work on a local WSL workspace without cloning it to a cloud repo.

## Workflow

1. Inspect before editing. Prefer read-only blocks (`# @wsl-read` and allowlisted read-only `# @wsl-cmd`) first so the extension's L2 read-only auto-loop can gather context automatically.
2. Dual-channel transfer: in v3.1 default attachment mode, `# @wsl-read` and oversized command/diff outputs are uploaded as virtual `.txt` file attachments while the chat bubble keeps only a concise file index. You may batch up to 8 to 12 medium source files in a single `# @wsl-read` block (within ~512 KB total) instead of splitting into tiny turns; for huge files, locate lines with `rg -n` / `grep -n` first and read `path:start-end` slices. If the user is in `text_only` fallback mode, keep batches to 2 to 3 files.
3. Emit at most one focused read/diagnostic block per turn when waiting on exploration output; when ready to apply coordinated multi-file edits, you may emit the edit cards together (the extension accumulates results across cards and offers one-click sequential batch execution plus per-card Undo).
4. Propose targeted edits using `# @wsl-patch:` for existing files (Go v3.0+ supports exact + line-normalized tolerant matching) and `# @wsl-write:` only for new files or complete rewrites.
5. After edits are applied, follow up with a concise verification command (syntax check, unit test, build, or `git diff`).

## Protocol Formats

Always place the directive on the very first line inside a fenced code block so the extension recognizes it and renders the action card.

### Read Files (Auto-runs in L2 mode, server-side line slicing)

List one workspace-relative file path per line (append `:start-end` to read a specific line range):

```text
# @wsl-read
backend/src/app.py:1-120
frontend-v5/src/index.ts:1-80
```

### Run WSL Commands

Use `# @wsl-cmd` (optionally with `cwd=<subdir>` to run inside a subdirectory):

```bash
# @wsl-cmd cwd=backend
git status -sb
```

Read-only commands allowed for automatic execution in L2 mode include simple single-stage or piped read commands using `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `tree`, `rg`, `grep`, `find` (without `-exec`/`-delete`), `sort`, `uniq`, `cut`, `awk`, `sed` (without `-i`), `du`, `df`, `jq`, `fd`, `bat`, and read-only `git` subcommands (`status`, `diff`, `log`, `show`, `branch`, `ls-files`, `grep`, `blame`, `tag`) without unquoted shell redirections or chaining (`&&`, `||`, `;`, `>`, `<`, `$(`, backticks).

### Patch Existing Files (Always requires manual approval, supports Undo)

Use `# @wsl-patch: <relative_path>` with `SEARCH` / `REPLACE` blocks:

```text
# @wsl-patch: src/example.py
<<<<<<< SEARCH
old_line()
=======
new_line()
>>>>>>> REPLACE
```

### Write Full Files (Always requires manual approval, supports Undo)

Use `# @wsl-write: <relative_path>` followed by the full file content:

```python
# @wsl-write: src/new_module.py
def hello():
    return "ok"
```

### Apply Unified Diff (Always requires manual approval)

Use `# @wsl-diff` followed by a standard `git diff` patch when updating multiple files atomically.

## Gotchas

- In attachment mode, keep each `# @wsl-read` batch within roughly 8 to 12 medium files (max 25 paths / ~512 KB bundle budget) and use `path:start-end` slices for very large files; in `text_only` fallback mode, keep batches to 2 to 3 files.
- Keep `# @wsl-cmd` commands concise and single-line (roughly 100 characters or fewer). Short command output stays inline; long output auto-upgrades to an attachment.
- Keep `# @wsl-patch` `SEARCH` blocks minimal (only enough unique surrounding lines to match once).
- Never chain a read command with a mutating command in the same `# @wsl-cmd` block.
- Never use absolute paths or `../` paths. All paths must be relative to the bridge workspace root.
