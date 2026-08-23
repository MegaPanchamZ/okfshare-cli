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

| Tool               | Description                                         |
| ------------------ | --------------------------------------------------- |
| `whoami`           | Show the authenticated workspace identity           |
| `doctor`           | Check credential expiry, API reachability, bindings |
| `list_shares`      | List knowledge bundles in the workspace             |
| `search_share`     | Bounded term search within one bundle (cited hits)  |
| `search_workspace` | Search across all bundles in the workspace          |
| `get_context`      | Token-budgeted retrieval with line-level citations  |
| `pull_bundle`      | Pull a full immutable revision of a bundle          |
| `publish_bundle`   | Publish a local OKF directory as a new revision     |

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
