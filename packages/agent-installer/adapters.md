# Adapter table

These are conventional skill-directory integrations verified by this installer;
they are path adapters, not vendor APIs. Detection means a marker directory or
executable was found. It does not claim that a vendor is installed correctly or
that every vendor feature is supported.

| Adapter          | User skills path               | Project skills path          | Detection                                         | Project support | Restart/reload                       |
| ---------------- | ------------------------------ | ---------------------------- | ------------------------------------------------- | --------------- | ------------------------------------ |
| OpenCode         | `~/.config/opencode/skills`    | `.opencode/skills`           | marker directory or `opencode` executable         | yes             | start a new session or reload skills |
| Claude Code      | `~/.claude/skills`             | `.claude/skills`             | marker directory                                  | yes             | start a new session                  |
| Codex            | `~/.codex/skills`              | `.codex/skills`              | marker directory or `codex` executable            | yes             | start a new session or reload skills |
| GitHub Copilot   | `~/.copilot/skills`            | `.github/skills`             | `.github` marker for project; `.copilot` for user | yes             | restart/reload the host agent        |
| Gemini CLI       | `~/.gemini/skills`             | `.gemini/skills`             | marker directory or `gemini` executable           | yes             | start a new session or reload skills |
| Antigravity      | `~/.gemini/antigravity/skills` | `.gemini/antigravity/skills` | `.gemini` marker directory                        | yes             | restart/reload Antigravity           |
| Universal agents | `~/.agents/skills`             | `.agents/skills`             | always available fallback                         | yes             | depends on the host agent            |

The installer reports every adapter, its destination, detection evidence,
selection state, and possible duplicate risk. `--adapters` selects a subset, but
unknown IDs are rejected. Universal is intentionally always detected; selecting
it alongside a detected vendor adapter may install duplicate copies in separate
skill directories. Choose one family deliberately when duplicate discovery is
undesired.

The installer writes only the `okfshare` child and its own
`.okfshare-agent-installer.json` manifest entry. It does not install plugins,
modify adapter configuration, restart agents, authenticate, or touch unrelated
files. Symlinked components/destinations, unsupported paths, escaping project
paths, and non-writable parents are rejected; failures are reported per target.
