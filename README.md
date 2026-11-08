# Apple Connect Workflows MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for managing App Store Connect from an MCP client. It combines focused read tools with planned write workflows for app metadata, assets, builds, TestFlight, review, release, commerce, analytics, and webhooks.

The server runs over stdio, keeps API keys on your machine, and stores plans and operation journals in a local SQLite database. It is not affiliated with Apple. The package is currently installed from source; it is not published to npm.

## What it supports

| Area | Examples |
| --- | --- |
| Apps and versions | List apps and builds; update app information, categories, age rating, availability, version metadata, and review details |
| Media | Upload and arrange Asset Library screenshots; upload app previews and creative assets; resume interrupted transfers |
| Builds and TestFlight | Upload IPA/PKG files, monitor processing, manage beta groups and testers, distribute builds, submit beta review |
| App Review and release | Check readiness, submit versions, manage phased release, publish manual releases, reply to reviews |
| Commerce | Manage in-app purchases, subscriptions, localizations, and price schedules |
| Reporting | Download sales and analytics reports; request analytics reports |
| Webhooks and API access | Manage webhooks, inspect delivery events, search the API catalog, and prepare catalog-backed API writes |

Run `workflow_catalog` in your MCP client for the complete list of CLI workflows and their arguments. Focused MCP tools such as `apps_list`, `versions_list`, `localizations_list`, and `release_readiness` are available for common reads.

## Requirements

- Node.js 24 or newer.
- An App Store Connect API key (`.p8`) with the permissions required for the operations you intend to use.
- A local MCP client that can launch a stdio server.

## Install with an assistant

If your assistant can access this private repository and run commands on your machine, give it this prompt:

```text
Install https://github.com/mesutbeysulen/apple-connect-workflows-mcp for my MCP client. Read AGENTS.md and complete the local setup. Keep the account read-only.
```

[AGENTS.md](AGENTS.md) guides the assistant through building the server, configuring an API key by file path, checking connectivity, and registering the MCP client. It does not need the contents of your `.p8` key in chat. The repository must be accessible to the assistant. This route uses a local checkout; the package is not yet available through `npx`.

## Manual installation

```sh
git clone https://github.com/mesutbeysulen/apple-connect-workflows-mcp.git
cd apple-connect-workflows-mcp
npm ci
npm run build
```

The build creates `dist/cli.js`. The repository is configured as a private npm package (`"private": true`), so use the source checkout rather than `npx`.

### Configure an API key

For a **team key**, provide its issuer ID and the downloaded `.p8` file:

```sh
node dist/cli.js key-setup \
  --config "$PWD/config.local.json" \
  --name main \
  --issuer YOUR_ISSUER_UUID \
  --p8 /absolute/path/AuthKey_ABCDEFGHIJ.p8
```

For an **individual key**, replace `--issuer YOUR_ISSUER_UUID` with `--individual`. If the file is not named `AuthKey_<KEY_ID>.p8`, also pass `--key-id YOUR_KEY_ID`.

`key-setup` validates the key, copies it to `~/.apple-connect-mcp/keys` with owner-only permissions, and creates `config.local.json`. Accounts start read-only. The config file, `.p8` files, SQLite database, and report exports are excluded from Git. You can also create the config manually using [`config.example.json`](config.example.json); replace every placeholder and use absolute paths.

Check connectivity:

```sh
export APPLE_CONNECT_CONFIG="$PWD/config.local.json"
node dist/cli.js doctor
```

`doctor` checks access to the apps listing endpoint for each account. It does not verify permissions for every App Store Connect operation.

### Connect an MCP client

Use the absolute paths on your machine in your client's stdio server configuration:

```json
{
  "mcpServers": {
    "apple-connect": {
      "command": "node",
      "args": ["/absolute/path/to/apple-connect-workflows-mcp/dist/cli.js", "serve"],
      "env": {
        "APPLE_CONNECT_CONFIG": "/absolute/path/to/apple-connect-workflows-mcp/config.local.json"
      }
    }
  }
}
```

Restart the client after adding the server. Call `accounts_list` to confirm that the config loaded, then `account_check` to test the selected account. If your client uses a different configuration format, supply the same command, arguments, and environment variable.

For Codex CLI, you can register the same server without editing TOML manually:

```sh
codex mcp add apple-connect --env APPLE_CONNECT_CONFIG="$PWD/config.local.json" -- \
  node "$PWD/dist/cli.js" serve
```

## Allow writes

The generated account is read-only. To enable writes for a specific app, edit its entry in `config.local.json`:

