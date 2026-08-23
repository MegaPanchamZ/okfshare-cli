# Security Policy

## Reporting a vulnerability

Report security issues through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository.

Do not open public issues for security problems.

## Scope

- The `okfshare` CLI, including credential storage, device pairing, and
  token handling.
- The `@okfshare/mcp` server process boundary.
- The `@okfshare/agent-installer` package (skill installation paths).

## What we care about most

- Credential leakage: tokens written to disk unprotected, logged, or exposed
  in error output.
- Path traversal in `pull`, bundle staging, or skill installation.
- Command injection through share content, slugs, or server responses.
- Unsafe handling of untrusted API responses in the MCP stdio protocol.

The hosted service itself is out of scope for this repository; service
security issues are handled separately via https://okfshare.app.

## Safe harbor

We will not pursue action against good-faith research that avoids privacy
violations, data destruction, and service degradation.
