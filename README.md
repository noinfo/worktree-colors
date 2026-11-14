# Worktree Colors

Gives every git worktree its own color, so you always know which checkout you're in, without adding anything to the repo's shared `.vscode` folder.

## How colors are made

Colors are defined in **OKLCH**, a perceptual color space:

- **Hue** (0–360°) and **chroma** (within a narrow range) come from a hash of the branch name, or of the worktree path if you choose that.
- **Lightness** is one global setting.

Because OKLCH lightness is perceptual, every worktree color has the same perceived brightness and similar vibrance; only the hue really changes. VS Code only accepts hex for theme colors, so the extension converts OKLCH to sRGB hex itself. If a hue doesn't fit the sRGB gamut at your chroma, its chroma is lowered while lightness and hue stay the same.

The defaults (`lightness 0.5`, `chroma 0.065–0.085`) are muted, fit in sRGB for every hue, and give enough contrast for white title-bar text.

A worktree's color is a pure function of its branch name (or path) plus your global settings. The only exception is **Re-roll**, which saves a seed for that branch in the extension's internal storage.

## Where the colors live

VS Code has no per-window settings. User settings are shared by every window, so per-worktree colors can't go there. Instead, the extension:

1. Creates a `.code-workspace` file for the worktree in its own storage folder, outside your repo.
2. Copies the repo's shared `.vscode/settings.json` into that file and adds the computed colors on top.
3. Reopens the window through the workspace file. This happens once when you open a worktree as a plain folder (for example with `code .`).

### Shared repo settings stay in effect

When a folder is opened through a workspace file, VS Code only reads the folder's *resource-level* settings from `.vscode/settings.json`, such as editor, formatter and language settings. It ignores *window-level* ones, such as `typescript.tsdk`, `window.*` or many extension settings. To keep all shared settings working, the extension mirrors the repo file into the workspace file:

- Every key in `.vscode/settings.json` is copied, and the repo always wins.
- The file is watched. Edits, pulls and branch switches are synced within a moment, and keys removed from the repo are removed from the workspace too.
- If the repo defines its own `workbench.colorCustomizations`, the worktree colors are layered on top. With `replaceRepoColors` (on by default), every key this extension manages is removed from the repo's colors first. Leftovers from tools like Peacock then don't show, even on parts you haven't targeted. Unrelated color customizations are kept.
- Settings you add yourself in the "Workspace" settings tab (stored in the generated file) are kept, unless the repo defines the same key.
- If `.vscode/settings.json` is temporarily invalid JSON (mid-edit), the last good copy is kept.

To change a shared setting, edit `.vscode/settings.json` in the repo as usual, not the "Workspace" tab. `launch.json`, `tasks.json` and `extensions.json` from the repo's `.vscode` folder keep working as before. To turn mirroring off, set `worktreeColors.mirrorRepoSettings` to `false`.

If you'd rather not have the reopen, set `worktreeColors.autoReopen` to `false` to get a prompt instead. Or set `worktreeColors.storage` to `folderSettings` to use `.vscode/settings.json` in repos where that file isn't shared.

## Install (no build step)

```sh
cp -r worktree-colors ~/.vscode/extensions/local.worktree-colors-0.5.0
```

or package it as a `.vsix`:

```sh
cd worktree-colors && npx @vscode/vsce package --allow-missing-repository
code --install-extension worktree-colors-0.5.0.vsix
```

## Commands

- **Re-roll Color**: picks a new random hue and chroma for this branch (remembered).
- **Reset to Default Color**: goes back to the hash-based color.
- **Show Current Color**: shows the `oklch(...)` value.
- **Remove Colors From This Window**

## Settings (all user-level)

| Setting | Default | |
|---|---|---|
| `worktreeColors.lightness` | `0.5` | OKLCH L, shared by all colors |
| `worktreeColors.chromaMin` / `chromaMax` | `0.065` / `0.085` | chroma range picked by the hash |
| `worktreeColors.hashSource` | `branch` | `branch` or `path` |
| `worktreeColors.targets` | `["border", "titleBar"]` | `border`, `titleBar`, `statusBar` (bottom), `activityBar` (left/top) |
| `worktreeColors.colorMainWorktree` | `false` | also color the main checkout |
| `worktreeColors.mirrorRepoSettings` | `true` | keep the repo's `.vscode/settings.json` in sync |
| `worktreeColors.replaceRepoColors` | `true` | drop managed keys (e.g. Peacock leftovers) from the repo's colors |
| `worktreeColors.storage` | `workspaceFile` | or `folderSettings` |
| `worktreeColors.autoReopen` | `true` | reopen automatically vs. ask |

`window.activeBorder` is only drawn with the custom title bar (`"window.titleBarStyle": "custom"`).
