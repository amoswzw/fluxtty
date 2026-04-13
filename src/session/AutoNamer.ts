type NameRule = [RegExp, string | ((m: RegExpMatchArray) => string)];

// Commands that "take over" the terminal and warrant a pane rename.
// Transient commands (ls, git, npm run, cd, etc.) do NOT appear here —
// the pane keeps its cwd-derived name.
const SIGNIFICANT: RegExp[] = [
  /^claude\b/,
  /^aider\b/,
  /^codex\b/,
  /^n?vim?\b/,
  /^emacs\b/,
  /^nano\b/,
  /^ssh\b/,
  /^mosh\b/,
  /^psql\b/,
  /^mysql\b/,
  /^sqlite3?\b/,
  /^redis-cli\b/,
  /^mongosh?\b/,
  /^python3?\b/,
  /^ipython3?\b/,
  /^node\b/,
  /^deno\b/,
  /^irb\b/,
  /^htop\b/,
  /^btop\b/,
  /^top\b/,
  /^k9s\b/,
];

/** Returns true if the command should trigger a pane rename. */
export function isSignificantCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return SIGNIFICANT.some(re => re.test(trimmed));
}

const RULES: NameRule[] = [
  // AI agents (highest priority)
  [/^claude\b/,                       'claude'],
  [/^aider\b/,                        'aider'],
  [/^codex\b/,                        'codex'],

  // Editors
  [/^n?vim?\s+(.+)/,                  m => `vim: ${basename(m[1])}`],
  [/^emacs\s+(.+)/,                   m => `emacs: ${basename(m[1])}`],
  [/^nano\s+(.+)/,                    m => `nano: ${basename(m[1])}`],
  [/^n?vim?\s*$/,                     'vim'],

  // Git
  [/^git\s+(commit|push|pull|rebase|merge|clone|log|diff|stash)\b/, m => `git ${m[1]}`],
  [/^git\s+(\S+)/,                    m => `git ${m[1]}`],

  // npm / yarn / pnpm
  [/^npm\s+run\s+(\S+)/,              m => m[1]],
  [/^npm\s+(test|t)\b/,               'test'],
  [/^npm\s+(install|i)\b/,            'npm install'],
  [/^yarn\s+(\S+)/,                   m => m[1]],
  [/^pnpm\s+(\S+)/,                   m => m[1]],
  [/^bun\s+(\S+)/,                    m => `bun ${m[1]}`],

  // Rust
  [/^cargo\s+(run|build|test|watch|check)\b/, m => `cargo ${m[1]}`],
  [/^cargo\s+(\S+)/,                  m => `cargo ${m[1]}`],

  // Go
  [/^go\s+(run|build|test|generate)\b/, m => `go ${m[1]}`],

  // Python
  [/^python3?\s+-m\s+(\S+)/,          m => m[1]],
  [/^python3?\s+(\S+\.py)/,           m => basename(m[1]).replace(/\.py$/, '')],
  [/^python3?\s*$/,                   'python'],
  [/^ipython3?\s*$/,                  'ipython'],
  [/^uvicorn\b/,                      'uvicorn'],
  [/^gunicorn\b/,                     'gunicorn'],
  [/^celery\b/,                       'celery'],
  [/^pytest\b/,                       'pytest'],

  // Node / Deno / Bun runtime
  [/^node\s+(\S+)/,                   m => basename(m[1]).replace(/\.(js|ts|mjs)$/, '')],
  [/^node\s*$/,                       'node'],
  [/^deno\s+(\S+)/,                   m => `deno ${m[1]}`],
  [/^ts-node\s+(\S+)/,               m => basename(m[1]).replace(/\.ts$/, '')],
  [/^nodemon\b/,                      'nodemon'],
  [/^vite\b/,                         'vite'],
  [/^next\s+(dev|build|start)\b/,     m => `next ${m[1]}`],

  // Ruby
  [/^ruby\s+(\S+)/,                   m => basename(m[1]).replace(/\.rb$/, '')],
  [/^rails\s+(\S+)/,                  m => `rails ${m[1]}`],
  [/^rspec\b/,                        'rspec'],
  [/^bundle exec\s+(\S+)/,            m => m[1]],
  [/^irb\s*$/,                        'irb'],

  // Java / Kotlin / Scala
  [/^mvn\s+(\S+)/,                    m => `mvn ${m[1]}`],
  [/^gradle\s+(\S+)/,                 m => `gradle ${m[1]}`],
  [/^java\s+/,                        'java'],
  [/^kotlin\s+/,                      'kotlin'],

  // Databases
  [/^psql\b/,                         'postgres'],
  [/^mysql\b/,                        'mysql'],
  [/^sqlite3?\b/,                     'sqlite'],
  [/^redis-cli\b/,                    'redis'],
  [/^mongosh?\b/,                     'mongo'],

  // Docker / k8s
  [/^docker[\s-]compose\s+(up|down|logs|build)\b/, m => `compose ${m[1]}`],
  [/^docker\s+(run|exec|build|logs)\b/, m => `docker ${m[1]}`],
  [/^kubectl\s+(\S+)/,               m => `kubectl ${m[1]}`],
  [/^k9s\b/,                          'k9s'],

  // Build tools
  [/^make\s+(\S+)/,                   m => `make ${m[1]}`],
  [/^make\s*$/,                       'make'],
  [/^cmake\b/,                        'cmake'],
  [/^ninja\b/,                        'ninja'],

  // Testing
  [/^jest\b/,                         'jest'],
  [/^vitest\b/,                       'vitest'],
  [/^mocha\b/,                        'mocha'],

  // SSH / remote
  [/^ssh\s+(?:\S+@)?(\S+)/,           m => `ssh: ${m[1]}`],
  [/^mosh\s+(?:\S+@)?(\S+)/,          m => `mosh: ${m[1]}`],

  // File inspection / streaming
  [/^tail\s+.*\s(\S+)$/,              m => `tail: ${basename(m[1])}`],
  [/^less\s+(\S+)/,                   m => `less: ${basename(m[1])}`],
  [/^cat\s+(\S+)/,                    m => `cat: ${basename(m[1])}`],
  [/^htop\b|^top\b/,                  'htop'],
  [/^btop\b/,                         'btop'],

  // Directory navigation — rename to dir name
  [/^cd\s+(.+)/,                      m => {
    const dir = m[1].trim().replace(/\/$/, '');
    return basename(dir) || dir;
  }],
];

