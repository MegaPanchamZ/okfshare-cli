# okfshare CLI

The CLI validates and publishes an OKF Markdown publishing directory.

## Setup

```sh
npx okfshare@latest --help
npx okfshare@latest setup
```

`setup` installs the agent skill and authenticates using a valid `OKFSHARE_TOKEN` or
existing stored credential before starting browser pairing. Authentication is also
available with `npx okfshare@latest login`; inspect it with `npx okfshare@latest whoami` and remove
it with `npx okfshare@latest logout`. `--dry-run` previews changes and `--yes` confirms
mutating commands in noninteractive environments.

Use `npx okfshare@latest doctor --json` for read-only environment, API, credential,
skill, and project-binding diagnostics. `npx okfshare@latest version` prints the CLI
and result-schema versions. Setup reports detected adapters and uses only the
installer API; adapter selection is reported when the installed agent supports it.

## Bundle and config

The CLI always walks the supplied directory recursively, ignoring VCS, dependency,
build, and cache directories. Markdown paths must be safe. An optional
`okfshare.json` may contain:

```json
{
  "root": "docs/guide.md",
  "title": "Guide",
  "description": "A small knowledge bundle",
  "visibility": "unlisted",
  "include": ["**/*.md"],
  "exclude": ["draft/**/*.md"]
}
```

`root` is an exact safe relative Markdown file path. If omitted, only root-level
`README.md` or `index.md` is eligible. A configured root must exist and be included.
Without a configured title, the title is inferred from root frontmatter, its first
heading, or its filename.

## Validation and publishing

```sh
npx okfshare@latest validate ./knowledge
npx okfshare@latest validate ./knowledge --root docs/guide.md --title "Guide"
npx okfshare@latest publish ./knowledge --visibility unlisted --description "Notes" --yes
npx okfshare@latest publish ./knowledge --visibility password --password-stdin --yes
npx okfshare@latest publish ./knowledge --dry-run --json
```

Supported metadata flags for `validate`, `publish`, and `update` are `--title`,
`--description`, `--root`, and `--visibility`. Flags override config; password
visibility may also use `--password-stdin`.
Direct `--password` values are rejected. Use the hidden interactive prompt (when
the visibility is `password` and no password flag is provided) or
`--password-stdin`; neither puts the password in shell history.
Passwords are never included in JSON, dry-run output, or CLI errors.

## Updates and rollback

```sh
npx okfshare@latest list
npx okfshare@latest open SHARE_ID
npx okfshare@latest update SHARE_ID ./knowledge --yes
npx okfshare@latest rollback SHARE_ID REVISION --yes
npx okfshare@latest rollback SHARE_ID REVISION --expected-revision CURRENT --yes
npx okfshare@latest diff SHARE_ID FROM TO --json
npx okfshare@latest bind SHARE_ID ./knowledge --revision 1
npx okfshare@latest update ./knowledge --yes
npx okfshare@latest search "deployment safety"
```

Updates create immutable revisions. Rollback selects an existing revision; all
mutating operations prompt unless `--yes` or `--dry-run` is supplied.
`--expected-revision` protects update and rollback from overwriting a newer
revision; the CLI sends it as an `If-Match` precondition and reports conflicts
with a stable conflict result.

`diff` compares two immutable revisions through the server and returns added,
removed, changed files, metadata changes, and content digests. Use
`npx okfshare@latest diff SHARE_ID FROM TO --json` for machine-readable output.

## Retrieval

```sh
npx okfshare@latest pull SHARE_ID ./knowledge --revision current --yes
npx okfshare@latest search SHARE_ID "deployment safety" --revision 3 --limit 10
npx okfshare@latest context SHARE_ID "deployment safety" --max-tokens 1200
```

`pull` resolves `current` (or a positive revision number) on the server, validates
every returned Markdown path, root, duplicate, file, and bundle limit, then stages the
complete destination before placing it. The destination must not already exist;
existing files, directories, and symlinks are never overwritten. Existing parent
ancestors must be real directories, not symlinks. `--dry-run` fetches and validates but performs no filesystem mutation,
and `pull` prompts unless `--yes` is supplied. It writes only safe bundle metadata to
`okfshare.json` and a versioned `.okfshare-pull.json`; neither contains content,
passwords, or tokens.
If final placement fails after the destination is reserved, the private staging
directory is removed but the partial destination is preserved to avoid data loss; the
error identifies that destination for manual cleanup or inspection.

