# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/); while the version is below 1.0, a minor release may contain breaking changes, which are marked **Breaking**.

## 0.17.0 — 2026-11-14

### Changed
- **Breaking:** MCP clients can no longer apply plans by default. `workflow_apply` refuses unless the account sets `"mcpApply": true`, and returns the terminal command instead. Add `"mcpApply": true` to keep the previous behavior.
- `workflow_prepare` returns `mcpApply` and `applyInTerminal`, the exact command to run the plan.

### Added
- `workflow-apply --plan ID --digest HASH` runs a plan an MCP client prepared, with the same digest, expiry, identity, policy and input-file checks as `workflow_apply`.

## 0.16.0 — 2026-11-14

### Fixed
Found by running commerce, Game Center and certificate writes against a live account:
- `product-localize --iap` failed: Apple now keeps in-app purchase text on versions. The command writes to the purchase's draft version, creating it if needed.
- `iap-price-set` and `app-price-set` failed: Apple rejects an included territory resource. The base territory is now sent only as a relationship.
- `promo-offer-create` and subscription `offer-code-create` failed for free trials: Apple needs a territory-only price entry per territory. They default to every territory where the subscription is sold; `--territories` narrows it.
- `subscription-price-set` now says to run `product-availability-set` first when the subscription is not sold in that territory, instead of Apple's 409 UNSUPPORTED_TERRITORY.
- `gc-set-members` failed for new members: Apple's PATCH only reorders. It now adds with POST, removes with DELETE, then orders.
- `winback-create` and `winback-update` check `--wait-months` is 2-24 before sending.
- Help now shows the different eligibility values for in-app purchase and subscription offer codes, and that subscription codes need `--offer-eligibility`.

### Verified live
In-app purchases, subscriptions, prices, availability, review screenshots, promoted purchases, introductory, promotional and offer-code offers, retention messages, Game Center leaderboards, achievements, sets and images, and certificate creation and revocation. Win-back offers need an approved subscription, so Apple's refusal was the expected result.

## 0.15.1 — 2026-11-14

### Verified live
`bundle-id-create`, `capability-enable`, `capability-disable`, `profile-create`, `profile-download` and `profile-delete` on a throwaway App ID; `experiment-create`, `experiment-update`, `treatment-create` and `treatment-localize` on a live app with an unstarted experiment. No fixes were needed.

### Changed
- The safety guide notes that changing an App ID's capabilities invalidates its provisioning profiles.

## 0.15.0 — 2026-11-14

### Fixed
Found by running marketing, webhook and sandbox writes against an unreleased app on a live account:
- `cpp-create` failed on every new page: Apple requires the first page version and a localization in the same request. It now creates all three at once, using the app's primary language.
- `cpp-keywords-set` failed: Apple requires `filter[platform]` when reading the app's keywords. A new `--platform` option defaults to `IOS`.
- Contract tests now also catch a missing required filter, and a filter Apple refuses on a version localization's keywords.

### Verified live
`cpp-create`, `cpp-update`, `cpp-localize`, `cpp-delete`, `event-create`, `event-localize`, `event-update`, `event-delete`, `webhook-create` (rerun updates the secret, never prints it), `webhook-disable`, `webhook-enable`, `webhook-ping`, `webhook-delete`, `sandbox-tester-update`, `release-check` and the `availability-set` preview. Product page A/B tests need an app that is live on the App Store, so `experiment-create` is not yet verified.

## 0.14.0 — 2026-11-14

### Changed
- Apple errors now include Apple's explanation and the attribute it refers to, for example `contactPhone: The phone number must be in a valid format…`, instead of only the error code.

### Fixed
Found by running the release-preparation writes against an unreleased app on a live account:
- `review-detail-set` and `beta-review-detail-set` refuse a change to existing review details unless first name, last name, phone and email are all set, and name the missing flags. Apple otherwise answers 409 ATTRIBUTE.REQUIRED.

### Verified live
`version-localize`, `metadata-sync`, `app-info-set`, `version-update`, `review-detail-set`, `beta-info-set`, `beta-notes-set`, `beta-group-create`, `version-build-set`, `asset-upload` and `workflow_prepare`/`workflow_apply`, including idempotent reruns, the app allowlist, digest checks and the audit log.

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
