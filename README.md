# Apple Connect Workflows MCP

[![npm version](https://img.shields.io/npm/v/apple-connect-workflows-mcp)](https://www.npmjs.com/package/apple-connect-workflows-mcp)
[![CI](https://github.com/mesutbeysulen/apple-connect-workflows-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mesutbeysulen/apple-connect-workflows-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Manage App Store Connect from an AI assistant. This local MCP server can work with app metadata, screenshots, builds, TestFlight, App Review, releases, in-app purchases, Game Center, Xcode Cloud, and more. It also includes a CLI for the same workflows.

**You do not need to clone this repository or install the package globally.** Your MCP client runs the published npm package with `npx`. The Apple API key and operation history stay on your computer.

## Let your assistant set it up

Paste this into Codex or Claude Code:

```text
Install https://github.com/mesutbeysulen/apple-connect-workflows-mcp for me. Follow its AGENTS.md. Use the published npm package, ask me only for the path to my App Store Connect .p8 key and any missing key details, then verify the MCP connection.
```

If you prefer to set it up yourself, follow the three steps below.

## Manual setup

### 1. Prepare an Apple API key

You need [Node.js 24 or newer](https://nodejs.org/) and an [App Store Connect API key](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api). Download the `.p8` file from Apple. For a **team key**, also copy its Issuer ID. An **individual key** does not have an Issuer ID.

Keep the `.p8` file on your computer. Pass its **file path**, never its contents, to `key-setup`:

```sh
npx -y apple-connect-workflows-mcp@0.19.5 key-setup \
  --config "$HOME/.apple-connect-mcp/config.json" \
  --name main \
  --issuer YOUR_ISSUER_ID \
  --p8 /absolute/path/AuthKey_ABCDEFGHIJ.p8
```

For an individual key, replace `--issuer YOUR_ISSUER_ID` with `--individual`. If the filename does not contain the Key ID, add `--key-id YOUR_KEY_ID`. `key-setup` copies the key to a private local directory and creates the config file. It does not change anything in App Store Connect.

Check that Apple accepts the key:

```sh
npx -y apple-connect-workflows-mcp@0.19.5 doctor \
  --config "$HOME/.apple-connect-mcp/config.json"
```

`doctor` checks basic read access. Other operations still depend on the key's Apple role and the app's state.

### 2. Connect your MCP client

**Codex:**

```sh
codex mcp add apple-connect \
  --env APPLE_CONNECT_CONFIG="$HOME/.apple-connect-mcp/config.json" -- \
  npx -y apple-connect-workflows-mcp@0.19.5 serve
```

**Claude Code:**

```sh
claude mcp add apple-connect -s user \
  -e APPLE_CONNECT_CONFIG="$HOME/.apple-connect-mcp/config.json" -- \
  npx -y apple-connect-workflows-mcp@0.19.5 serve
```

Restart the client if it was already open. To check the registration, run `codex mcp get apple-connect` or `claude mcp get apple-connect`. For Claude Desktop and other JSON-based clients, see [Getting started](docs/getting-started.md#3-connect-an-mcp-client).

### 3. Ask for a task

Try these in your MCP client:

```text
List the apps in my App Store Connect account.
Show what is missing before I submit my app for review.
Upload /absolute/path/MyApp.ipa for app 1234567890 as version 1.0.0, build 10, and wait for TestFlight processing.
```

The assistant discovers the required app and version IDs, prepares write operations, and runs a plan that matches your request. Your MCP client may show its own approval prompt for a write.

## Access and limits

- A new account can write to every app its Apple key can access. To limit writes to specific apps during setup, add `--allow-app 1234567890,0987654321`. To make an existing account read-only or limit other writes, edit [the local config](docs/getting-started.md#5-restrict-changes-optional).
- The MCP can use dedicated workflows and reviewed writes from its bundled Apple API catalog. It cannot grant permissions that the Apple API key does not have.
- Some steps are still manual with this MCP: creating the App Store Connect app record, completing App Privacy answers, and accepting agreements. See the [release checklist](docs/release-checklist.md) for the full path.
- The package version in the commands above is pinned. Restarting your MCP client reloads that version; it does not automatically upgrade to a future release.

For the complete command list, see [CLI commands](docs/commands.md) or [MCP tools](docs/mcp-tools.md). The [safety model](docs/safety.md) explains plans, retries, and local permissions. Changes between releases are in the [changelog](CHANGELOG.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `doctor` cannot read apps | Confirm the Issuer ID (team keys), Key ID, `.p8` path, and the key's Apple role. |
| The assistant cannot see the MCP | Restart the MCP client and check `codex mcp get apple-connect` or `claude mcp get apple-connect`. |
| A build upload lost its local journal | Ask the assistant to retry the upload with the same app, version, build number, and IPA. The pending Apple upload is reused. |
| Apple rejects a write | Read the returned Apple error. Some actions require a different API role, an editable app state, or a manual App Store Connect step. |

For more detail, use [Getting started](docs/getting-started.md), the [release checklist](docs/release-checklist.md), or [open an issue](https://github.com/mesutbeysulen/apple-connect-workflows-mcp/issues).

## License

[MIT](LICENSE). This project is not affiliated with Apple.