`search` returns bounded server snippets and accepts `--limit` from 1 through 100.
`context` returns server-selected chunks and accepts `--max-tokens` from 500 through 16000. This is an estimated budget: the server reports `estimate` as `chars/4`,
`usedTokens`, and whether results were truncated. These commands call the server
directly and do not perform local search. All retrieval requests use the configured
Bearer token (`OKFSHARE_TOKEN`, stored credentials, or `login`), and IDs, queries,
revisions, and limits are URL-encoded. A revision number in a pull metadata file pins
exactly what was retrieved; repeat pulls do not overwrite an existing destination.
A project binding supplies the share ID for update, pull, search, and context when
the command is otherwise unambiguous; successful updates and pulls refresh its
revision and local digest. Bindings contain no credentials.

Pull results report `sourceBytes`, computed from downloaded UTF-8 Markdown content, and
`storedBytes`, taken from the immutable revision. `storedBytes` covers the stored
manifest, rendered pages, and source files; it is not the raw source byte count. Both
are recorded in `.okfshare-pull.json`.

HTTP responses are bounded at 4 MiB before JSON parsing. Remote paths are Markdown-only,
reject encoded forms, traversal, filesystem-colliding case/NFKC variants, Windows
reserved names, invalid characters, and trailing dots or spaces.
The parent directory is checked for real, non-symlink ancestors immediately before
placement. Because Node does not provide secure `openat`-style path walking here, the
destination parent must not be writable by untrusted concurrent local processes.

## Skill installation

```sh
npx okfshare@latest skills install okfshare --scope user --yes
npx okfshare@latest skills status okfshare --scope user
npx okfshare@latest skills uninstall okfshare --scope user --yes
```

## Platform operations

The authenticated CLI exposes the platform APIs without changing the device
login flow. All commands support `--json`; mutating commands require `--yes` in
non-interactive use.

```sh
npx okfshare@latest graph snapshot SHARE_ID --revision 3 --json
npx okfshare@latest graph search WORKSPACE_ID --q "machine learning" --limit 20
npx okfshare@latest blame semantic SHARE_ID --q "deployment safety"
npx okfshare@latest attest submit SHARE_ID 3 --public-key KEY --signature SIG --data '{"claim":{}}'
npx okfshare@latest refs create SHARE_ID --ref-type tag --label v1 --target-revision-id REV --yes
npx okfshare@latest proposals detail PROPOSAL_ID --json
npx okfshare@latest proposals list SHARE_ID --json
npx okfshare@latest roles list WORKSPACE_ID --json
npx okfshare@latest service-accounts issue WORKSPACE_ID ACCOUNT_ID --data '{"scopes":["workspace:read"]}'
npx okfshare@latest audit export --format ndjson > audit.ndjson
npx okfshare@latest governance retention list --json
npx okfshare@latest export account --format ndjson > export.ndjson
npx okfshare@latest retention dry-run --json
npx okfshare@latest billing aggregate --json
npx okfshare@latest ops status --json
npx okfshare@latest capabilities workspace WORKSPACE_ID --json
npx okfshare@latest capabilities share SHARE_ID --json
npx okfshare@latest orgs administrators get WORKSPACE_ID --json
npx okfshare@latest orgs administrators set WORKSPACE_ID --data '{"billingOwnerId":"USER_ID"}' --yes --json
npx okfshare@latest workspace-search "machine learning" --limit 20 --json
npx okfshare@latest stars add SHARE_ID --yes --json
```

Service-account credentials and SIEM webhook secrets are never printed by the
CLI, even when the server returns them once. Public keys and signatures are
inputs only; private keys are never accepted or uploaded.

### Non-auth command matrix

These stable wrappers match the mounted Worker routes. Every command accepts
`--json`; destructive mutations require `--yes` or `--dry-run` in noninteractive
use. Server cursors and conflict details are preserved in JSON output.

