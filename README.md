# okfshare CLI and MCP server

[![npm: okfshare](https://img.shields.io/npm/v/okfshare?label=CLI)](https://www.npmjs.com/package/okfshare)
[![npm: @okfshare/mcp](https://img.shields.io/npm/v/@okfshare/mcp?label=MCP)](https://www.npmjs.com/package/@okfshare/mcp)
[![npm: @okfshare/agent-installer](https://img.shields.io/npm/v/@okfshare/agent-installer?label=agent-installer)](https://www.npmjs.com/package/@okfshare/agent-installer)
[![Site](https://img.shields.io/badge/site-okfshare.app-191613)](https://okfshare.app)

Client-side, open-source half of [okfshare](https://okfshare.app): shared,
versioned knowledge for AI coding agents.

Publish a validated bundle of Markdown once. Every authorized agent works from
the same immutable revision, with line-level citations you can audit. The
hosted service keeps revisions, citations, and workspace auth; this repo holds
the tools your agents actually run.

## Packages

| Package                                                   | Command                    | Purpose                                              |
| --------------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| [`okfshare`](./packages/cli)                              | `npx okfshare@latest`      | CLI: setup, publish, search, context, diff, rollback |
| [`@okfshare/mcp`](./packages/mcp)                         | `npx @okfshare/mcp@latest` | MCP server for Claude Code, Cursor, opencode, Codex  |
| [`@okfshare/agent-installer`](./packages/agent-installer) | `okfshare-agent`           | Installs okfshare skills into agent tooling          |

## Quick start

```bash
# 1. One-time onboarding (device pairing in your browser)
npx okfshare@latest setup

# 2. Validate and publish a folder of Markdown
npx okfshare@latest validate ./knowledge
npx okfshare@latest publish ./knowledge --visibility public --yes

# 3. Any teammate's agent retrieves cited context
npx okfshare@latest context SHARE_ID "how do we handle db migrations"
```

Headless/CI environments: supply a pre-provisioned credential via the
`OKFSHARE_TOKEN` environment variable (check existence only; never log it),
then verify with `whoami` and `doctor`.

## MCP setup

```bash
claude mcp add okfshare -- npx @okfshare/mcp@latest
```

Or any MCP client:

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

Tools: `whoami`, `doctor`, `list_shares`, `search_share`,
`search_workspace`, `get_context`, `pull_bundle`, `publish_bundle`.
Registry manifest: [server.json](./server.json).

## Why citations matter

Retrieval returns the file, the exact lines, and the immutable revision they
came from. When an agent claims "our convention says X", you can audit the
claim in seconds - and a citation means the same thing tomorrow, because
revision content never changes in place.

## The Open Knowledge Format

Bundles are Markdown with structured frontmatter: a `type`, title,
description, tags, sources, and verification events. The format is
deliberately small and stays readable in any editor. Worst case, you are left
with plain files - no lock-in.

- Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- Field guide (published with okfshare itself): https://okfshare.app/s/ecf08367a22273482c0887ca8700ee8e
- Forkable conventions starter: https://okfshare.app/s/e8ddeda5aab619495c970f031dce7058

## Development

```bash
pnpm install
pnpm check   # typecheck + test + build across all packages
```

- Node 20+ and pnpm 10.
- The packages talk to the hosted API at `https://okfshare.app`; no local
  server is required to develop them.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for the acceptance flow and
  [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.

## Links

- Site and docs: https://okfshare.app
- Agent-readable docs: https://okfshare.app/llms.txt and https://okfshare.app/llms-full.txt

## License

[Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) - the code license does not
grant rights to the okfshare name or branding.
