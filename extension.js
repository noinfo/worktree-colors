// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED_PREFIX = 'worktreeColors.seed:';
const MIRROR_PREFIX = 'worktreeColors.mirrored:';
const CC = 'workbench.colorCustomizations';

/**
 * Which colorCustomizations keys each target controls. Covers every key Peacock writes,
 * so leftovers from it can't bleed through.
 * `c` = { base, accent, dark, badge } where each is { bg, fg }.
 */
const TARGETS = {
  border: (c) => ({
    'window.activeBorder': c.base.bg,
    'window.inactiveBorder': c.base.bg + '99',
    'sash.hoverBorder': c.accent.bg,
  }),
  titleBar: (c) => ({
    'titleBar.activeBackground': c.base.bg,
    'titleBar.activeForeground': c.base.fg,
    'titleBar.inactiveBackground': c.base.bg + 'cc',
    'titleBar.inactiveForeground': c.base.fg + 'aa',
    'commandCenter.foreground': c.base.fg,
    'commandCenter.border': c.base.fg + '99',
  }),
  statusBar: (c) => ({
    'statusBar.background': c.base.bg,
    'statusBar.foreground': c.base.fg,
    'statusBarItem.hoverBackground': c.accent.bg,
    'statusBarItem.remoteBackground': c.dark.bg,
    'statusBarItem.remoteForeground': c.dark.fg,
    'statusBar.debuggingBackground': c.base.bg,
    'statusBar.debuggingForeground': c.base.fg,
  }),
  activityBar: (c) => {
    const keys = {};
    // activityBarTop.* applies when the activity bar is moved to the top.
    for (const p of ['activityBar', 'activityBarTop']) {
      keys[`${p}.background`] = c.accent.bg;
      keys[`${p}.activeBackground`] = c.accent.bg;
      keys[`${p}.foreground`] = c.accent.fg;
      keys[`${p}.inactiveForeground`] = c.accent.fg + '99';
      keys[`${p}.activeBorder`] = c.accent.fg;
    }
    keys['activityBarBadge.background'] = c.badge.bg;
    keys['activityBarBadge.foreground'] = c.badge.fg;
    return keys;
  },
};
/** Every key this extension may ever write. */
const ALL_KEYS = (() => {
  const s = { bg: '#000000', fg: '#000000' };
  const c = { base: s, accent: s, dark: s, badge: s };
  return Object.keys(Object.values(TARGETS).reduce((acc, f) => Object.assign(acc, f(c)), {}));
})();

// ---------------------------------------------------------------------------
// JSONC (VS Code settings files allow comments and trailing commas)
// ---------------------------------------------------------------------------

function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Drop trailing commas (string-aware).
  let res = '';
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      res += c;
      if (c === '\\') res += out[++j] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    res += c;
  }
  return res.trim() ? JSON.parse(res) : {};
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Walks up from `start` to the checkout root. A linked worktree has a `.git` *file*
 * pointing at `<repo>/.git/worktrees/<name>`; the main checkout has a `.git` directory.
 */
function findGitInfo(start) {
  let dir = start;
  for (;;) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return withBranch({ root: dir, gitDir: gitPath, isLinked: false });
      if (stat.isFile()) {
        const m = fs.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (m) {
          const gitDir = path.resolve(dir, m[1].trim());
          return withBranch({ root: dir, gitDir, isLinked: /[\\/]worktrees[\\/]/.test(gitDir) });
        }
      }
    } catch {
      /* no .git here, keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function withBranch(info) {
  let branch = null;
  try {
    const m = fs.readFileSync(path.join(info.gitDir, 'HEAD'), 'utf8').match(/^ref:\s*refs\/heads\/(.+)$/m);
    if (m) branch = m[1].trim();
  } catch {
    /* detached or unreadable: fall back to the path */
  }
  return { ...info, branch };
}

// ---------------------------------------------------------------------------
// Color: OKLCH -> sRGB hex (VS Code theme colors only accept hex)
// ---------------------------------------------------------------------------

function oklchToLinearSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH -> sRGB hex; out-of-gamut colors get their chroma reduced (lightness and hue kept). */
function oklchToHex(L, C, h) {
  let rgb = oklchToLinearSrgb(L, C, h);
  let chroma = C;
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearSrgb(L, mid, h))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
    rgb = oklchToLinearSrgb(L, chroma, h);
  }
  const enc = (c) => {
    c = Math.min(1, Math.max(0, c));
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return { hex: `#${rgb.map(enc).join('')}`, chroma };
}

/** OKLCH lightness is perceptual, so it decides the text color on its own. */
const foregroundFor = (L) => (L > 0.65 ? '#000000' : '#ffffff');