function basename(p: string): string {
  return p.trim().split('/').pop() ?? p.trim();
}

function suggest(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  for (const [pattern, result] of RULES) {
    const m = trimmed.match(pattern);
    if (m) {
      const name = typeof result === 'function' ? result(m) : result;
      return name.slice(0, 24).trim() || null;
    }
  }

  // Fallback: use the base command (first word), skip common wrappers
  const base = trimmed.split(/\s+/)[0];
  const skip = new Set(['sudo', 'env', 'exec', 'time', 'watch', 'nohup', 'strace']);
  if (skip.has(base)) {
    // try the next token
    const rest = trimmed.slice(base.length).trim();
    return suggest(rest);
  }

  return base.slice(0, 24) || null;
}

/**
 * Returns a suggested pane name for a shell command + current working directory.
 * Format: "dirname · command"  (or just "dirname" if no recognisable command)
 */
export function suggestName(cmd: string, cwd?: string): string | null {
  const dirPart = cwd ? basename(cwd.replace(/\/$/, '')) || null : null;

  const trimmed = cmd.trim();

  // cd: destination directory becomes the new name (no prefix needed)
  if (trimmed) {
    const cdMatch = trimmed.match(/^cd\s+(.+)/);
    if (cdMatch) {
      const dest = cdMatch[1].trim().replace(/\/$/, '');
      return basename(dest) || dest;
    }
  }

  const cmdPart = trimmed ? suggest(trimmed) : null;

  if (dirPart && cmdPart) return `${dirPart} · ${cmdPart}`.slice(0, 32);
  if (dirPart)            return dirPart.slice(0, 32);
  if (cmdPart)            return cmdPart.slice(0, 32);
  return null;
}

/** Returns true if the given pane name is an auto-generated default (shell-N). */
export function isDefaultName(name: string): boolean {
  return /^shell-\d+$/.test(name);
}

/** Returns a name derived purely from cwd (used on pane creation / cwd change). */
export function nameFromCwd(cwd: string): string | null {
  const dir = basename(cwd.replace(/\/$/, ''));
  return dir || null;
}
