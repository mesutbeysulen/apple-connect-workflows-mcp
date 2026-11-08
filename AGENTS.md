# Agent-assisted installation

Use this guide when a user asks you to install **Apple Connect Workflows MCP** from this repository. Complete the local setup for the user; ask only for information you cannot obtain safely, such as which App Store Connect API key to use and the team issuer ID. This repository is currently private and the package is not published to npm. Do not suggest `npx apple-connect-workflows-mcp` as a working installation command.

## Keep credentials out of the conversation

- Never read or print the contents of a `.p8` file, a generated token, or a private key.
- Ask for the **path** to the `.p8` file, never for its contents. The key ID and issuer ID may be provided as text.
- Pass the path to `key-setup`; that command reads the key locally and copies it into a private directory.
- Do not put the key contents in shell arguments, environment variables, client configuration, logs, or the assistant's context.
- Keep the generated account read-only unless the user explicitly requests a write-enabled app allowlist.

## Installation flow

1. Check Node.js (`node --version`); version 24 or later is required. Locate an existing checkout of this repository or clone `https://github.com/mesutbeysulen/apple-connect-workflows-mcp.git` if the user has access. Do not change the repository's visibility.
2. In the checkout, run `npm ci` and `npm run build`. Confirm that `dist/cli.js` exists.
3. Check whether a config already exists at `~/.apple-connect-mcp/config.json` or at `APPLE_CONNECT_CONFIG`. Inspect only account metadata and file paths, not the private key. Preserve existing accounts.
4. If a key is needed, search likely local folders for filenames matching `AuthKey_*.p8` without reading their contents. Confirm the chosen path and ask for the issuer ID for a team key, or whether it is an individual key. If the filename does not contain the key ID, ask for that ID too.
5. For a new team account, run the compiled CLI with absolute paths, for example:

   ```sh
   node dist/cli.js key-setup --config /absolute/path/config.json --name main \
     --issuer ISSUER_UUID --p8 /absolute/path/AuthKey_ABCDEFGHIJ.p8
   ```

   For an individual key, replace `--issuer ISSUER_UUID` with `--individual`. Do not overwrite an existing account without checking its current configuration and the user's intended replacement.
6. Run `node dist/cli.js doctor --config /absolute/path/config.json`. A successful apps read verifies connectivity for that endpoint; it does not prove every API permission.
7. Register the server in the user's chosen MCP client using `node /absolute/path/to/apple-connect-workflows-mcp/dist/cli.js serve` and `APPLE_CONNECT_CONFIG=/absolute/path/config.json`. Prefer the client's registration command or supported API. Preserve unrelated client settings and make a backup before editing a config file directly.
8. For Codex CLI, the registration command is:

   ```sh
   codex mcp add apple-connect --env APPLE_CONNECT_CONFIG=/absolute/path/config.json -- \
     node /absolute/path/to/apple-connect-workflows-mcp/dist/cli.js serve
   ```

9. Restart the MCP client if needed. Verify `accounts_list` and `account_check` through the client when available. Tell the user the config path, which client was registered, and that writes remain disabled by default.

Do not publish to npm, enable writes, submit to App Review, or release an app as part of installation. Those are separate user requests.