/** Deterministic hue and chroma from the worktree key (+ optional re-roll seed). */
function colorFor(key, cfg) {
  const hash = crypto.createHash('sha256').update(key).digest();
  const hue = (hash.readUInt32BE(0) / 2 ** 32) * 360;
  const t = hash.readUInt32BE(4) / 2 ** 32;
  const L = cfg.get('lightness', 0.5);
  const cMin = cfg.get('chromaMin', 0.065);
  const cMax = Math.max(cMin, cfg.get('chromaMax', 0.085));
  const C = cMin + (cMax - cMin) * t;
  const { hex, chroma } = oklchToHex(L, C, hue);
  // Variants differ only in lightness (or, for the badge, in hue), so they stay as calm as the base.
  const variant = (dL, dH = 0) => {
    const l = Math.min(0.95, Math.max(0.05, L + dL));
    return { bg: oklchToHex(l, C, (hue + dH) % 360).hex, fg: foregroundFor(l) };
  };
  return {
    base: { bg: hex, fg: foregroundFor(L) },
    accent: variant(0.07), // activity bar, hovers: a touch lighter
    dark: variant(-0.15), // remote indicator
    badge: variant(0.2, 180), // complementary hue so badges stand out
    css: `oklch(${(L * 100).toFixed(1)}% ${chroma.toFixed(3)} ${hue.toFixed(1)})`,
  };
}

// ---------------------------------------------------------------------------
// Settings merging (pure, testable)
// ---------------------------------------------------------------------------

/** Our color keys without the internal `__` metadata. */
const colorsOnly = (keys) =>
  Object.fromEntries(Object.entries(keys || {}).filter(([k]) => !k.startsWith('__')));

/** Removes anything we may have written before, then adds the current keys. */
function merge(existing, keys) {
  const next = { ...(existing || {}) };
  for (const k of ALL_KEYS) delete next[k];
  return Object.assign(next, colorsOnly(keys));
}

/**
 * Builds the workspace file's `settings`:
 *  - every key from the repo's .vscode/settings.json is mirrored (repo wins),
 *  - keys mirrored last time but since removed from the repo are dropped,
 *  - keys added locally to the workspace file (not from the repo) are kept,
 *  - the worktree colors are layered on top of the repo's own colorCustomizations; with
 *    `replaceRepoColors`, every key this extension manages (e.g. Peacock leftovers) is first
 *    removed from the repo's colors, even for targets that aren't enabled.
 */
function buildWorkspaceSettings(current, repo, prevMirrored, colorKeys, replaceRepoColors = true) {
  const next = { ...(current || {}) };
  for (const k of prevMirrored) delete next[k];
  Object.assign(next, repo);

  // `next[CC]` is now either the repo's colors or a local one (mirrored repo colors were removed above).
  const base = merge(next[CC], null);
  if (CC in repo) Object.assign(base, replaceRepoColors ? merge(repo[CC], null) : repo[CC]);
  const colors = { ...base, ...colorsOnly(colorKeys) };
  delete next[CC]; // re-added last so the file's key order is stable between syncs
  if (Object.keys(colors).length) next[CC] = colors;

  return { settings: next, mirrored: Object.keys(repo) };
}

// ---------------------------------------------------------------------------
// Applying the colors
// ---------------------------------------------------------------------------

function currentInfo() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') return null;
  return findGitInfo(folder.uri.fsPath);
}

/** @returns {Record<string,string> | null} the color keys for this worktree, or null if it shouldn't be colored */
function colorKeysFor(context, info) {
  const cfg = vscode.workspace.getConfiguration('worktreeColors');
  if (!info || !(info.isLinked || cfg.get('colorMainWorktree'))) return null;
  const source = cfg.get('hashSource', 'branch');
  const key = source === 'branch' && info.branch ? `branch:${info.branch}` : `path:${info.root}`;
  const seed = context.globalState.get(SEED_PREFIX + key, '');
  const color = colorFor(key + seed, cfg);
  const keys = {};
  for (const t of cfg.get('targets', ['border', 'titleBar'])) Object.assign(keys, TARGETS[t]?.(color));
  return Object.assign(keys, { __css: color.css, __key: key });
}

/** Writes the colors through VS Code's settings API into the current workspace scope. */
async function applyToWorkspace(keys) {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const existing = workbench.inspect('colorCustomizations')?.workspaceValue || {};
  const next = merge(existing, keys);
  if (JSON.stringify(next) === JSON.stringify(existing)) return;
  await workbench.update(
    'colorCustomizations',
    Object.keys(next).length ? next : undefined,
    vscode.ConfigurationTarget.Workspace
  );
}

/** Path of the generated .code-workspace file for a worktree, kept in the extension's own storage. */
function workspaceFileFor(context, root) {
  const id = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  const name = path.basename(root).replace(/[^\w.-]+/g, '_');
  return path.join(context.globalStorageUri.fsPath, 'workspaces', `${name}-${id}.code-workspace`);
}

const isOurWorkspaceFile = (context, uri) =>
  uri.scheme === 'file' && uri.fsPath.startsWith(path.join(context.globalStorageUri.fsPath, 'workspaces'));

/**
 * Creates or updates our generated workspace file: repo settings mirrored + worktree colors.
 * Only writes when something changed; VS Code reloads the file by itself.
 */
