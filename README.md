# Apple Connect Workflows MCP

[![npm version](https://img.shields.io/npm/v/apple-connect-workflows-mcp)](https://www.npmjs.com/package/apple-connect-workflows-mcp)
[![CI](https://github.com/mesutbeysulen/apple-connect-workflows-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mesutbeysulen/apple-connect-workflows-mcp/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/mesutbeysulen/apple-connect-workflows-mcp)](https://github.com/mesutbeysulen/apple-connect-workflows-mcp/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org/)

A local [Model Context Protocol](https://modelcontextprotocol.io/) server and CLI for preparing and shipping apps and games through App Store Connect, from Claude, Codex or any MCP client. It covers the release path end to end: app information, screenshots, builds, TestFlight, App Review, release, in-app purchases, marketing, Game Center, Xcode Cloud, team and signing, and reports.

It runs over stdio, keeps API keys on your machine, starts every account read-only, and stores plans and journals in a local SQLite database. It is not affiliated with Apple.

**Give this line to your AI assistant to install and configure it:**

```text
https://github.com/mesutbeysulen/apple-connect-workflows-mcp — install this MCP server for me and follow AGENTS.md. Keep the account read-only.
```

## Quick start

Node.js 24 or newer. Pass the path to your `.p8` key, never its contents:

```sh
npx -y apple-connect-workflows-mcp@0.13.0 key-setup \
  --config "$HOME/.apple-connect-mcp/config.json" \
  --name main --issuer YOUR_ISSUER_UUID \
  --p8 /absolute/path/AuthKey_ABCDEFGHIJ.p8

npx -y apple-connect-workflows-mcp@0.13.0 doctor --config "$HOME/.apple-connect-mcp/config.json"
```

Register it with Claude Code (for Codex CLI, use `codex mcp add` with the same arguments):

```sh
claude mcp add apple-connect --env APPLE_CONNECT_CONFIG="$HOME/.apple-connect-mcp/config.json" -- \
  npx -y apple-connect-workflows-mcp@0.13.0 serve
```

For individual keys, other clients, source installs and enabling writes, see [Getting started](docs/getting-started.md).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, API key, config fields, client registration, first reads, enabling writes |
| [Release checklist](docs/release-checklist.md) | Every step from a new app record to a live version, with the command for each |
| [Safety model](docs/safety.md) | Read-only defaults, previews, reviewed plans, secrets, operator policy, irreversible actions |
| [CLI command reference](docs/commands.md) | All commands by topic (also `apple-connect-mcp help <topic>`) |
| [MCP tools](docs/mcp-tools.md) | Every tool the server exposes, with read-only hints |
| [Changelog](CHANGELOG.md) | Changes per release, including breaking ones |
| [AGENTS.md](AGENTS.md) | Instructions an assistant follows to install the server for you |

## What it supports

| Area | Examples |
| --- | --- |
| Apps and versions | App information, categories, age rating, availability, version text, review details, export compliance |
| Media | Asset Library screenshots, app previews, Header and Search Results images; interrupted uploads resume |
| Builds and TestFlight | Upload IPA/PKG files, wait for processing, beta groups and testers, Beta App Review |
| App Review and release | Readiness report, submission, phased release, manual release, customer review replies |
| Commerce | In-app purchases, subscriptions, prices, territories, introductory, promotional and win-back offers, offer codes, promoted purchases, retention messages, sandbox testers |
| Marketing | Custom Product Pages, in-app events, product page A/B tests |
| Game Center | Leaderboards, sets, achievements, activities and challenges on Apple's versioned model; groups and matchmaking |
| Xcode Cloud | Start builds, wait for results with failing tests, download artifacts |
| Team and signing | Team members, devices, App ID capabilities, certificates from your own CSR, provisioning profiles |
| Listing extras | License agreement, accessibility labels, routing coverage, App Clips, background assets, EU alternative distribution |
| Reports and webhooks | Sales, finance and analytics reports; webhooks and a local receiver |
| Anything else | Search Apple's API catalog, read any GET endpoint, and run reviewed, schema-checked writes |

## How writes stay safe

- Accounts are read-only until you set `readOnly: false` and list the app in `allowedAppIds`.
- Commands check that every ID belongs to the named app before writing.
- Price, availability, team, signing and bulk changes preview first and write only with `--execute`.
- From an MCP client, writes go through a saved plan with a SHA-256 digest that runs once (`workflow_prepare`, `workflow_plan_get`, `workflow_apply`). Require approval for `workflow_apply` in your client if a person should approve every write.

Details and limits are in the [safety model](docs/safety.md).

## Status

Every request the commands send is checked in tests against Apple's App Store Connect API 4.6 OpenAPI schema, and the MCP server is tested over a real stdio session. Read tools have been run against a live account with `smoke-read` (67 of 71 returned real data, none failed). Write commands have not yet been verified against a live account; version 1.0 will follow that. Run `smoke-read` on your account, then try writes on a test app.

Not covered: creating the app record, App Privacy answers and agreements (no API; `submission_manual_steps` links to them), Keychain storage of keys, and remote multi-user hosting.

## Development

```sh
npm ci
npm run check
npm test
npm run docs   # regenerate docs/commands.md and docs/mcp-tools.md after changing help or tools
```

CI runs on Node.js 24 and 26. To regenerate the API catalog from an Apple OpenAPI document, run `npm run catalog -- /absolute/path/to/openapi.oas.json`. Command help lives in `src/help.ts`; tests fail if a command is missing from it or the generated docs are stale.

### Releasing

Add a section to `CHANGELOG.md`, bump `version` in `package.json` and the pinned version in `README.md`, `AGENTS.md` and `docs/getting-started.md`, then push to `main`. The Release workflow runs only when npm does not have that version yet: it runs the checks and tests, publishes to npm, then creates the `v<version>` tag and a GitHub release.

Publishing uses npm trusted publishing with provenance for the workflow `release.yml`. If an `NPM_TOKEN` repository secret exists, the workflow publishes with that token instead and skips provenance.

## License

[MIT](LICENSE).
