# Contributing

Thanks for helping improve the okfshare client tooling.

## Ways to contribute

- **Bug reports**: CLI/MCP misbehavior. Include command output with `--json`
  where possible. Redact tokens and workspace data.
- **Client features**: new CLI commands, output formats, shell completions,
  MCP tools. Open an issue first for anything larger than a fix so we can
  agree on shape before you build.
- **Docs**: README fixes, usage examples, integration recipes.

## Ground rules

- No secrets or customer data in issues, ever.
- Keep the dependency footprint small; this ships to `npx`.
- Node 20+ compatibility required (no platform-specific code without a
  fallback).

## Acceptance flow

1. Open an issue describing the change.
2. Fork, create a branch, add or update tests.
3. Run `pnpm check` and `pnpm format:check` locally; CI must pass.
4. Open a PR referencing the issue.

Maintainers review best-effort within a few days. The hosted service source
is separate and closed; PRs here cannot modify it.

## Local development

```bash
pnpm install
pnpm check
```

Packages talk to the hosted API at `https://okfshare.app`. To develop against
a different endpoint, use the CLI's environment overrides documented in
`packages/cli/README.md`.