```json
{
  "name": "main",
  "readOnly": false,
  "allowedAppIds": ["1234567890"]
}
```

Keep the other generated account fields (`keyType`, `issuerId` when applicable, `keyId`, and `privateKeyPath`). The JSON above shows only the fields to change. Restart the MCP server after changing the config. Alternatively, include `--allow-app 1234567890` in the initial `key-setup` command.

For a shared local machine, the optional `operators` config field restricts writes by OS user, account, and capability (`upload`, `review`, `release`, `commercial`, or `admin`). This is local policy, not user authentication. Protect the key and config with operating-system permissions. Do not expose the stdio server as a remote multi-user service.

## Use the MCP workflows

### Read data

Use focused tools to discover IDs before writing. For example:

1. `apps_list` to find an app ID.
2. `versions_list` to find its App Store version ID.
3. `localizations_list` to inspect existing localized text.
4. `release_readiness` to inspect blockers before submission.

`api_catalog_search` finds supported API endpoints; `api_read` reads catalog-backed GET endpoints. Collection responses can be truncated, so check the `truncated` field.

### Plan and apply a write

Call `workflow_prepare` with a CLI command and arguments. Argument names omit the CLI's leading `--`:

```json
{
  "command": "version-localize",
  "args": {
    "account": "main",
    "app": "1234567890",
    "version": "VERSION_ID",
    "locale": "en-US",
    "whats-new": "Performance improvements and bug fixes."
  }
}
```

The result contains a plan `id`, SHA-256 `digest`, expiration time, and preview. Inspect it with `workflow_plan_get`, then apply the exact plan:

```json
{
  "planId": "PLAN_ID",
  "digest": "64_CHARACTER_SHA256_DIGEST"
}
```

Send that second object to `workflow_apply`. Plans expire after 30 minutes and can be claimed once. For commands with a dry run, preparation reads the current state and returns a preview; other commands show the exact inputs and validate them during execution. Files and directories used by a plan are hashed and checked again before execution. A failed or uncertain write is not automatically replayed; inspect the remote state before preparing another plan.

For a multi-locale metadata diff, use `metadata_plan` and `plan_get`, then prepare the CLI `apply` command through `workflow_prepare`. For a catalog-backed write, use `api_write_plan` and then prepare `api-apply`. Generic API writes require `genericWrites: true` on the account.

`workflow_run` exposes allowlisted read and report commands such as `release-check`, `build-wait`, `sales-download`, and `analytics-download`. Report commands create local files. `key-setup` and the long-running `webhook-listen` command remain CLI operations.

### CLI examples

The same workflows can be used directly from the command line:

```sh
node dist/cli.js --help
node dist/cli.js release-check --account main --app 1234567890 --version VERSION_ID
node dist/cli.js build-upload --account main --app 1234567890 \
  --version 1.2.3 --build 42 --file /absolute/path/app.ipa
node dist/cli.js asset-upload --account main --app 1234567890 \
  --version VERSION_ID --localization LOCALIZATION_ID \
  --placement-group PLACEMENT_GROUP --file /absolute/path/screenshot.png
```

Get `PLACEMENT_GROUP` from `asset_placements_list` or `asset_ref_data`; do not guess it. Upload and other write commands use the same account policy, app allowlist, lock, and audit journal as MCP execution. Price, availability, screenshot sync, metadata sync, and asset cleanup commands preview by default and write only with `--execute`.

## Operational notes

- Publishing a version and some other App Store Connect actions cannot be undone. Review plans and the current remote state before applying them. MCP host approval is separate from the plan digest.
- Apple writes are not atomic across multiple localizations or resources. The local journal records progress; a partial result may require reconciliation.
- The SQLite lease serializes writes per account and app when processes share the same database. Separate databases do not coordinate writes.
- Plans, reports, and journals can contain app or tester information. The SQLite database is not encrypted; store it in a private directory.
- Webhook creation uses `APPLE_WEBHOOK_SECRET` from the environment. `webhook-listen` binds to `127.0.0.1`; you must provide your own HTTPS ingress if receiving external events.
- Custom Product Pages, product page optimization, in-app events, retention placements, finance reports, Keychain storage, and remote multi-user access are outside the current scope.
- Automated tests cover API behavior with mock responses and a real stdio MCP handshake. End-to-end read/write use against a live Apple account has not yet been verified. Start with read tools and a test app.

## Development

```sh
npm run check
npm test
npm run build
```

CI runs the checks on Node.js 24 and 26. To regenerate the API catalog from an Apple OpenAPI document, run `npm run catalog -- /absolute/path/to/openapi.oas.json`.

## License

[MIT](LICENSE).
