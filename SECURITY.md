# Security policy

This server holds App Store Connect API keys and can change real apps, prices and releases, so security reports are welcome.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a vulnerability.

Include what an attacker can do, the steps to reproduce it, and the version (the first line of `apple-connect-mcp --help`). Never include a real `.p8` key, JWT, issuer ID tied to a real team, or other credentials; use placeholders.

You can expect an acknowledgement within a week. Fixes are released as a new npm version, and the changelog names the issue once users can update.

## Supported versions

Only the latest published version receives security fixes.

## What counts

In scope, for example:

- A way to make the server or CLI read, print, log or send a private key, token or the App Review demo password.
- A write that bypasses `readOnly`, `allowedAppIds`, `genericWrites`, `mcpApply`, operator capabilities, plan digests or ownership checks.
- A plan that runs more than once, or runs something different from what was shown.
- Path traversal or symlink tricks in file inputs or outputs.
- Requests sent anywhere other than `api.appstoreconnect.apple.com` and Apple's upload hosts.

Out of scope: anything that needs someone who can already read your key file or edit your config, since they can call Apple's API directly; and the local operator policy, which is a guard against mistakes on a shared machine, not authentication. See the [safety model](docs/safety.md).
