# Safety model

App Store Connect changes reach real customers, real prices and real reviews. This page describes what the server does to keep those changes deliberate, and where its protection ends.

## Defaults

- **Read-only accounts.** A new account cannot write. Writes need `readOnly: false` and the app in `allowedAppIds`.
- **Ownership checks.** Before writing, commands confirm that the version, build, product, page, placement, group or other resource belongs to the app named in the command. A typo in an ID fails instead of changing another app.
- **Previews.** Commands that change prices, availability, team access, certificates, many files at once, or anything Apple will not let you take back show what they would do and write only with `--execute`. Examples: `app-price-set`, `availability-set`, `metadata-sync`, `screenshots-sync`, `user-invite`, `certificate-revoke`, `winback-create`, `ci-build-start`.
- **Idempotent reruns.** Creating commands find an existing item by its identifier, name or vendor ID and return `exists` instead of making a duplicate. Updates send only fields that differ.
- **Uploads resume.** Builds, screenshots, creative assets and previews are journaled before bytes move. `build-resume`, `asset-resume` and `creative-resume` continue from the journal without a second reservation.

## Plans and digests

A model must not be able to turn its own guess into a write. Three plan types bind approval to an exact request:

| Plan | Prepare | Inspect | Apply |
| --- | --- | --- | --- |
| Metadata changes across languages | `metadata_plan` | `plan_get` | CLI `apply --plan ID --digest HASH`, or `workflow_apply` for the `apply` command |
| Any CLI write from an MCP client | `workflow_prepare` | `workflow_plan_get` | `workflow_apply` with the plan ID and digest |
| Any catalog endpoint without a command | `api_write_plan` | `api_plan_get` | CLI `api-apply --plan ID --digest HASH` (needs `genericWrites: true`) |

Each plan is stored locally with a SHA-256 digest of its exact contents, expires after 30 minutes and runs once. Files and folders a plan uses are hashed and checked again before it runs. `api_write_plan` checks the request against Apple's OpenAPI schema and refuses credential fields.

`workflow_apply` lets an MCP client run a plan it prepared. Whether that needs a human's approval depends on your MCP client's tool-approval setting; the digest only proves that the plan was not changed after it was shown. If you want a person to approve every write, require approval for `workflow_apply` in your client, or run writes from the terminal yourself.

## Uncertain outcomes

When Apple refuses a write, nothing changed and the command can be fixed and run again. When the connection fails after a write was sent, the outcome is unknown: the server does not resend it. Plans in that state are marked `uncertain` and refuse to run again. Check the remote state with a read tool, then prepare a new plan if needed.

Apple does not support transactions across resources. A command that changes several languages or files can finish part of the work; the journal and the command output say how far it got, and rerunning continues from there.

## Concurrency

Writes take a lease per account and app in the local database, so two processes using the same database cannot change the same app at once. Processes with different databases do not coordinate.

## Secrets

- The `.p8` key is read only from the path in the config. It never appears in output, plans or logs.
- The App Review demo password comes from `APPLE_REVIEW_DEMO_PASSWORD`, and the webhook secret from `APPLE_WEBHOOK_SECRET`, never from arguments.
- MCP output redacts passwords, secrets, private keys, demo account names, and certificate and profile contents.
- Certificates are issued from a certificate signing request you create; private keys are refused.
- Single-use offer codes and downloaded files are written with owner-only permissions.

## Local operator policy

On a shared machine, the optional top-level `operators` field limits writes by operating-system user:

```json
{
  "operators": [
    { "user": "dev", "accounts": ["main"], "capabilities": ["upload", "review"] },
    { "user": "lead", "accounts": ["*"], "capabilities": ["upload", "review", "release", "commercial", "admin"] }
  ]
}
```

Capabilities: `upload` (metadata, media, builds), `review` (submissions), `release` (publishing, phased release, live experiments), `commercial` (prices, products, offers), `admin` (team, signing, webhooks, groups, generic writes). This is a local guard, not authentication: anyone who can read the key or point the CLI at another config can bypass it. Protect the key with file permissions.

Every write attempt, allowed or denied, is recorded in the local audit log. Read it with `apple-connect-mcp audit` or the `audit_log_list` tool.

## Actions that cannot be undone

- `release-publish` makes a version available on the App Store.
- `certificate-revoke` invalidates the certificate and every profile that uses it.
- `user-remove` removes a person from the team; they need a new invitation.
- `gc-group-join` moves an app's Game Center into a group; Apple limits moving it back.
- `offer-codes-generate` creates a new batch of redeemable codes every time it runs.
- Win-back offer territories and prices cannot change after creation.

## What has and has not been verified

Automated tests check every request the commands send against Apple's App Store Connect API 4.6 schema, and run a real MCP stdio session. They use mocked Apple responses. The server has not yet been run end to end against a live App Store Connect account. Start with read tools and a test app, and check results in App Store Connect.

Where the schema is silent, behavior follows Apple's developer guides, for example win-back offer prices and Game Center image sizes. If Apple rejects a request that the schema allows, the command reports Apple's error unchanged; please open an issue with it.
