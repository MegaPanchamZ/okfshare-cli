# @okfshare/agent-installer

Safely distributes the canonical OKFShare **skill only** to supported agent skill
directories. This advanced library/tool does not authenticate the CLI, manage an
account, publish bundles, retrieve shares, or store credentials. Use the
`okfshare` CLI for those operations. Interactive terminals authenticate with
device-code `login`; browserless agents use a pre-provisioned `OKFSHARE_TOKEN`
configured outside chat and command arguments, without exposing its value.

```sh
npx @okfshare/agent-installer status
npx @okfshare/agent-installer install --scope user --yes
npx @okfshare/agent-installer install --scope project --dry-run
npx @okfshare/agent-installer status --scope project --adapters opencode,claude
npx @okfshare/agent-installer uninstall --scope user --yes
```

Install defaults to copying. Use `--link` for a symlink to a checked-out
canonical skill. User-modified files are never silently overwritten. The
manifest records the installed checksum and installer version; a changed
destination is skipped until the caller supplies both `--approve-modified` and
explicit `--yes` approval. Updates use unique temporary paths, exclusive
per-target locks, safe-path and writability checks, and cleanup that never
removes foreign files.

The library exposes `detectTargets`, `install`, `status`, and `uninstall` for
embedding. `--project <path>` selects a project scope (default: cwd). Use
`--adapters <comma-separated-ids>` to select detected adapters. `status` reports
every adapter and destination, detection evidence, installed/canonical
checksums, compatibility, and skill/installer version state. All mutations
refuse noninteractive execution without `--yes`; `--dry-run` performs no
filesystem writes. Manifests reject symlinks and nonregular files and are written
atomically through a verified real directory with exclusive temporary files,
sync, and rename. Supported paths are listed in [`adapters.md`](./adapters.md).