| Area          | Commands                                                                         |
| ------------- | -------------------------------------------------------------------------------- |
| Forks         | `fork create SHARE_ID`, `fork status FORK_ID`, `fork sync FORK_ID`               |
| Proposals     | `proposals list                                                                  | propose                                                           | detail                         | reviewer  | review     | comment                                              | check   | merge | reopen | reject` |
| Refs          | `refs list                                                                       | get                                                               | resolve                        | create    | move       | delete SHARE_ID`; branches, channels, tags, releases |
| Revisions     | `log`, `diff`, `integrity SHARE_ID [REVISION]` (provenance and parents included) |
| Trust         | `attest submit                                                                   | list                                                              | verify`, `blame line           | semantic` |
| Graph         | `graph snapshot                                                                  | neighbors                                                         | path                           | diff      | provenance | related                                              | search` |
| Access        | `share-access roles                                                              | grants                                                            | private SHARE_ID`              |
| Organizations | `orgs`, `orgs administrators get                                                 | set`, `teams`, `roles`, `bindings`, `domains`, `service-accounts` |
| Governance    | `rulesets`, `governance retention                                                | legal-hold                                                        | policy`, `retention`, `export` |
| Operations    | `audit list                                                                      | export`, `siem`, `webhooks`, `billing`, `ops status               | dependencies                   | slo`      |
| Discovery     | `explore`, `workspace-search QUERY`, `stars list                                 | add                                                               | remove SHARE_ID`               |
| Safety        | `redact SHARE_ID --reason REASON`                                                |
| Source        | `source SHARE_ID REVISION PATH`                                                  |

```sh
npx okfshare@latest fork sync FORK_ID --yes --json
npx okfshare@latest proposals comment PROPOSAL_ID --parent-id COMMENT_ID --data '{"body":"Please clarify this change"}' --json
npx okfshare@latest refs move SHARE_ID main --target-revision-id REV --expected-revision-id OLD --yes --json
npx okfshare@latest integrity SHARE_ID 3 --json
npx okfshare@latest share-access grants create SHARE_ID --data '{"granteeType":"workspace","granteeId":"WORKSPACE_ID","role":"reader"}' --yes --json
npx okfshare@latest webhooks create --data '{"url":"https://example.test/hook","events":["revision.published"]}' --yes --json
npx okfshare@latest rulesets evaluate WORKSPACE_ID --data '{"visibility":"public"}' --json
npx okfshare@latest fork status FORK_ID --json
npx okfshare@latest redact SHARE_ID --reason "Remove regulated content" --yes --json
```

Fork status uses `GET /api/v1/shares/:id/fork/status` and preserves the returned
status, revision, timing, and conflict summary fields. Capability commands expose
the server's `allows`, `denies`, `effectiveAllows`, `effectiveDenies`,
`permissions`, and action booleans without client-side reinterpretation. Export
responses are streamed NDJSON/tar responses rather than JSON envelopes; the
`X-Export-Truncated` header is the truncation contract. Authentication expansion
(SSO, SCIM, MFA, and session commands) is intentionally excluded.

## Authentication storage

`OKFSHARE_TOKEN` takes precedence over stored credentials. It is verified before pairing;
if it is rejected, the CLI does not replace it while the environment override remains.
In noninteractive or `--agent` mode, pairing prints manual URL guidance to stderr and
never asks for a token in argv or chat. Otherwise the CLI uses an
OS credential helper when available and falls back to
`~/.config/okfshare/credentials` with restrictive permissions (`0600`). Set
`OKFSHARE_API_URL` for another API; the default is `https://okfshare.app`.

`login --json` keeps its single result object on stdout. Pairing guidance and other
diagnostics go to stderr; credentials are never accepted as command-line arguments.

## JSON examples

```json
{
  "ok": true,
  "operation": "validate",
  "bundle": { "path": "./knowledge", "files": 3 },
  "validation": { "valid": true, "errors": [], "warnings": [] },
  "next": []
}
```

```json
{
  "ok": true,
  "operation": "publish",
  "bundle": { "path": "./knowledge", "files": 3 },
  "share": { "id": "share-id", "slug": "abc", "status": "active" },
  "next": []
}
```
