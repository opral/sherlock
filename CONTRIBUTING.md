# Contributing to Sherlock

This extension ships for multiple platforms (Windows/macOS/Linux), so please test on more than one OS when touching platform-specific behavior.

## Getting started

### Prerequisites

- Node.js 22
- pnpm
- Git submodules enabled

### Setup

1. Clone with submodules: `git clone --recurse-submodules git@github.com:opral/sherlock.git`
2. Install dependencies: `pnpm install`
3. Build the inlang dependencies: `pnpm run build:inlang`
4. Build Sherlock: `pnpm run build`

### Development

- Run tests: `pnpm test`
- Watch tests: `pnpm test:watch`
- Start editor app dev server: `pnpm run editor:dev`
- Package extension: `pnpm run package`

### Debugging

Set an inlang project in your workspace and point the extension launcher at it via `.vscode/launch.json` (the `args` list).

### Windows

1. For executing the package scripts a Bash shell is needed. Install [git](https://git-scm.com/) and run `npm config set script-shell "C:\\Program Files\\git\\bin\\bash.exe"`. This can be undone with `npm config delete script-shell`.
