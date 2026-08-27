# @okfshare/mcp

Model Context Protocol (MCP) server for [okfshare](https://okfshare.app) - shared,
versioned knowledge for AI coding agents.

This stdio MCP server wraps the okfshare CLI so MCP clients (Claude Code,
Cursor, opencode, Codex, and any MCP-compatible agent) can search, read, and
publish team knowledge bundles as cited context.

## Quick start

```bash
npx @okfshare/mcp@latest
```

The server launches `npx okfshare@latest` under the hood and speaks JSON-RPC
over stdio. Authenticate once with `npx okfshare@latest setup` (or provide
`OKFSHARE_TOKEN`); every tool call then runs against your workspace.

### Claude Code

```bash
claude mcp add okfshare -- npx @okfshare/mcp@latest
```

### Any MCP client (stdio)

```json
{
  "mcpServers": {
    "okfshare": {
      "command": "npx",
      "args": ["@okfshare/mcp@latest"]
    }
  }
}
```

## Tools

The server keeps the contract navigable by grouping related platform operations:

| Tool                                                                                                                                             | Operations                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `okfshare_list`, `okfshare_search`, `okfshare_context`, `okfshare_open`, `okfshare_diff`, `okfshare_log`, `okfshare_validate`, `okfshare_whoami` | Existing retrieval and local validation tools                                               |
| `okfshare_graph`                                                                                                                                 | `search`, `snapshot`, `neighbors`, `path`, `diff`, `provenance`, `related`                  |
| `okfshare_blame`                                                                                                                                 | `line`, `semantic`                                                                          |
| `okfshare_attestations`                                                                                                                          | `list`, `verify`, `submit`                                                                  |
| `okfshare_refs`                                                                                                                                  | Branch, channel, tag, and release `list`, `get`, `resolve`, `create`, `move`, `delete`      |
| `okfshare_proposals`                                                                                                                             | Share proposal `list`, plus detail, reviewer, review, comment, check, reopen, merge, reject |
| `okfshare_roles`, `okfshare_organizations`, `okfshare_teams`                                                                                     | Workspace access and organization operations                                                |
| `okfshare_service_accounts`                                                                                                                      | Service accounts and credential lifecycle                                                   |
| `okfshare_audit`, `okfshare_governance`                                                                                                          | Audit metadata, policies, holds, and retention inspection                                   |
| `okfshare_portability_export`, `okfshare_ops`                                                                                                    | Portability exports and status/dependencies/SLOs                                            |
| `okfshare_fork`, `okfshare_status`, `okfshare_pull`                                                                                              | Confirmed fork creation and local binding status/pull                                       |
| `okfshare_bindings`, `okfshare_siem`                                                                                                             | Workspace role bindings and SIEM webhook destinations                                       |
| `okfshare_integrity`                                                                                                                             | One-revision verification or bounded cursor-paginated integrity history                     |
| `okfshare_share_access`                                                                                                                          | Direct share roles/grants and private-share operation                                       |
| `okfshare_rulesets`                                                                                                                              | Ruleset CRUD, validation, and single/all-ruleset evaluation                                 |
| `okfshare_webhooks`                                                                                                                              | Generic product webhook CRUD                                                                |
| `okfshare_domains`                                                                                                                               | Organization domain list/get/create/manual verify/delete                                    |
| `okfshare_capabilities`, `okfshare_organization_administrators`, `okfshare_admin`, `okfshare_billing`                                            | Capability introspection, administrator assignment, operator controls, and billing snapshot |

Schemas use closed JSON objects and enums for operation names. Mutating delete,
merge, reopen, transfer, release, revoke, and retention actions require
`confirm: true`; the server maps this to the CLI's explicit `--yes` flag.
Private keys and secret fields are rejected from JSON payloads and removed from
CLI output. Service-account credential responses are marked
`oneTimeCredential: true`; the MCP server never stores them.

Refs with a `refType` use the CLI's plural category position (`branches`,
`channels`, `tags`, or `releases`). Proposal listing is addressed by share id;
proposal review and lifecycle operations remain addressed by proposal id.
Capability introspection and organization-administrator assignment map directly
to the CLI commands. Domain verification accepts only the explicit
`verificationToken` input and does not persist it.

Mutations always require `confirm: true`, including reviews, comments, ref
creation/moves, account changes, webhook changes, and fork/pull operations. For
example:

```json
{
  "name": "okfshare_fork",
  "arguments": { "shareId": "team-notes", "confirm": true }
}
```

Graph and retrieval calls are revision-addressed; return envelopes from the CLI
retain their `source`, `revision`, and citation fields for agent answers.

All retrieval responses identify the resolved immutable revision, so citations
stay auditable.

## Environment

- `OKFSHARE_TOKEN` - optional. Pre-provisioned CLI credential for headless use.
  Check existence only; never log its value.
- `OKFSHARE_CLI` - optional. Override the CLI command (default
  `npx okfshare@latest`).

## Learn more

- Product site: https://okfshare.app
- CLI: https://www.npmjs.com/package/okfshare
- OKF format: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

## License

See the repository license.
