# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/); while the version is below 1.0, a minor release may contain breaking changes, which are marked **Breaking**.

## 0.13.0 — 2026-11-14

### Added
- `smoke-read`: runs every read tool against one app, discovering IDs as it goes, and reports each as ok, error (forbidden, not found, rate limited) or skipped. The report keeps counts and field names only. Run against a live account with nine apps: 67 of 71 tools returned data, none failed after the fixes below.

### Fixed
Found by `smoke-read` on a live account, where Apple's API differs from its own OpenAPI document:
- Export compliance: `/v1/apps/{id}/appEncryptionDeclarations` returns 404 PATH_ERROR. `encryption_declarations_list` and `encryption-declaration-create` now use `/v1/appEncryptionDeclarations?filter[app]=`.
- `bundle_id_capabilities` and `capability-enable`/`capability-disable`: Apple rejects `limit` on this relationship; it is no longer sent.
- `diagnostic_signatures_list` returns an empty list with a note for builds without diagnostic data, where Apple answers 404.
- `xcode_cloud_overview` reports `enabled: false` for apps without Xcode Cloud instead of failing.
- Contract tests and `api_read` now refuse requests the live API is known to reject, with the working alternative.

## 0.12.0 — 2026-11-14

### Added
- `apple-connect-mcp help <topic>` with 22 topics; `<command> --help` shows the topic that contains the command, and `help all` prints everything.
- Guides: [Getting started](docs/getting-started.md), [Release checklist](docs/release-checklist.md) and [Safety model](docs/safety.md).
- Generated references: [CLI commands](docs/commands.md) and [MCP tools](docs/mcp-tools.md), rebuilt with `npm run docs`. Tests fail when a command has no help or the generated files are stale.
- Claude Code registration instructions.

### Changed
- README shortened to an overview that links to the guides. The npm package now includes `docs/` and this changelog.

## 0.11.0 — 2026-11-14

### Added
- Win-back offers for subscriptions, with eligibility, prices per territory and promotion.
- Retention messages for subscriptions.
- Custom license agreement, accessibility labels, routing app coverage files and Custom Product Page search keywords.
- App Clip default and advanced experiences, Apple-hosted background asset packs, and EU alternative distribution keys, domains, marketplace details and packages.

## 0.10.0 — 2026-11-14

### Added
- Xcode Cloud: start builds from a branch, tag or pull request, or rerun one; wait for results with failed actions, issues and failing tests; list and download artifacts; turn workflows on or off.

## 0.9.0 — 2026-11-14

### Changed
- **Breaking:** Game Center moved to Apple's versioned model (v2 leaderboards, achievements and sets; versioned activities and challenges). `gc-leaderboard-*`, `gc-achievement-*` and `gc-release` were replaced by `gc-create`, `gc-update`, `gc-localize`, `gc-image-upload` and `gc-submit` with `--kind`.
- Text limits that Apple does not document were removed; IDs, score ranges, points and image sizes follow Apple's published rules.

### Added
- Leaderboard sets, activities, challenges, Game Center groups and matchmaking rule sets, rules, teams and queues.

## 0.8.0 — 2026-11-14

### Added
- Game Center leaderboards and achievements with localizations and images.

## 0.7.0 — 2026-11-14

### Added
- Team members: invite, change roles and app access, remove.
- Signing: devices, App ID capabilities, certificates issued from your own CSR, provisioning profiles.

## 0.6.0 — 2026-11-13

### Added
- Custom Product Pages, in-app events and product page A/B tests, with Asset Library media and review submission.

## 0.5.0 — 2026-11-13

### Added
- Product sales territories, promotional offers, offer codes, promoted purchases, product review screenshots, subscription availability and sandbox testers.

## 0.4.0 — 2026-11-13

### Added
- Introductory offers and finance reports.
- Release workflow: pushing a new `package.json` version to `main` publishes to npm and creates the tag and GitHub release. Publishing uses `NPM_TOKEN` when the secret is set, otherwise trusted publishing.

## 0.3.0 — 2026-11-08

### Added
- Export compliance: encryption declarations, documents and build attachment, checked by `release-check`.
- Version-based product metadata and product review images.

## 0.2.0 — 2026-11-08

### Added
- Release readiness gate with manual attestations, and in-app purchase and subscription versions in App Review submissions.
- Published to npm.

## 0.1.2 — 2026-11-08

### Added
- `AGENTS.md` for assistant-guided installation and the package manifest.

## 0.1.1 — 2026-11-08

### Changed
- English setup and usage guide.

## 0.1.0 — 2026-11-08

### Added
- Local stdio MCP server and CLI for App Store Connect: apps, versions, metadata, screenshots, previews, builds, TestFlight, App Review, release, reports and webhooks, with read-only defaults, reviewed plans and an audit log. MIT license.