async function syncWorkspaceFile(context, file, root, keys) {
  const cfg = vscode.workspace.getConfiguration('worktreeColors');

  /** @type {any} */
  let data = { folders: [{ path: root }], settings: {} };
  let before = '';
  if (fs.existsSync(file)) {
    before = fs.readFileSync(file, 'utf8');
    try {
      data = parseJsonc(before);
    } catch {
      /* corrupted: regenerate from scratch */
    }
  }

  let repo = {};
  if (cfg.get('mirrorRepoSettings', true)) {
    try {
      repo = parseJsonc(fs.readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8'));
    } catch (err) {
      // Missing file: nothing to mirror. Invalid JSON (e.g. mid-edit): keep the last good mirror.
      if (err.code !== 'ENOENT') return;
    }
  }

  const stateKey = MIRROR_PREFIX + file;
  const { settings, mirrored } = buildWorkspaceSettings(
    data.settings,
    repo,
    context.globalState.get(stateKey, []),
    keys,
    cfg.get('replaceRepoColors', true)
  );
  data.folders = [{ path: root }];
  data.settings = settings;

  const after = JSON.stringify(data, null, 2) + '\n';
  if (after !== before) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after);
  }
  await context.globalState.update(stateKey, mirrored);
}

let offeredReopen = false;

/** @param {vscode.ExtensionContext} context */
async function apply(context, { clear = false } = {}) {
  const cfg = vscode.workspace.getConfiguration('worktreeColors');
  const info = currentInfo();
  const keys = clear ? null : colorKeysFor(context, info);
  const wsFile = vscode.workspace.workspaceFile;

  if (wsFile) {
    // Our generated workspace: we own the file, so sync it directly (repo settings + colors).
    if (info && isOurWorkspaceFile(context, wsFile)) return syncWorkspaceFile(context, wsFile.fsPath, info.root, keys);
    // A workspace file of the user's own: just put the colors in it.
    return applyToWorkspace(keys);
  }

  // Plain folder window.
  if (cfg.get('storage') === 'folderSettings') return applyToWorkspace(keys);

  // Default: never touch the repo's .vscode/settings.json. Hop into a generated workspace file instead.
  if (!keys || !info) return;
  const file = workspaceFileFor(context, info.root);
  await syncWorkspaceFile(context, file, info.root, keys);
  const uri = vscode.Uri.file(file);
  if (cfg.get('autoReopen', true)) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
  } else if (!offeredReopen) {
    offeredReopen = true;
    const pick = await vscode.window.showInformationMessage(
      'Worktree Colors: reopen this worktree in its colored workspace?',
      'Reopen'
    );
    if (pick === 'Reopen') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const run = (opts) => apply(context, opts).catch((err) => console.error('[worktree-colors]', err));

  let timer;
  const scheduleRun = () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(), 300);
  };

  const currentKey = () => {
    const keys = colorKeysFor(context, currentInfo());
    if (!keys) vscode.window.showWarningMessage('Worktree Colors: this window is not a colored worktree.');
    return keys;
  };

  // Watch HEAD (branch switches) and the repo's shared settings (to keep the mirror in sync).
  let headWatcher;
  let settingsWatcher;
  const watch = () => {
    headWatcher?.close();
    settingsWatcher?.dispose();
    const info = currentInfo();
    if (!info) return;
    try {
      // git rewrites HEAD via HEAD.lock + rename, so watch the directory.
      headWatcher = fs.watch(info.gitDir, (_e, name) => {
        if (name === 'HEAD') scheduleRun();
      });
    } catch {
      /* best effort */
    }
    settingsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(info.root), '.vscode/settings.json')
    );
    settingsWatcher.onDidChange(scheduleRun);
    settingsWatcher.onDidCreate(scheduleRun);
    settingsWatcher.onDidDelete(scheduleRun);
  };
  watch();

  context.subscriptions.push(
    {
      dispose: () => {
        headWatcher?.close();
        settingsWatcher?.dispose();
        clearTimeout(timer);
      },
    },
    vscode.commands.registerCommand('worktreeColors.reroll', async () => {
      const keys = currentKey();
      if (!keys) return;
      await context.globalState.update(SEED_PREFIX + keys.__key, crypto.randomBytes(4).toString('hex'));
      await apply(context);
      const now = colorKeysFor(context, currentInfo());
      if (now) vscode.window.setStatusBarMessage(`Worktree color: ${now.__css}`, 4000);
    }),
    vscode.commands.registerCommand('worktreeColors.reset', async () => {
      const keys = currentKey();
      if (!keys) return;
      await context.globalState.update(SEED_PREFIX + keys.__key, undefined);
      await apply(context);
    }),
    vscode.commands.registerCommand('worktreeColors.show', () => {
      const keys = currentKey();
      if (keys) vscode.window.showInformationMessage(`Worktree color for ${keys.__key}: ${keys.__css}`);
    }),
    vscode.commands.registerCommand('worktreeColors.clear', () => run({ clear: true })),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('worktreeColors')) run();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watch();
      run();
    })
  );

  run();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _test: { oklchToHex, colorFor, merge, parseJsonc, buildWorkspaceSettings },
};
