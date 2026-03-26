# Contributing to fluxtty

Thanks for helping improve fluxtty.

This project is a Tauri desktop app with a Vite + TypeScript frontend and a Rust backend. The goal of this guide is to make it easy to contribute without guessing how the repo is expected to work.

## Project status

fluxtty is early stage and actively looking for contributors. The core is working — real PTY sessions, waterfall layout, modal input bar, workspace AI dispatch — but there is a lot of ground left to cover.

Read `CLAUDE.md` before writing any code. It documents the core design decisions that should be understood before making significant changes.

## Where to contribute

These are the areas most in need of work:

**Session persistence** — PTYs are currently tied to the window lifecycle. Implementing tmux-style reattach (reconnect to live sessions after the window closes and reopens) is the most-requested missing feature. The Rust side is the right place to start: `src-tauri/src/pty.rs` and `session.rs`.

**Windows support** — The app builds on Windows via ConPTY but has not been tested thoroughly. Bug reports and fixes for Windows-specific behaviour are welcome.

**Config schema validation** — `config.rs` loads YAML but does not yet validate unknown keys or emit useful errors for malformed values. A strict schema with clear error messages would be a good self-contained improvement.

**Shell completion** — Current completion runs `bash compgen`. Improving fish/zsh native completion support would make Insert mode significantly more useful.

**Agent detection heuristics** — `src/input/AgentDetector.ts` uses simple pattern matching to detect claude/codex/aider. Improving detection accuracy (fewer false positives/negatives) is a good first issue.

**Themes** — Adding well-tested theme YAML files to `themes/` is a low-friction contribution that makes the project more useful immediately.

If none of the above match what you want to work on, open an issue and describe what you have in mind.

## Before you start

- For anything non-trivial, open an issue or start a discussion before writing a large patch.
- Keep pull requests focused. Small, reviewable changes are much easier to merge.
- If your change affects behavior, UI, or setup, update the relevant docs in `README.md`.

## Local setup

Prerequisites:

- Node.js 18+
- Rust 1.77+
- Tauri v2 system prerequisites for your platform

Install dependencies:

```bash
npm install
```

Start the app in development:

```bash
npm run tauri dev
```

## Checks before opening a pull request

Run these commands locally before asking for review:

```bash
npx tsc --noEmit
npx vite build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Working in this repository

- Edit the TypeScript source in `src/**/*.ts`, not the generated JavaScript siblings in `src/**/*.js`.
- Do not commit local build output such as `dist/`, `src-tauri/target/`, or local environment files.
- For UI changes, include screenshots or a short screen recording in the pull request when possible.
- For platform-specific fixes, mention which platform you tested on.

## Pull request expectations

Please include:

- A short summary of the change
- Why the change is needed
- How you tested it
- Any follow-up work or known limitations

If a pull request is still exploratory, mark it clearly so reviewers know what kind of feedback is most useful.
