# Apple Connect MCP — first implementation slice

Based on the preceding research and the user's instruction to begin development.
Implementation decisions below are engineering defaults, not separately elicited preferences.

Goal: deliver a local MCP that reads App Store Connect and prepares persistent, reviewable
version-localization changes. This is the first slice of the larger release-automation product.

Approaches considered: fork magaza-mcp (fast initial coverage, inherits a two-store design);
generated endpoint-only server (broad reach, weak workflow guarantees); Apple-only workflow core
(selected recommendation in the preceding analysis, now used as the implementation default).

Runtime: Node >=24, TypeScript, official MCP SDK, Zod, built-in SQLite. stdio only.
Credentials: explicitly configured private-key path; never discover or print secrets. Multiple named
team-key accounts. Read-only default. Explicit app ID allowlist required for writes.
First tools: account status, apps, versions, builds, localizations, metadata plan, plan inspection.
MCP can prepare but cannot authorize/execute a mutation. CLI apply binds approval to plan ID and
SHA-256 digest. This prevents a model-supplied boolean from being treated as human consent.

Each plan contains immutable account identity, app/version identity, field-level before/after changes,
expiry and digest. SQLite stores execution state. Execution reads remote state, rejects stale fields,
checks editable version status, writes, and verifies the result. A timeout after PATCH is reconciled
on an explicit retry: desired state means completed, baseline means safe to attempt, other state
means conflict. A database lease serializes application per account and app. No atomic cross-Apple
transaction or compare-and-swap guarantee is claimed. Local DB access is a trusted boundary.

Tests use injected HTTP and temporary databases; no live Apple mutations. Verify MCP handshake
and tool calls without credentials. README must distinguish tested offline behavior from untested
real-account behavior. Build/asset uploads, TestFlight writes, generated catalog, webhooks, Keychain
import and remote access are subsequent slices, not claimed delivered in this one.
