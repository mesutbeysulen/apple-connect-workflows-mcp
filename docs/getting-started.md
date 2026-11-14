# Getting started

This guide installs the server, adds an App Store Connect API key, connects an MCP client and runs the first reads. Accounts start read-only; nothing here changes App Store Connect.

## Requirements

- Node.js 24 or newer.
- An App Store Connect API key (`.p8`). A **team key** comes with an issuer ID; an **individual key** has none and acts with its owner's access.
- An MCP client that can start a local stdio server, such as Claude Code, Claude Desktop or Codex.

## 1. Install

From npm (recommended), pinned to a version:

```sh
npx -y apple-connect-workflows-mcp@0.12.0 --help
```

From source, when you want to read or change the code:

```sh
git clone https://github.com/mesutbeysulen/apple-connect-workflows-mcp.git
cd apple-connect-workflows-mcp
npm ci
npm run build
```

Below, `apple-connect-mcp` stands for `npx -y apple-connect-workflows-mcp@0.12.0`, or `node /absolute/path/to/dist/cli.js` for a source checkout.

## 2. Add an API key

Pass the **path** to the `.p8` file. Never paste its contents into a chat, a shell argument or an environment variable.

```sh
apple-connect-mcp key-setup \
  --config "$HOME/.apple-connect-mcp/config.json" \
  --name main --issuer YOUR_ISSUER_UUID \
  --p8 /absolute/path/AuthKey_ABCDEFGHIJ.p8
```

- For an individual key, use `--individual` instead of `--issuer`.
- If the file is not named `AuthKey_<KEY_ID>.p8`, add `--key-id YOUR_KEY_ID`.
- `key-setup` checks that the file is an ES256 key, copies it to `~/.apple-connect-mcp/keys` with owner-only permissions and writes the config. It never prints the key.

Check the connection:

```sh
apple-connect-mcp doctor --config "$HOME/.apple-connect-mcp/config.json"
```

`doctor` only proves that the apps list can be read; other operations may need more API roles.

### The config file

```json
{
  "databasePath": "/Users/you/.apple-connect-mcp/plans.sqlite",
  "accounts": [
    {
      "name": "main",
      "keyType": "team",
      "issuerId": "11111111-1111-4111-8111-111111111111",
      "keyId": "ABCDEFGHIJ",
      "privateKeyPath": "/Users/you/.apple-connect-mcp/keys/AuthKey_ABCDEFGHIJ.p8",
      "readOnly": true,
      "allowedAppIds": [],
      "genericWrites": false
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `databasePath` | Local SQLite file for plans, upload journals, the audit log and received webhook events. Not encrypted; keep it private. |
| `readOnly` | `true` blocks every write for this account. |
| `allowedAppIds` | Apps this account may change. Writes to any other app are refused. |
| `genericWrites` | Allows reviewed `api-apply` plans for endpoints without a dedicated command. Off by default. |
| `operators` | Optional, top level: limits writes by operating-system user. See [Safety model](safety.md#local-operator-policy). |

## 3. Connect an MCP client

Claude Code:

```sh
claude mcp add apple-connect --env APPLE_CONNECT_CONFIG="$HOME/.apple-connect-mcp/config.json" -- \
  npx -y apple-connect-workflows-mcp@0.12.0 serve
```

Codex CLI:

```sh
codex mcp add apple-connect --env APPLE_CONNECT_CONFIG="$HOME/.apple-connect-mcp/config.json" -- \
  npx -y apple-connect-workflows-mcp@0.12.0 serve
```

Clients that use a JSON config:

```json
{
  "mcpServers": {
    "apple-connect": {
      "command": "npx",
      "args": ["-y", "apple-connect-workflows-mcp@0.12.0", "serve"],
      "env": { "APPLE_CONNECT_CONFIG": "/absolute/path/config.json" }
    }
  }
}
```

Restart the client, then call `accounts_list` and `account_check` to confirm the setup.

## 4. First reads

Discover IDs before any write:

1. `apps_list` finds the app ID.
2. `versions_list` finds the App Store version ID.
3. `localizations_list` shows the localized text.
4. `release_readiness` lists what blocks submission.

Every read tool is listed in [MCP tools](mcp-tools.md). Collection results include `truncated`; when it is `true`, more data exists than was returned.

## 5. Allow writes for one app

Edit the account in the config, then restart the server:

```json
{ "name": "main", "readOnly": false, "allowedAppIds": ["1234567890"] }
```

Keep the other account fields. You can also pass `--allow-app 1234567890` to `key-setup`. Before the first write, read [Safety model](safety.md).

## 6. Run a write

From the terminal, run the command directly; anything that changes prices, availability or many items at once previews first and writes only with `--execute`:

```sh
apple-connect-mcp version-localize --account main --app 1234567890 \
  --version VERSION_ID --locale en-US --whats-new "Bug fixes."
```

From an MCP client, the same command goes through a reviewed plan: `workflow_prepare` saves it with a digest, `workflow_plan_get` shows it, and `workflow_apply` runs that exact plan once. See [Safety model](safety.md#plans-and-digests).

For every command, run `apple-connect-mcp help` or read [CLI command reference](commands.md). To go from an empty app record to a live release, follow the [release checklist](release-checklist.md).
