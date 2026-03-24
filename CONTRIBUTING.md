# Contributing to fluxtty

Thanks for helping improve fluxtty.

This project is a Tauri desktop app with a Vite + TypeScript frontend and a Rust backend. The goal of this guide is to make it easy to contribute without guessing how the repo is expected to work.

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
