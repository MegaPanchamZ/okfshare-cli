#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  collectBundle,
  collectBundleWithOverrides,
  scaffoldBundle,
  validateBundle,
  type BundleOverrides,
} from "./bundle.js";
import { errorHint, renderHuman, str } from "./render.js";
import { forgetBundle, listBundles, rememberBundle } from "./localstore.js";
import { ApiClient, ApiError, decodePairingExchangeResponse } from "./api.js";
import {
  redactSecrets,
  SecureCredentialStore,
  tokenFrom,
} from "./credentials.js";
import { AgentSkillsAdapter } from "./skills.js";
import { pullBundle } from "./retrieval.js";
import {
  bindingStatus,
  bundleDigest,
  removeBinding,
  writeBinding,
} from "./bindings.js";
import { detectTargets } from "@okfshare/agent-installer";

export const CLI_VERSION = "0.3.0";
export const RESULT_SCHEMA_VERSION = 1;
export const CANONICAL_API_ORIGIN = "https://okfshare.app";
type CommandSpec = {
  description: string;
  args: {
    name: string;
    required?: boolean;
    variadic?: boolean;
    hint?: string;
  }[];
  flags: Record<
    string,
    {
      type: "string" | "boolean" | "number" | "string[]";
      default?: unknown;
      hint?: string;
    }
  >;
  mutates: boolean;
};

const commandSpecs: Record<string, CommandSpec> = {
  validate: {
    description: "Validate a directory as an OKF bundle without publishing",
    args: [{ name: "DIR", required: false, hint: "default: ." }],
    flags: {
      title: { type: "string", hint: "override bundle title" },
      description: { type: "string", hint: "override bundle description" },
      topic: { type: "string[]", hint: "topic labels (max 8)" },
      root: { type: "string", hint: "bundle-root markdown path" },
      visibility: { type: "string", default: "unlisted" },
      "password-stdin": { type: "boolean", hint: "read password from stdin" },
    },
    mutates: false,
  },
  publish: {
    description: "Publish a directory as a new share",
    args: [{ name: "DIR", required: false, hint: "default: ." }],
    flags: {
      title: { type: "string" },
      description: { type: "string" },
      topic: { type: "string[]", hint: "topic labels (max 8)" },
      root: { type: "string" },
      visibility: { type: "string", default: "unlisted" },
      "password-stdin": { type: "boolean" },
    },
    mutates: true,
  },
  update: {
    description: "Publish a new revision of an existing share",
    args: [
      { name: "SHARE_ID", required: true },
      { name: "DIR", required: false, hint: "default: ." },
    ],
    flags: {
      title: { type: "string" },
      description: { type: "string" },
      topic: { type: "string[]" },
      root: { type: "string" },
      visibility: { type: "string", default: "unlisted" },
      "password-stdin": { type: "boolean" },
      "expected-revision": {
        type: "string",
        hint: "revision number or current",
      },
    },
    mutates: true,
  },
  list: {
    description: "List shares in your workspace",
    args: [],
    flags: {
      topic: { type: "string[]", hint: "filter by topic" },
    },
    mutates: false,
  },
  diff: {
    description: "Compare two revisions of a share",
    args: [
      { name: "SHARE_ID", required: true },
      { name: "FROM", required: true },
      { name: "TO", required: true },
    ],
    flags: {},
    mutates: false,
  },
  rollback: {
    description: "Revert a share to a prior revision",
    args: [
      { name: "SHARE_ID", required: true },
      { name: "REVISION", required: true },
    ],
    flags: { "expected-revision": { type: "string" } },
    mutates: true,
  },
  integrity: {
    description: "Verify one revision or a revision history",
    args: [{ name: "SHARE_ID", required: true }, { name: "REVISION" }],
    flags: {
      limit: { type: "number" },
      cursor: { type: "string" },
      full: { type: "boolean" },
    },
    mutates: false,
  },
  capabilities: {
    description: "Inspect effective workspace or share capabilities",
    args: [
      { name: "workspace|share", required: true },
      { name: "ID", required: true },
    ],
    flags: {},
    mutates: false,
  },
  proposals: {
    description: "List and manage share proposals",
    args: [
      { name: "ACTION", required: true },
      { name: "ID", required: true },
    ],
    flags: { data: { type: "string" } },
    mutates: true,
  },
  "workspace-search": {
    description: "Search shares and knowledge in the current workspace",
    args: [{ name: "QUERY", required: true }],
    flags: { limit: { type: "number" }, cursor: { type: "string" } },
    mutates: false,
  },
  stars: {
    description: "List or change starred public shares",
    args: [{ name: "list|add|remove", required: true }, { name: "SHARE_ID" }],
    flags: {},
    mutates: true,
  },
  redact: {
    description: "Redact a share with an explicit reason",
    args: [{ name: "SHARE_ID", required: true }],
    flags: { reason: { type: "string", hint: "required redaction reason" } },
    mutates: true,
  },
};

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  network: 4,
  conflict: 5,
  cancelled: 6,
  validation: 7,
  safety: 8,
  partial: 9,
} as const;
type NpxProbe = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; shell?: boolean },
) => { status: number | null };
export function isNpxExecutable(
  platform = process.platform,
  probe: NpxProbe = (command, args, options) =>
    spawnSync(command, args, options),
) {
  const windows = platform === "win32";
  return (
    (probe(windows ? "npx.cmd" : "npx", ["--version"], {
      stdio: "ignore",
      ...(windows ? { shell: true } : {}),
    }).status ?? 1) === 0
  );
}
export function classifyCliError(error: unknown): {
  code: string;
  exitCode: number;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /secret|private|unsafe|symlink|path|credential file|keyring|password|shell history/i.test(
      message,
    )
  )
    return { code: "SAFETY_VIOLATION", exitCode: EXIT_CODES.safety };
  if (
    /validation|valid markdown|frontmatter|root|bundle|title|description|password visibility|no Markdown|file limit|byte limit/i.test(
      message,
    )
  )
    return { code: "VALIDATION_FAILED", exitCode: EXIT_CODES.validation };
  if (/BACKEND_ROUTE_MISSING/.test(message))
    return { code: "BACKEND_ROUTE_MISSING", exitCode: EXIT_CODES.error };
  return { code: "CLI_ERROR", exitCode: EXIT_CODES.error };
}

type Flags = {
  json: boolean;
  dryRun: boolean;
  [key: string]: unknown;
};
export type LoginCredentialStore = Pick<
  SecureCredentialStore,
  "set" | "setCredential" | "delete"
> & {
  get(): Promise<string | undefined>;
};
export type LoginApi = {
  setToken(token: string | undefined): void;
  whoami(): Promise<unknown>;
  pairingStart(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn?: number;
    interval?: number;
  }>;
  pairingStatus(deviceCode: string): Promise<{
    status: "pending" | "approved";
    interval?: number;
  }>;
  pairingExchange(deviceCode: string): Promise<unknown>;
};
const store = new SecureCredentialStore();

export const completionScript = (shell: string) => {
  const list = [...commands].filter((name) => name !== "completions").join(" ");
  const flags = [
    "--json",
    "--yes",
    "--dry-run",
    "--help",
    "--no-color",
    "--api-url",
    "--timeout",
    "--retries",
    "--topic",
    "--revision",
    "--expected-revision",
    "--limit",
    "--max-tokens",
    "--fields",
    "--quiet",
  ].join(" ");
  if (shell === "bash")
    return `_okfshare() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${list}" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )
  fi
}
complete -F _okfshare npx okfshare okfshare
`;
  if (shell === "zsh")
    return `#compdef okfshare
_okfshare() {
  local -a commands
  commands=(${list})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _values 'okfshare flags' ${flags}
  fi
}
compdef _okfshare okfshare
`;
  if (shell === "fish")
    return (
      [
        ...list
          .split(" ")
          .map(
            (name) =>
              `complete -c okfshare -n __fish_use_subcommand -a ${name}`,
          ),
        ...flags
          .split(" ")
          .map((flag) => `complete -c okfshare -l ${flag.slice(2)}`),
      ].join("\n") + "\n"
    );
  return "";
};

const yieldHumanSchema = (payload: unknown) => {
  const data = payload as Record<string, unknown>;
  if (data && typeof data === "object" && "name" in data && "commands" in data)
    return `okfshare schema v1 — ${str(data.version ?? "")}\n\ncommands (${Object.keys((data.commands as Record<string, unknown>).length === 0 ? {} : (data.commands as Record<string, unknown>)).length}): ${Object.keys(data.commands as Record<string, unknown>).join(", ")}\n\nUse: npx okfshare@latest schema --command <name> --json for the JSON Schema of one command.`;
  const single = data as Record<string, unknown>;
  return [
    `command: ${str(single.name)}`,
    `description: ${str(single.description)}`,
    `mutates: ${String(single.mutates)}`,
    "",
    "positional:",
    ...(
      (single.positional as {
        name: string;
        required?: boolean;
        hint?: string;
      }[]) ?? []
    ).map(
      (arg) =>
        `  ${arg.name}${arg.required ? " (required)" : ""}${arg.hint ? ` — ${arg.hint}` : ""}`,
    ),
    "",
    "flags:",
    ...Object.entries(
      (single.flags as Record<
        string,
        { type: string; default?: unknown; hint?: string }
      >) ?? {},
    ).map(
      ([key, value]) =>
        `  --${key} (${value.type}${value.default !== undefined ? `, default: ${String(value.default)}` : ""}${value.hint ? `, ${value.hint}` : ""})`,
    ),
    "",
    str(single.help),
  ].join("\n");
};

const out = (value: unknown, flags: Flags) => {
  const printable =
    flags.quiet || flags.fields ? suppressFields(value, flags) : value;
  if (flags.json) process.stdout.write(`${JSON.stringify(printable)}\n`);
  else {
    const human = renderHuman(printable);
    process.stdout.write(`${human ?? JSON.stringify(printable)}\n`);
  }
};

const suppressFields = (value: unknown, flags: Flags) => {
  const rows = (value as Record<string, unknown>)?.shares;
  const list = Array.isArray(rows)
    ? (rows as Record<string, unknown>[])
    : Array.isArray((rows as Record<string, unknown>)?.data)
      ? (rows as Record<string, unknown> as { data: Record<string, unknown>[] })
          .data
      : null;
  if (!list) return value;
  const projected = flags.quiet
    ? list.map((row) => ({ id: (row as Record<string, unknown>).id }))
    : Array.isArray(flags.fields)
      ? list.map((row) =>
          Object.fromEntries(
            (flags.fields as unknown as string[]).map((field) => [
              field,
              (row as Record<string, unknown>)[field],
            ]),
          ),
        )
      : list;
  return { ...(value as Record<string, unknown>), shares: projected };
};
async function confirmChange(flags: Flags, action: string): Promise<void> {
  if (flags.yes === true || flags.dryRun === true) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      `Refusing noninteractive ${action}; pass --yes or --dry-run`,
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await prompt.question(`Apply ${action}? [y/N] `);
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Cancelled");
}
export function parseFlags(args: string[]): {
  positional: string[];
  flags: Flags;
} {
  const positional: string[] = [];
  const flags: Flags = { json: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=", 2);
      const booleanFlags = new Set([
        "json",
        "dry-run",
        "yes",
        "no-skills",
        "no-auth",
        "no-color",
        "agent",
        "password-stdin",
        "full",
      ]);
      if (
        booleanFlags.has(key) &&
        value !== undefined &&
        value !== "true" &&
        value !== "false"
      )
        throw new Error(
          `Boolean flag --${key} must be bare or assigned true/false`,
        );
      const valueFlags = new Set([
        "revision",
        "from-share",
        "limit",
        "max-tokens",
        "mode",
        "title",
        "description",
        "root",
        "visibility",
        "password",
        "scope",
        "project",
        "adapter",
        "api-url",
        "timeout",
        "retries",
        "expected-revision",
        "topic",
        "field",
        "fields",
        "command",
        "data",
        "entity",
        "entity-types",
        "edge-types",
        "depth",
        "max-hops",
        "from",
        "to",
        "q",
        "spec",
        "label",
        "ref-type",
        "target-revision-id",
        "expected-revision-id",
        "attestation-id",
        "public-key",
        "signature",
        "attester-id",
        "reviewer-type",
        "reviewer-id",
        "member-type",
        "member-id",
        "decision",
        "parent-id",
        "name",
        "format",
        "target",
        "share-id",
        "intent",
        "window-hours",
        "target-slo",
        "confirmation",
        "cursor",
        "retention-days",
        "action",
        "scope",
        "user-id",
        "billing-owner-id",
        "security-administrator-id",
        "actor-type",
        "actor-id",
        "category",
        "outcome",
        "resource-id",
        "intent",
        "path",
        "role",
        "reason",
        "user",
      ]);
      const repeatedFlags = new Set(["topic", "field", "fields"]);
      const raw =
        value ??
        (valueFlags.has(key) && args[i + 1] && !args[i + 1].startsWith("--")
          ? args[++i]
          : true);
      const internalKey = key === "dry-run" ? "dryRun" : key;
      const rawIsString = typeof raw === "string";
      if (repeatedFlags.has(internalKey) && rawIsString) {
        const prior = flags[internalKey] as unknown;
        const next = Array.isArray(prior)
          ? [...(prior as unknown[]), raw]
          : prior === undefined
            ? [raw]
            : [prior, raw];
        flags[internalKey] = next as unknown as string | boolean;
      } else {
        flags[internalKey] = booleanFlags.has(key)
          ? raw !== "false"
          : raw === "true"
            ? true
            : raw === "false"
              ? false
              : raw;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}
const commands = new Set([
  "setup",
  "login",
  "logout",
  "whoami",
  "doctor",
  "init",
  "validate",
  "publish",
  "list",
  "open",
  "fork",
  "proposals",
  "explore",
  "update",
  "push",
  "rollback",
  "log",
  "diff",
  "pull",
  "search",
  "context",
  "bind",
  "unbind",
  "status",
  "schema",
  "completions",
  "skills",
  "graph",
  "blame",
  "attest",
  "refs",
  "roles",
  "bindings",
  "orgs",
  "teams",
  "service-accounts",
  "audit",
  "siem",
  "governance",
  "export",
  "retention",
  "billing",
  "ops",
  "integrity",
  "capabilities",
  "workspace-search",
  "source",
  "stars",
  "redact",
  "share-access",
  "annotations",
  "webhooks",
  "rulesets",
  "domains",
  "admin",
  "version",
]);
const commonFlags = new Set([
  "json",
  "dry-run",
  "yes",
  "api-url",
  "timeout",
  "retries",
  "help",
  "no-color",
  "agent",
  "quiet",
  "fields",
]);
const commandFlags: Record<string, Set<string>> = {
  setup: new Set(["scope", "project", "adapter", "no-skills", "no-auth"]),
  validate: new Set([
    "title",
    "description",
    "topic",
    "root",
    "visibility",
    "password",
    "password-stdin",
  ]),
  publish: new Set([
    "title",
    "description",
    "topic",
    "root",
    "visibility",
    "password",
    "password-stdin",
  ]),
  update: new Set([
    "title",
    "description",
    "topic",
    "root",
    "visibility",
    "password",
    "password-stdin",
    "expected-revision",
    "file",
  ]),
  push: new Set([
    "title",
    "description",
    "root",
    "visibility",
    "password",
    "password-stdin",
    "expected-revision",
    "file",
  ]),
  init: new Set(["title", "description"]),
  rollback: new Set(["expected-revision"]),
  fork: new Set([]),
  proposals: new Set([
    "from-share",
    "title",
    "description",
    "revision",
    "data",
    "reviewer-type",
    "reviewer-id",
    "decision",
    "parent-id",
  ]),
  explore: new Set(["topic", "limit"]),
  list: new Set(["topic"]),
  pull: new Set(["revision"]),
  search: new Set(["revision", "limit", "mode"]),
  context: new Set(["revision", "max-tokens"]),
  bind: new Set(["revision"]),
  skills: new Set(["scope", "project"]),
  schema: new Set(["command"]),
  graph: new Set([
    "revision",
    "limit",
    "entity",
    "entity-types",
    "edge-types",
    "depth",
    "max-hops",
    "from",
    "to",
    "q",
  ]),
  blame: new Set(["revision", "q"]),
  attest: new Set([
    "data",
    "public-key",
    "signature",
    "attester-id",
    "attestation-id",
  ]),
  refs: new Set([
    "data",
    "label",
    "ref-type",
    "target-revision-id",
    "expected-revision-id",
    "spec",
  ]),
  roles: new Set(["data"]),
  bindings: new Set(["data"]),
  orgs: new Set([
    "data",
    "name",
    "user-id",
    "billing-owner-id",
    "security-administrator-id",
  ]),
  teams: new Set([
    "data",
    "name",
    "description",
    "member-type",
    "member-id",
    "role",
  ]),
  "service-accounts": new Set([
    "data",
    "name",
    "description",
    "scopes",
    "expires-at",
  ]),
  audit: new Set([
    "action",
    "actor-type",
    "actor-id",
    "category",
    "outcome",
    "resource-id",
    "from",
    "to",
    "limit",
    "cursor",
    "format",
  ]),
  siem: new Set(["data"]),
  governance: new Set([
    "data",
    "name",
    "scope",
    "share-id",
    "reason",
    "retention-days",
    "action",
    "policy-type",
  ]),
  export: new Set(["target", "share-id", "format", "intent"]),
  retention: new Set([]),
  billing: new Set([]),
  ops: new Set(["timeout", "window-hours", "target-slo", "target"]),
  integrity: new Set(["limit", "cursor", "full"]),
  capabilities: new Set([]),
  "workspace-search": new Set(["limit", "cursor"]),
  source: new Set(["revision", "line-start", "line-end"]),
  stars: new Set([]),
  redact: new Set(["reason"]),
  "share-access": new Set(["data", "user-id", "target", "role"]),
  annotations: new Set(["data", "revision", "path"]),
  webhooks: new Set(["data"]),
  rulesets: new Set(["data"]),
  domains: new Set(["data"]),
  admin: new Set(["data"]),
};
export function validateCommandFlags(command: string, flags: Flags): void {
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
  const allowed = new Set([
    "dryRun",
    ...commonFlags,
    ...(commandFlags[command] ?? []),
  ]);
  for (const key of Object.keys(flags))
    if (!allowed.has(key))
      throw new Error(`Unknown flag for ${command}: --${key}`);
  if (flags["api-url"] !== undefined && typeof flags["api-url"] !== "string")
    throw new Error("--api-url requires a URL");
  if (flags.timeout !== undefined)
    parseBoundedInteger(flags.timeout, "timeout", 1, 300_000);
  if (
    flags.retries !== undefined &&
    parseNonnegativeInteger(flags.retries, "retries") > 5
  )
    throw new Error("retries must be between 0 and 5");
  const bounds: Record<string, [number, number]> = {
    limit: [1, 200],
    depth: [1, 3],
    "max-hops": [1, 10],
    "retention-days": [0, 36500],
    "window-hours": [1, 8760],
  };
  for (const [key, [minimum, maximum]] of Object.entries(bounds))
    if (flags[key] !== undefined) {
      if (minimum === 0) {
        const n = parseNonnegativeInteger(flags[key], key);
        if (n > maximum)
          throw new Error(`${key} must be between ${minimum} and ${maximum}`);
      } else {
        parseBoundedInteger(flags[key], key, minimum, maximum);
      }
    }
}
export const commandHelp: Record<string, string> = {
  setup:
    "npx okfshare@latest setup [--scope user|project] [--project DIR] [--adapter ID] [--no-skills] [--no-auth] [--yes] [--dry-run] [--json]",
  login:
    "npx okfshare@latest login [--api-url URL] [--timeout MS] [--retries N] [--yes] [--json]",
  doctor: "npx okfshare@latest doctor [--api-url URL] [--json]",
  validate:
    "npx okfshare@latest validate [DIR] [--root PATH] [--title TEXT] [--description TEXT] [--topic TOPIC]... [--visibility public|unlisted|password] [--password-stdin] [--json]",
  publish:
    "npx okfshare@latest publish [DIR] [--title TEXT] [--description TEXT] [--topic TOPIC]... [--root PATH] [--visibility public|unlisted|password] [--password-stdin] [--yes|--dry-run] [--json]",
  update:
    "npx okfshare@latest update SHARE_ID DIR [--title TEXT] [--description TEXT] [--topic TOPIC]... [--root PATH] [--visibility public|unlisted|password] [--password-stdin] [--expected-revision REVISION] [--yes|--dry-run] [--json]",
  push: "npx okfshare@latest push [SHARE_ID] [DIR] [--expected-revision REVISION] [--yes|--dry-run] [--json]  (alias of update)",
  init: "npx okfshare@latest init [DIR] [--title TEXT] [--description TEXT]",
  log: "npx okfshare@latest log SHARE_ID [--api-url URL] [--json]",
  schema: "npx okfshare@latest schema [--command NAME] [--json]",
  completions: "npx okfshare@latest completions bash|zsh|fish",
  logout: "npx okfshare@latest logout [--json]",
  whoami:
    "npx okfshare@latest whoami [--api-url URL] [--timeout MS] [--retries N] [--json]",
  list: "npx okfshare@latest list [--api-url URL] [--timeout MS] [--retries N] [--json]",
  proposals:
    "npx okfshare@latest proposals list|propose|detail|reviewer|review|comment|check|merge|reopen|reject ...",
  fork: "npx okfshare@latest fork create|status|sync SHARE_ID [--yes|--dry-run] [--json]",
  open: "npx okfshare@latest open SHARE_ID [--api-url URL] [--timeout MS] [--retries N] [--json]",
  rollback:
    "npx okfshare@latest rollback SHARE_ID REVISION [--expected-revision REVISION] [--yes|--dry-run] [--json]",
  diff: "npx okfshare@latest diff SHARE_ID FROM TO [--api-url URL] [--timeout MS] [--retries N] [--json]",
  pull: "npx okfshare@latest pull SHARE_ID DEST [--revision current|N] [--yes|--dry-run] [--json]",
  search:
    "npx okfshare@latest search SHARE_ID QUERY [--revision current|N] [--limit 1..100] [--mode lexical|semantic] [--json]",
  context:
    "npx okfshare@latest context SHARE_ID QUERY [--revision current|N] [--max-tokens 500..16000] [--json]",
  bind: "npx okfshare@latest bind SHARE_ID DIR [--revision N] [--json]",
  unbind: "npx okfshare@latest unbind [DIR] [--json]",
  status: "npx okfshare@latest status [DIR] [--json]",
  skills:
    "npx okfshare@latest skills install|status|uninstall [okfshare] [--scope user|project] [--project DIR] [--yes] [--json]",
  version: "npx okfshare@latest version [--json]",
  graph:
    "npx okfshare@latest graph snapshot|neighbors|path|diff|provenance|related|search ID [flags]",
  blame:
    "npx okfshare@latest blame line|semantic SHARE_ID [--revision N] [--q QUERY]",
  attest:
    "npx okfshare@latest attest submit|list|verify SHARE_ID REVISION [--data JSON]",
  refs: "npx okfshare@latest refs list|get|create|move|delete|resolve SHARE_ID ...",
  roles:
    "npx okfshare@latest roles list|get|create|update|delete WORKSPACE_ID ...",
  bindings: "npx okfshare@latest bindings list|create|delete WORKSPACE_ID ...",
  orgs: "npx okfshare@latest orgs list|get|create|update|delete|transfer ...; orgs administrators get|set WORKSPACE_ID",
  teams:
    "npx okfshare@latest teams list|get|create|update|delete WORKSPACE_ID ...",
  "service-accounts":
    "npx okfshare@latest service-accounts list|get|create|enable|disable|credentials|issue|rotate|revoke WORKSPACE_ID ...",
  audit: "npx okfshare@latest audit list|verify|export [--format csv|ndjson]",
  siem: "npx okfshare@latest siem list|get|create|update|delete WORKSPACE_ID ...",
  governance: "npx okfshare@latest governance retention|legal-hold|policy ...",
  export:
    "npx okfshare@latest export workspace|share|account [--format ndjson|tar]",
  retention: "npx okfshare@latest retention dry-run|apply [--yes]",
  billing: "npx okfshare@latest billing aggregate",
  ops: "npx okfshare@latest ops status|dependencies|slo",
  integrity:
    "npx okfshare@latest integrity SHARE_ID [REVISION] [--limit N] [--cursor N] [--full]",
  capabilities: "npx okfshare@latest capabilities workspace|share ID [--json]",
  "workspace-search":
    "npx okfshare@latest workspace-search QUERY [--limit N] [--cursor CURSOR] [--json]",
  source:
    "npx okfshare@latest source SHARE_ID REVISION PATH [--line-start N] [--line-end N] [--json]",
  stars:
    "npx okfshare@latest stars list|add|remove [SHARE_ID] [--yes|--dry-run] [--json]",
  redact:
    "npx okfshare@latest redact SHARE_ID --reason REASON [--yes|--dry-run] [--json]",
  "share-access":
    "npx okfshare@latest share-access roles|grants|private SHARE_ID ...",
  annotations: "npx okfshare@latest annotations list|create|resolve ...",
  webhooks: "npx okfshare@latest webhooks list|get|create|update|delete ...",
  rulesets:
    "npx okfshare@latest rulesets list|get|create|update|delete|evaluate|validate WORKSPACE_ID ...",
  domains: "npx okfshare@latest domains list|get|create|verify|delete ...",
  admin: "npx okfshare@latest admin access|overview|settings|policies ...",
};
async function authClient(flags?: Flags): Promise<ApiClient> {
  const token = await tokenFrom(store);
  if (!token)
    throw new Error(
      "Not logged in. Run `npx okfshare@latest login` or set OKFSHARE_TOKEN.",
    );
  const baseUrl = apiBaseUrl(flags);
  await confirmApiOrigin(baseUrl, flags, !process.env.OKFSHARE_TOKEN);
  return new ApiClient({
    token,
    baseUrl,
    timeoutMs:
      flags?.timeout === undefined
        ? undefined
        : parseBoundedInteger(flags.timeout, "timeout", 1, 300_000),
    retries:
      flags?.retries === undefined
        ? undefined
        : parseNonnegativeInteger(flags.retries, "retries"),
    userAgent: `okfshare-cli/${CLI_VERSION}`,
  });
}
function apiBaseUrl(flags?: Flags): string | undefined {
  return typeof flags?.["api-url"] === "string"
    ? flags["api-url"]
    : process.env.OKFSHARE_API_URL;
}
async function confirmApiOrigin(
  baseUrl: string | undefined,
  flags: Flags = { json: false, dryRun: false },
  storedCredential: boolean,
): Promise<void> {
  if (!baseUrl) return;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error("API URL must be a valid URL");
  }
  if (origin === CANONICAL_API_ORIGIN || !storedCredential) return;
  const warning = `Non-production API origin ${origin}; stored credentials will be sent only after explicit confirmation`;
  if (flags.yes === true) {
    if (!flags.json) process.stderr.write(`okfshare: warning: ${warning}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`${warning}. Pass --yes to confirm explicitly`);
  await confirmChange(flags, `send stored credentials to ${origin}`);
}
export async function login(
  flags: Flags,
  api: LoginApi = new ApiClient(),
  credentialStore: LoginCredentialStore = store,
  baseUrl: string | undefined = process.env.OKFSHARE_API_URL,
) {
  const existing = await tokenFrom(credentialStore);
  if (existing) {
    await confirmApiOrigin(baseUrl, flags, !process.env.OKFSHARE_TOKEN);
    api.setToken(existing);
    try {
      await api.whoami();
      if (!flags.json) out("Already logged in.", flags);
      return { status: "already_authenticated" };
    } catch (error) {
      if (process.env.OKFSHARE_TOKEN?.trim())
        throw new Error(
          "OKFSHARE_TOKEN was rejected; refusing device pairing while the environment override is set",
        );
      if (
        !(error instanceof ApiError) ||
        (error.status !== 401 && error.status !== 403)
      )
        throw error;
      await credentialStore.delete();
      api.setToken(undefined);
    }
  }
  const pairing = await api.pairingStart();
  const noninteractive =
    Boolean(flags.agent) || !process.stdin.isTTY || !process.stdout.isTTY;
  if (noninteractive || flags.json)
    process.stderr.write(
      `okfshare: open ${pairing.verificationUri} manually and enter code ${pairing.userCode}; or set OKFSHARE_TOKEN securely in the environment and run login in a real terminal. Never paste a token into chat or argv.\n`,
    );
  else if (!flags.json)
    out(
      `Open ${pairing.verificationUri}\nEnter code: ${pairing.userCode}`,
      flags,
    );
  const deadline = Date.now() + (pairing.expiresIn ?? 600) * 1000;
  let interval = pairing.interval ?? 5;
  while (Date.now() < deadline) {
    try {
      const current = await api.pairingStatus(pairing.deviceCode);
      if (current.interval) interval = current.interval;
      if (current.status === "approved") {
        const exchanged = decodePairingExchangeResponse(
          await api.pairingExchange(pairing.deviceCode),
        );
        try {
          await credentialStore.setCredential(
            exchanged.credential,
            exchanged.expiresAt,
          );
        } catch (error) {
          await credentialStore.delete();
          throw error;
        }
        const stored = await credentialStore.get();
        if (stored !== exchanged.credential || !stored?.trim()) {
          await credentialStore.delete();
          throw new Error("Credential storage verification failed");
        }
        api.setToken(stored);
        try {
          await api.whoami();
        } catch (error) {
          api.setToken(undefined);
          const rejected =
            (error instanceof ApiError &&
              (error.status === 401 || error.status === 403)) ||
            (error instanceof Error &&
              error.message.includes("invalid identity"));
          if (rejected) {
            await credentialStore.delete();
            throw new Error(
              "Stored credential verification failed; no credential was retained",
            );
          }
          throw error;
        }
        if (!flags.json) out("Logged in.", flags);
        return {
          status: "approved",
          expiresIn: exchanged.expiresAt ?? pairing.expiresIn,
        };
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429) throw error;
      interval = error.retryAfter ?? interval;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, interval) * 1000),
    );
  }
  throw new Error("Authorization timed out");
}
function bundleOverrides(flags: Flags): BundleOverrides {
  const overrides: BundleOverrides = {};
  for (const key of [
    "title",
    "description",
    "root",
    "visibility",
    "password",
  ] as const) {
    if (typeof flags[key] === "string") overrides[key] = flags[key];
  }
  const topics = flags.topic;
  if (Array.isArray(topics) && topics.length > 0)
    overrides.topics = topics.map((t) => String(t).trim()).filter(Boolean);
  return overrides;
}
export async function readPassword(
  input = process.stdin,
  output = process.stderr,
): Promise<string> {
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      "Password input requires --password-stdin in noninteractive mode; avoid putting passwords in shell history",
    );
  output.write("Password (input hidden): ");
  const stdin = input as NodeJS.ReadStream & {
    setRawMode?: (value: boolean) => void;
  };
  if (stdin.setRawMode) stdin.setRawMode(true);
  return await new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      if (stdin.setRawMode) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      if (text === "\u0003") return done(new Error("Cancelled"));
      if (text.includes("\n") || text.includes("\r")) return done();
      value += text;
    };
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("error", done);
  });
}
async function passwordFlags(flags: Flags): Promise<Flags> {
  if (typeof flags.password === "string" && flags["password-stdin"] !== true) {
    throw new Error(
      "Direct --password is refused; use the hidden interactive prompt or --password-stdin to avoid shell history",
    );
  }
  if (flags["password-stdin"] === true) {
    const value = (
      await new Promise<string>((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          data += chunk;
        });
        process.stdin.once("end", () => resolve(data.trimEnd()));
        process.stdin.once("error", reject);
      })
    ).trim();
    if (!value) throw new Error("Password from stdin was empty");
    return { ...flags, password: value };
  }
  if (flags.visibility === "password" && typeof flags.password !== "string")
    return { ...flags, password: await readPassword() };
  return flags;
}
async function bundlePayload(directory: string, flags: Flags) {
  flags = await passwordFlags(flags);
  const bundle = await collectBundleWithOverrides(
    directory,
    bundleOverrides(flags),
  );
  if (!bundle.root)
    throw new Error("A bundle-root README.md or index.md is required");
  const errors = validateBundle(bundle);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    title: bundle.title ?? bundle.root,
    description: bundle.description,
    topics: bundle.topics,
    visibility: bundle.visibility ?? "unlisted",
    password: bundle.visibility === "password" ? bundle.password : undefined,
    root: bundle.root,
    files: bundle.files.map(({ path, content }) => ({ path, content })),
  };
}
export const envelope = (
  operation: string,
  data: Record<string, unknown> = {},
) => ({
  ok: true,
  operation,
  ...data,
  next: [],
});
export const resultEnvelope = (
  operation: string,
  data: Record<string, unknown> = {},
) => ({
  operation,
  ok: true,
  errors: [],
  warnings: [],
  next: [],
  ...data,
});
export function parseRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    (value !== "current" && !/^[1-9]\d*$/.test(value))
  )
    throw new Error("Revision must be current or a positive integer");
  return value;
}
export function parsePositiveInteger(value: unknown, name: string): number {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}
function parseNonnegativeInteger(value: unknown, name: string): number {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}
export function parseBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = parsePositiveInteger(value, name);
  if (result < minimum || result > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return result;
}
const bundleSummary = (
  path: string,
  bundle: Awaited<ReturnType<typeof collectBundle>>,
) => ({
  path,
  files: bundle.files.length,
  bytes: bundle.totalBytes,
  digest: bundleDigest(bundle),
});
const requiredArg = (value: string | undefined, message: string) => {
  if (!value) throw new Error(message);
  return value;
};
const jsonPayload = (flags: Flags): unknown => {
  if (typeof flags.data !== "string") return {};
  try {
    return JSON.parse(flags.data);
  } catch {
    throw new Error("--data must be valid JSON");
  }
};
const assertNoPrivateKey = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (/private.?key|secret|password|token|credential/i.test(key))
      throw new Error(
        "Private keys and secrets are not accepted by this command",
      );
    assertNoPrivateKey(nested);
  }
};
const redactPlatformSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactPlatformSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/^(secret|token|credential|password|private.?key)$/i.test(key),
      )
      .map(([key, nested]) => [key, redactPlatformSecrets(nested)]),
  );
};
const csvFlag = (flags: Flags, key: string) =>
  typeof flags[key] === "string"
    ? String(flags[key])
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    : undefined;
const platformQuery = (flags: Flags, names: string[]) => {
  const result: Record<string, string | number | undefined> = {};
  for (const name of names) {
    const value = flags[name];
    if (value !== undefined)
      result[
        name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      ] = String(value);
  }
  return result;
};
const platformMutation = async (flags: Flags, action: string) => {
  await confirmChange(flags, action);
};
async function platformCommand(command: string, args: string[], flags: Flags) {
  const api = await authClient(flags);
  const sub = args[0];
  const id = args[1];
  let value: unknown;
  if (command === "capabilities") {
    const area = requiredArg(sub, "capabilities needs workspace or share");
    const resource = requiredArg(id, "capabilities needs ID");
    if (area === "workspace") value = await api.workspaceCapabilities(resource);
    else if (area === "share") value = await api.shareCapabilities(resource);
    else throw new Error("Usage: capabilities workspace|share ID");
  } else if (command === "workspace-search") {
    value = await api.workspaceSearch(
      requiredArg(sub, "workspace-search needs QUERY"),
      {
        limit: flags.limit as string,
        cursor: flags.cursor as string,
      },
    );
  } else if (command === "source") {
    const share = requiredArg(sub, "source needs SHARE_ID");
    const revision = requiredArg(id, "source needs REVISION");
    const path = requiredArg(args[2], "source needs PATH");
    if (path.split("/").some((segment) => segment === ".."))
      throw new Error("source PATH must not contain parent traversal");
    value = await api.source(share, revision, path, {
      lineStart: flags["line-start"] as string,
      lineEnd: flags["line-end"] as string,
    });
  } else if (command === "stars") {
    const action = sub ?? "list";
    const share =
      action === "list"
        ? undefined
        : requiredArg(id, `stars ${action} needs SHARE_ID`);
    if (action === "add" || action === "remove") {
      await platformMutation(flags, `${action} share star`);
      value = flags.dryRun
        ? { dryRun: true, shareId: share, starred: action === "add" }
        : await api.stars(share, action === "add" ? "POST" : "DELETE");
    } else if (action === "list") value = await api.stars();
    else throw new Error("Usage: stars list|add|remove [SHARE_ID]");
  } else if (command === "redact") {
    const share = requiredArg(sub, "redact needs SHARE_ID");
    const reason = requiredArg(
      flags.reason as string,
      "redact needs --reason REASON",
    );
    await platformMutation(flags, "redact share");
    value = flags.dryRun
      ? { dryRun: true, shareId: share, reason }
      : await api.redact(share, reason, randomUUID());
  } else if (command === "fork") {
    const operation = sub === "create" || sub === "fork" ? args[1] : id;
    const action =
      sub === "create" || sub === "sync" || sub === "status" ? sub : "create";
    const share = requiredArg(operation, `fork ${action} needs SHARE_ID`);
    if (action === "status") value = await api.forkStatus(share);
    else {
      await platformMutation(flags, `fork ${action}`);
      value = flags.dryRun
        ? { dryRun: true, shareId: share }
        : action === "sync"
          ? await api.forkSync(share)
          : await api.forkCreate(share);
    }
  } else if (command === "integrity") {
    const share = requiredArg(sub, "integrity needs SHARE_ID");
    value = await api.revisionIntegrity(share, id, {
      limit: flags.limit as string,
      cursor: flags.cursor as string,
      full: flags.full === true ? 1 : undefined,
    });
  } else if (command === "share-access") {
    const area = requiredArg(
      sub,
      "share-access needs roles, grants, or private",
    );
    const share = requiredArg(id, "share-access needs SHARE_ID");
    if (area === "roles") {
      const action = args[2] ?? "list";
      if (action === "list") value = await api.shareRoles(share);
      else if (action === "delete") {
        await platformMutation(flags, "remove share role");
        value = flags.dryRun
          ? { dryRun: true }
          : await api.shareRoleMutation(share, "DELETE", undefined, {
              user: flags["user-id"] as string,
            });
      } else
        value = await api.shareRoleMutation(
          share,
          "POST",
          {
            role:
              flags.role ??
              (jsonPayload(flags) as Record<string, unknown>).role,
          },
          { user: flags["user-id"] as string },
        );
    } else if (area === "grants") {
      const action = args[2] ?? "list";
      if (action === "list") value = await api.shareGrants(share);
      else if (action === "create")
        value = await api.shareGrantCreate(share, jsonPayload(flags));
      else if (action === "delete") {
        await platformMutation(flags, "remove share grant");
        value = flags.dryRun
          ? { dryRun: true }
          : await api.shareGrantDelete(
              share,
              requiredArg(args[3], "grant delete needs GRANT_ID"),
            );
      } else
        throw new Error(
          "Usage: share-access grants list|create|delete SHARE_ID",
        );
    } else if (area === "private") {
      await platformMutation(flags, "make share private");
      value = flags.dryRun
        ? { dryRun: true }
        : await api.updateMetadata(share, { visibility: "private" });
    } else throw new Error("Usage: share-access roles|grants|private SHARE_ID");
  } else if (command === "annotations") {
    const action = requiredArg(
      sub,
      "annotations needs list, create, or resolve",
    );
    if (action === "list")
      value = await api.annotations(
        requiredArg(id, "annotations list needs SHARE_ID"),
        platformQuery(flags, ["revision", "path"]),
      );
    else if (action === "create")
      value = await api.annotationCreate(
        requiredArg(id, "annotations create needs SHARE_ID"),
        jsonPayload(flags),
      );
    else if (action === "resolve")
      value = await api.annotationResolve(
        requiredArg(id, "annotations resolve needs ANNOTATION_ID"),
      );
    else
      throw new Error(
        "Usage: annotations list|create SHARE_ID or resolve ANNOTATION_ID",
      );
  } else if (command === "webhooks") {
    const action = sub ?? "list";
    const webhookId = action === "list" || action === "create" ? undefined : id;
    if (action === "delete") await platformMutation(flags, "delete webhook");
    value = await api.webhooks(
      webhookId,
      action === "list" || action === "get"
        ? "GET"
        : action === "create"
          ? "POST"
          : action === "update"
            ? "PATCH"
            : "DELETE",
      action === "create" || action === "update"
        ? jsonPayload(flags)
        : undefined,
    );
  } else if (command === "rulesets") {
    const workspace = requiredArg(id, "rulesets needs WORKSPACE_ID");
    const action = sub ?? "list";
    const rid = ["get", "update", "delete", "evaluate"].includes(action)
      ? args[2]
      : undefined;
    if (action === "delete") await platformMutation(flags, "delete ruleset");
    value = ["evaluate", "validate"].includes(action)
      ? await api.rulesetAction(
          workspace,
          action as "evaluate" | "validate",
          rid,
          jsonPayload(flags),
        )
      : await api.rulesets(
          workspace,
          rid,
          action === "list" || action === "get"
            ? "GET"
            : action === "create"
              ? "POST"
              : action === "update"
                ? "PUT"
                : "DELETE",
          ["create", "update"].includes(action)
            ? jsonPayload(flags)
            : undefined,
        );
  } else if (command === "domains") {
    const action = sub ?? "list";
    const domainId = action === "list" || action === "create" ? undefined : id;
    if (action === "delete") await platformMutation(flags, "delete domain");
    value = await api.governance(
      `domains${domainId ? `/${encodeURIComponent(domainId)}` : ""}${action === "verify" ? "/verify" : ""}`,
      action === "list" || action === "get"
        ? "GET"
        : action === "create"
          ? "POST"
          : action === "verify"
            ? "POST"
            : "DELETE",
      ["create", "verify"].includes(action) ? jsonPayload(flags) : undefined,
    );
  } else if (command === "admin") {
    const area = requiredArg(
      sub,
      "admin needs access, overview, settings, or policies",
    );
    const workspace = ["settings", "policies"].includes(area)
      ? requiredArg(id, "admin settings/policies needs WORKSPACE_ID")
      : undefined;
    const suffix = ["settings", "policies"].includes(area)
      ? `workspaces/${encodeURIComponent(workspace!)}/${area}${args[2] ? `/${encodeURIComponent(args[2])}` : ""}`
      : area;
    const method =
      ["settings", "policies"].includes(area) && args[2] ? "PUT" : "GET";
    value = await api.admin(
      suffix,
      method,
      method === "PUT" ? jsonPayload(flags) : undefined,
    );
  } else if (command === "graph") {
    if (sub === "search")
      value = await api.workspaceGraphSearch(
        requiredArg(id, "graph search needs WORKSPACE_ID"),
        {
          q: requiredArg(args[2], "graph search needs QUERY"),
          limit: flags.limit as string,
          cursor: flags.cursor as string,
        },
      );
    else {
      const share = requiredArg(id, "graph needs SHARE_ID");
      const query = {
        ...platformQuery(flags, [
          "revision",
          "limit",
          "cursor",
          "entity",
          "depth",
          "max-hops",
          "from",
          "to",
        ]),
        edgeTypes: csvFlag(flags, "edge-types"),
        entityTypes: csvFlag(flags, "entity-types"),
      };
      value =
        sub === "snapshot"
          ? await api.graphSnapshot(share, query)
          : sub === "neighbors"
            ? await api.graphNeighbors(share, query)
            : sub === "path"
              ? await api.graphPath(share, query)
              : sub === "diff"
                ? await api.graphDiff(share, query)
                : sub === "provenance"
                  ? await api.graphProvenance(share, query)
                  : sub === "related"
                    ? await api.graphRelated(share, query)
                    : (() => {
                        throw new Error(
                          "Usage: graph snapshot|neighbors|path|diff|provenance|related|search",
                        );
                      })();
    }
  } else if (command === "blame") {
    const share = requiredArg(id, "blame needs SHARE_ID");
    value =
      sub === "semantic"
        ? await api.semanticBlame(share, {
            revision: flags.revision as string,
            q: (flags.q as string) ?? args[2],
          })
        : sub === "line"
          ? await api.blame(share, { revision: flags.revision as string })
          : (() => {
              throw new Error("Usage: blame line|semantic SHARE_ID");
            })();
  } else if (command === "attest") {
    const share = requiredArg(id, "attest needs SHARE_ID");
    const revision = requiredArg(args[2], "attest needs REVISION");
    if (sub === "submit") {
      const payload = jsonPayload(flags) as Record<string, unknown>;
      assertNoPrivateKey(payload);
      if (flags["public-key"] !== undefined)
        payload.claim = {
          ...((payload.claim as object) ?? {}),
          key: flags["public-key"],
        };
      if (flags.signature !== undefined) payload.signature = flags.signature;
      if (flags["attester-id"] !== undefined)
        payload.attesterId = flags["attester-id"];
      if (!payload.claim || typeof payload.signature !== "string")
        throw new Error("attest submit needs claim/public key and --signature");
      value = await api.attestSubmit(share, revision, payload);
    } else if (sub === "list") value = await api.attestList(share, revision);
    else if (sub === "verify")
      value = await api.attestVerify(
        share,
        revision,
        flags["attestation-id"] as string | undefined,
      );
    else throw new Error("Usage: attest submit|list|verify SHARE_ID REVISION");
  } else if (command === "refs") {
    const share = requiredArg(id, "refs needs SHARE_ID");
    const refKinds: Record<string, string> = {
      branches: "branch",
      channels: "channel",
      tags: "tag",
      releases: "release",
    };
    if (refKinds[sub ?? ""]) {
      const operation = args[2] ?? "list";
      if (operation === "list") value = await api.refs(share);
      else if (operation === "resolve")
        value = await api.resolveRef(share, String(args[3] ?? "current"));
      else if (operation === "get")
        value = await api.ref(
          share,
          requiredArg(args[3], "refs get needs LABEL"),
        );
      else if (operation === "create")
        value = await api.createRef(share, {
          ...(jsonPayload(flags) as object),
          refType: refKinds[sub ?? ""],
          label: flags.label,
          targetRevisionId: flags["target-revision-id"],
        });
      else
        throw new Error(
          "Usage: refs channels|tags|releases|branches SHARE_ID list|resolve|get|create",
        );
    } else if (sub === "list") value = await api.refs(share);
    else if (sub === "get")
      value = await api.ref(
        share,
        requiredArg(args[2], "refs get needs LABEL"),
      );
    else if (sub === "resolve")
      value = await api.resolveRef(
        share,
        String(flags.spec ?? args[2] ?? "current"),
      );
    else if (sub === "create")
      value = await api.createRef(share, {
        ...(jsonPayload(flags) as object),
        refType: flags["ref-type"],
        label: flags.label,
        targetRevisionId: flags["target-revision-id"],
      });
    else if (sub === "move")
      value = await api.moveRef(
        share,
        requiredArg(args[2], "refs move needs LABEL"),
        {
          targetRevisionId: flags["target-revision-id"],
          expectedRevisionId: flags["expected-revision-id"] ?? null,
        },
      );
    else if (sub === "delete") {
      await platformMutation(flags, "delete ref");
      value = flags.dryRun
        ? { dryRun: true }
        : await api.deleteRef(
            share,
            requiredArg(args[2], "refs delete needs LABEL"),
            flags["expected-revision-id"] as string,
          );
    } else
      throw new Error(
        "Usage: refs list|get|create|move|delete|resolve SHARE_ID",
      );
  } else if (command === "proposals") {
    const proposal = requiredArg(id, `proposals ${sub} needs PROPOSAL_ID`);
    if (sub === "detail") value = await api.proposalDetail(proposal);
    else if (["merge", "reject", "reopen"].includes(sub ?? "")) {
      await platformMutation(flags, `proposals ${sub}`);
      value = flags.dryRun
        ? { dryRun: true, proposalId: proposal }
        : await api.proposalAction(
            proposal,
            sub as "merge" | "reject" | "reopen",
          );
    } else if (sub === "reviewer")
      value = await api.proposalReviewer(proposal, jsonPayload(flags));
    else if (sub === "review")
      value = await api.proposalReview(proposal, jsonPayload(flags));
    else if (sub === "comment")
      value = await api.proposalComment(proposal, {
        ...(jsonPayload(flags) as object),
        parentId: flags["parent-id"],
      });
    else if (sub === "check")
      value = await api.proposalCheck(proposal, jsonPayload(flags));
    else
      throw new Error(
        "Usage: proposals detail|reviewer|review|comment|check|reopen PROPOSAL_ID",
      );
  } else if (command === "roles" || command === "bindings") {
    const workspace = requiredArg(id, `${command} needs WORKSPACE_ID`);
    const target = args[2];
    if (command === "bindings")
      value =
        sub === "list"
          ? await api.bindings(workspace)
          : sub === "create"
            ? await api.bindingMutation(
                workspace,
                undefined,
                "POST",
                jsonPayload(flags),
              )
            : (await platformMutation(flags, "delete binding"),
              flags.dryRun
                ? { dryRun: true }
                : await api.bindingMutation(
                    workspace,
                    requiredArg(target, "bindings delete needs BINDING_ID"),
                    "DELETE",
                  ));
    else
      value =
        sub === "list"
          ? await api.roles(workspace)
          : sub === "get"
            ? await api.role(
                workspace,
                requiredArg(target, "roles get needs ROLE_ID"),
              )
            : sub === "create"
              ? await api.roleMutation(
                  workspace,
                  undefined,
                  "POST",
                  jsonPayload(flags),
                )
              : sub === "update"
                ? await api.roleMutation(
                    workspace,
                    requiredArg(target, "roles update needs ROLE_ID"),
                    "PATCH",
                    jsonPayload(flags),
                  )
                : (await platformMutation(flags, "delete role"),
                  flags.dryRun
                    ? { dryRun: true }
                    : await api.roleMutation(
                        workspace,
                        requiredArg(target, "roles delete needs ROLE_ID"),
                        "DELETE",
                      ));
  } else if (command === "orgs" || command === "teams") {
    const workspace = id;
    if (
      command === "orgs" &&
      (sub === "administrators" || sub === "administrator")
    ) {
      const action = args[1] ?? "get";
      const administratorWorkspace = requiredArg(
        args[2],
        "orgs administrators needs WORKSPACE_ID",
      );
      if (action === "get" || action === "list")
        value = await api.organizationAdministrators(administratorWorkspace);
      else if (action === "set" || action === "update") {
        await platformMutation(flags, "assign organization administrators");
        value = flags.dryRun
          ? { dryRun: true, workspaceId: administratorWorkspace }
          : await api.setOrganizationAdministrators(administratorWorkspace, {
              ...(jsonPayload(flags) as object),
              ...(flags["billing-owner-id"] !== undefined
                ? { billingOwnerId: flags["billing-owner-id"] }
                : {}),
              ...(flags["security-administrator-id"] !== undefined
                ? {
                    securityAdministratorId: flags["security-administrator-id"],
                  }
                : {}),
            });
      } else
        throw new Error(
          "Usage: orgs administrators get|set WORKSPACE_ID --data JSON",
        );
    } else if (command === "orgs")
      value =
        sub === "list"
          ? await api.organizations()
          : sub === "create"
            ? await api.organizationMutation(
                undefined,
                "POST",
                jsonPayload(flags),
              )
            : sub === "get"
              ? await api.organization(
                  requiredArg(workspace, "orgs get needs WORKSPACE_ID"),
                )
              : sub === "transfer"
                ? await api.transferOwnership(
                    requiredArg(workspace, "orgs transfer needs WORKSPACE_ID"),
                    requiredArg(
                      args[2] ?? (flags["user-id"] as string),
                      "orgs transfer needs USER_ID",
                    ),
                  )
                : await api.organizationMutation(
                    requiredArg(workspace, "orgs needs WORKSPACE_ID"),
                    sub === "update" ? "PATCH" : "DELETE",
                    jsonPayload(flags),
                  );
    else if (
      ["members", "member-add", "member-list", "member-delete"].includes(
        sub ?? "",
      )
    ) {
      const team = requiredArg(args[2], "teams member operation needs TEAM_ID");
      const operation =
        sub === "members" ? (args[3] ?? "list") : sub.replace("member-", "");
      if (operation === "delete")
        await platformMutation(flags, "remove team member");
      value = await api.teamMembers(
        requiredArg(workspace, "teams needs WORKSPACE_ID"),
        team,
        operation === "delete" ? args[4] : undefined,
        operation === "list" ? "GET" : operation === "add" ? "POST" : "DELETE",
        operation === "add" ? jsonPayload(flags) : undefined,
      );
    } else
      value =
        sub === "list"
          ? await api.teams(requiredArg(workspace, "teams needs WORKSPACE_ID"))
          : await api.teamMutation(
              requiredArg(workspace, "teams needs WORKSPACE_ID"),
              sub === "create" ? undefined : args[2],
              sub === "create"
                ? "POST"
                : sub === "update"
                  ? "PATCH"
                  : sub === "delete"
                    ? "DELETE"
                    : "GET",
              jsonPayload(flags),
            );
  } else if (command === "service-accounts") {
    const workspace = requiredArg(id, "service-accounts needs WORKSPACE_ID");
    const account = args[2];
    if (sub === "list") value = await api.serviceAccounts(workspace);
    else if (sub === "get")
      value = await api.serviceAccountMutation(
        workspace,
        requiredArg(account, "get needs ACCOUNT_ID"),
        "GET",
      );
    else if (sub === "create")
      value = await api.serviceAccountMutation(
        workspace,
        undefined,
        "POST",
        jsonPayload(flags),
      );
    else if (sub === "credentials")
      value = await api.credentials(
        workspace,
        requiredArg(account, "credentials needs ACCOUNT_ID"),
      );
    else if (["issue", "rotate"].includes(sub ?? "")) {
      const credential =
        sub === "rotate"
          ? requiredArg(args[3], "rotate needs CREDENTIAL_ID")
          : undefined;
      value = await api.credentialMutation(
        workspace,
        requiredArg(account, "credential needs ACCOUNT_ID"),
        credential,
        "POST",
        jsonPayload(flags),
      );
    } else if (["enable", "disable"].includes(sub ?? "")) {
      await platformMutation(flags, `service account ${sub}`);
      value = flags.dryRun
        ? { dryRun: true, workspaceId: workspace, accountId: account }
        : sub === "enable"
          ? await api.serviceAccountEnable(
              workspace,
              requiredArg(account, "enable needs ACCOUNT_ID"),
            )
          : await api.serviceAccountDisable(
              workspace,
              requiredArg(account, "disable needs ACCOUNT_ID"),
            );
    } else if (sub === "revoke") {
      await platformMutation(flags, "revoke credential");
      value = flags.dryRun
        ? { dryRun: true }
        : await api.credentialMutation(
            workspace,
            requiredArg(account, "revoke needs ACCOUNT_ID"),
            requiredArg(args[3], "revoke needs CREDENTIAL_ID"),
            "DELETE",
          );
    } else throw new Error("Unknown service-account operation");
  } else if (command === "audit")
    value =
      sub === "export"
        ? await api.auditExport(
            (flags.format as "csv" | "ndjson") ?? "ndjson",
            platformQuery(flags, [
              "action",
              "actor-type",
              "actor-id",
              "category",
              "outcome",
              "resource-id",
              "from",
              "to",
              "limit",
              "cursor",
            ]),
          )
        : sub === "verify"
          ? await api.auditVerify()
          : await api.audit(
              platformQuery(flags, [
                "action",
                "actor-type",
                "actor-id",
                "category",
                "outcome",
                "resource-id",
                "from",
                "to",
                "limit",
              ]),
            );
  else if (command === "siem") {
    const workspace = requiredArg(id, "siem needs WORKSPACE_ID");
    value =
      sub === "list"
        ? await api.siem(workspace)
        : await api.siemMutation(
            workspace,
            sub === "create" ? undefined : args[2],
            sub === "create"
              ? "POST"
              : sub === "update"
                ? "PATCH"
                : sub === "delete"
                  ? "DELETE"
                  : "GET",
            jsonPayload(flags),
          );
    if (sub === "create" && value && typeof value === "object") {
      const { secret: _secret, ...safe } = value as Record<string, unknown>;
      value = safe;
    }
  } else if (command === "governance") {
    const area = requiredArg(
      sub,
      "governance needs retention, legal-hold, or policy",
    );
    const action = args[1] ?? "list";
    const resource =
      area === "policy"
        ? `policy/${requiredArg((flags["policy-type"] as string) ?? args[2], "policy needs POLICY_TYPE")}`
        : area;
    const item = area === "policy" ? args[3] : args[2];
    const path =
      action === "list"
        ? resource
        : `${resource}${item ? `/${item}` : ""}${action === "release" ? "/release" : ""}`;
    value = await api.governance(
      path,
      action === "list" || action === "get"
        ? "GET"
        : action === "create"
          ? "POST"
          : action === "update"
            ? "PATCH"
            : action === "put"
              ? "PUT"
              : action === "delete"
                ? "DELETE"
                : "POST",
      ["create", "update", "put", "release"].includes(action)
        ? jsonPayload(flags)
        : undefined,
    );
  } else if (command === "export")
    value = await api.portability(
      (sub ?? "workspace") as "workspace" | "share" | "account",
      (flags["share-id"] as string) ?? id,
      {
        format: (flags.format as string) ?? "ndjson",
        intent: flags.intent as string,
      },
    );
  else if (command === "retention") {
    await platformMutation(flags, "apply retention");
    value =
      flags.dryRun || sub === "dry-run"
        ? await api.retention(false)
        : await api.retention(true, {
            apply: true,
            confirmation: "APPLY_RETENTION",
          });
  } else if (command === "billing") value = await api.billing();
  else if (command === "ops") {
    const opsQuery = platformQuery(flags, ["timeout", "window-hours"]);
    const target = flags.target ?? flags["target-slo"];
    if (target !== undefined) opsQuery.target = String(target);
    value = await api.ops(
      (sub ?? "status") as "status" | "dependencies" | "slo",
      opsQuery,
    );
  } else throw new Error(`Unknown platform command: ${command}`);
  out(resultEnvelope(command, { data: redactPlatformSecrets(value) }), flags);
}
async function main(argv: string[]) {
  if (argv.includes("--version")) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  const { positional, flags } = parseFlags(argv);
  let [command, ...args] = positional;
  if (command === "push") command = "update";
  if (command && command !== "help" && command !== "--help")
    validateCommandFlags(command, flags);
  if (!command || command === "--help" || command === "help") {
    out(
      'npx okfshare@latest <setup|login|logout|whoami|doctor|init|validate|publish|list|open|update|push|rollback|log|diff|pull|search|context|bind|unbind|status|fork|proposals|graph|blame|attest|refs|roles|bindings|orgs|teams|service-accounts|share-access|annotations|webhooks|rulesets|domains|audit|siem|governance|export|retention|billing|ops|integrity|capabilities|workspace-search|stars|redact|schema|skills|version>\n\nExamples:\n  npx okfshare@latest setup\n  npx okfshare@latest init ./knowledge --title "My notes"\n  npx okfshare@latest publish ./knowledge --yes\n  npx okfshare@latest graph snapshot SHARE_ID --json\n  npx okfshare@latest fork sync FORK_ID --yes --json\n  npx okfshare@latest bind SHARE_ID ./knowledge --revision 3\n\nUse npx okfshare@latest <command> --help for command-specific flags.',
      flags,
    );
    return;
  }
  if (flags.help === true) {
    out(commandHelp[command] ?? `npx okfshare@latest ${command} --help`, flags);
    return;
  }
  if (command === "completions") {
    const shell = args[0] ?? "";
    const completions = completionScript(shell);
    if (!completions)
      throw new Error("Unsupported shell; use bash, zsh, or fish");
    process.stdout.write(completions);
    return;
  }
  if (command === "schema") {
    const selected = flags["command"];
    const available = [...commands].filter(
      (name) => name !== "completions" && name !== "version",
    );
    const emit = (name: string) => {
      const spec = commandSpecs[name];
      const included: Record<
        string,
        { type: string; default?: unknown; hint?: string }
      > = {};
      for (const [key, value] of Object.entries(spec?.flags ?? {}))
        included[key] = {
          type: value.type,
          ...(value.default !== undefined ? { default: value.default } : {}),
          ...(value.hint ? { hint: value.hint } : {}),
        };
      return {
        name,
        help: commandHelp[name] ?? `npx okfshare@latest ${name} --help`,
        description: spec?.description ?? "okfshare command",
        positional: spec?.args ?? [],
        flags: included,
        mutates: spec?.mutates ?? false,
      };
    };
    const payload = selected
      ? emit(String(selected))
      : {
          name: "okfshare",
          version: CLI_VERSION,
          output: { tty: "text", ipc: "text", json: "--json" },
          exitCodes: EXIT_CODES,
          note: "Pass --command <name> to inspect one command's JSON Schema. Every command keeps its documented help line in help.",
          commands: Object.fromEntries(
            available.map((name) => [name, emit(name)]),
          ),
        };
    out(flags.json || selected ? payload : yieldHumanSchema(payload), flags);
    return;
  }
  if (command === "init") {
    const directory = args[0] ?? ".";
    const created = await scaffoldBundle(directory, {
      title: typeof flags.title === "string" ? flags.title : undefined,
      description:
        typeof flags.description === "string" ? flags.description : undefined,
    });
    out(
      resultEnvelope("init", {
        bundle: { path: directory, files: created.length },
        created,
        next: [`npx okfshare@latest validate ${directory}`],
      }),
      flags,
    );
    return;
  }
  if (typeof flags.password === "string")
    throw new Error(
      "Direct --password is refused; use the hidden interactive prompt or --password-stdin to avoid shell history",
    );
  if (command === "version") {
    out(
      flags.json
        ? resultEnvelope("version", {
            version: CLI_VERSION,
            schemaVersion: RESULT_SCHEMA_VERSION,
            node: process.versions.node,
          })
        : `okfshare ${CLI_VERSION} (schema ${RESULT_SCHEMA_VERSION})`,
      flags,
    );
    return;
  }
  if (command === "setup") {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const selectedAdapters =
      typeof flags.adapter === "string"
        ? flags.adapter
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined;
    const preflight = {
      node: process.versions.node,
      nodeSupported: nodeMajor >= 20,
      npx: isNpxExecutable(),
      adapters: detectTargets({
        scope: (flags.scope as "user" | "project" | undefined) ?? "user",
        projectDir:
          typeof flags.project === "string" ? flags.project : undefined,
        adapters: selectedAdapters as
          import("@okfshare/agent-installer").AdapterId[] | undefined,
      }),
    };
    if (!preflight.nodeSupported)
      throw new Error("Node.js 20 or newer is required");
    if (!preflight.npx)
      throw new Error(
        "npx is not executable; install Node.js with npm/npx and retry",
      );
    const adapter = new AgentSkillsAdapter({
      scope: (flags.scope as "user" | "project" | undefined) ?? "user",
      projectDir: typeof flags.project === "string" ? flags.project : undefined,
      dryRun: flags.dryRun,
      yes: Boolean(flags.yes),
      adapters: selectedAdapters as
        import("@okfshare/agent-installer").AdapterId[] | undefined,
    });
    let setup: unknown;
    if (!flags["no-skills"]) {
      await confirmChange(flags, "install the okfshare skill");
      const installed = await adapter.install("okfshare");
      setup = installed;
      if (!flags.json) out(installed, flags);
    }
    if (!flags["no-auth"] && !flags.dryRun) {
      const baseUrl = apiBaseUrl(flags);
      const auth = await login(
        flags,
        new ApiClient({ baseUrl }),
        store,
        baseUrl,
      );
      const identity = await (await authClient(flags)).whoami();
      out(
        flags.json
          ? resultEnvelope("setup", {
              status: "ready",
              preflight,
              setup: { installation: setup, auth, identity },
            })
          : "Setup complete.",
        flags,
      );
    } else {
      const partial = flags["no-auth"] === true && !flags.dryRun;
      const result = resultEnvelope("setup", {
        status: "partial",
        preflight,
        setup: { installation: setup },
        next: [
          {
            code: "AUTHENTICATION_REQUIRED",
            message: "Run npx okfshare@latest login to complete setup",
          },
        ],
      });
      if (flags.json) out(result, flags);
      else
        out(
          partial
            ? "Setup partially complete. Run npx okfshare@latest login to finish."
            : "Setup dry-run complete; no changes were made.",
          flags,
        );
      if (partial) process.exitCode = EXIT_CODES.partial;
    }
    return;
  }
  if (command === "login") {
    const baseUrl = apiBaseUrl(flags);
    const result = await login(
      flags,
      new ApiClient({
        baseUrl,
        timeoutMs:
          flags.timeout === undefined
            ? undefined
            : parseBoundedInteger(flags.timeout, "timeout", 1, 300_000),
      }),
      store,
      baseUrl,
    );
    if (flags.json)
      out(resultEnvelope("login", result ?? { status: "approved" }), flags);
    return;
  }
  if (command === "logout") {
    await store.delete();
    out(flags.json ? { status: "logged_out" } : "Logged out.", flags);
    return;
  }
  if (command === "whoami") {
    const identity = await (await authClient(flags)).whoami();
    out(
      flags.json
        ? resultEnvelope("whoami", { status: "ready", identity })
        : identity,
      flags,
    );
    return;
  }
  if (command === "doctor") {
    const apiUrl =
      typeof flags["api-url"] === "string"
        ? flags["api-url"]
        : (process.env.OKFSHARE_API_URL ?? "https://okfshare.app");
    const checks: Record<string, unknown> = {
      node: {
        version: process.versions.node,
        supported: Number(process.versions.node.split(".")[0]) >= 20,
      },
      npx: {
        executable: isNpxExecutable(),
      },
      api: {
        url: apiUrl,
        origin: (() => {
          try {
            return new URL(apiUrl).origin;
          } catch {
            return undefined;
          }
        })(),
      },
      credentials: await store.status(),
      cwd: { path: process.cwd() },
    };
    try {
      checks.skill = await new AgentSkillsAdapter({ scope: "user" }).status(
        "okfshare",
      );
    } catch (error) {
      checks.skill = {
        error: error instanceof Error ? error.message : "unavailable",
      };
    }
    try {
      checks.binding = await bindingStatus(".");
    } catch (error) {
      checks.binding = {
        bound: false,
        error: error instanceof Error ? error.message : "invalid",
      };
    }
    const token = await tokenFrom(store).catch(() => undefined);
    try {
      checks.api = {
        ...(checks.api as object),
        health: await new ApiClient({
          baseUrl: apiUrl,
          timeoutMs: 5_000,
          retries: 1,
          userAgent: `okfshare-cli/${CLI_VERSION}`,
        }).health(),
      };
    } catch (error) {
      checks.api = {
        ...(checks.api as object),
        reachable: false,
        error: error instanceof Error ? error.message : "unreachable",
      };
    }
    if (token) {
      try {
        const identity = await (await authClient(flags)).whoami();
        checks.auth = {
          authenticated: true,
          identity,
          scopes:
            (identity as Record<string, unknown>).scopes ?? "server-reported",
          expiry:
            (identity as Record<string, unknown>).expiresAt ??
            "server-reported",
          revoked: false,
          publish: "server-verified",
        };
      } catch (error) {
        checks.auth = {
          authenticated: false,
          error:
            error instanceof Error ? error.message : "authentication failed",
        };
      }
    } else
      checks.auth = {
        authenticated: false,
        remediation: "Run npx okfshare@latest login",
      };
    if ((checks.binding as { bound?: boolean }).bound) {
      const binding = (
        checks.binding as { binding?: { bundlePath: string; digest?: string } }
      ).binding;
      try {
        const bundle = await collectBundle(binding?.bundlePath ?? ".");
        checks.binding = {
          ...(checks.binding as object),
          local: {
            valid: validateBundle(bundle).length === 0,
            digest: bundleDigest(bundle),
            diverged: bundleDigest(bundle) !== binding?.digest,
          },
        };
      } catch (error) {
        checks.binding = {
          ...(checks.binding as object),
          local: {
            valid: false,
            error: error instanceof Error ? error.message : "invalid bundle",
          },
        };
      }
    }
    const ok = Boolean(
      (checks.node as { supported: boolean }).supported &&
      (checks.npx as { executable: boolean }).executable,
    );
    out(
      flags.json
        ? resultEnvelope("doctor", {
            ok,
            status: ok ? "ready" : "failed",
            checks,
          })
        : checks,
      flags,
    );
    if (!ok) process.exitCode = EXIT_CODES.usage;
    return;
  }
  const platformCommands = new Set([
    "fork",
    "capabilities",
    "workspace-search",
    "source",
    "stars",
    "redact",
    "integrity",
    "share-access",
    "annotations",
    "webhooks",
    "rulesets",
    "domains",
    "admin",
    "graph",
    "blame",
    "attest",
    "refs",
    "roles",
    "bindings",
    "orgs",
    "teams",
    "service-accounts",
    "audit",
    "siem",
    "governance",
    "export",
    "retention",
    "billing",
    "ops",
  ]);
  if (
    platformCommands.has(command) ||
    (command === "proposals" &&
      ["detail", "reviewer", "review", "comment", "check", "reopen"].includes(
        args[0] ?? "",
      ))
  ) {
    await platformCommand(command, args, flags);
    return;
  }
  if (command === "bind") {
    const shareId = args[0];
    const directory = args[1] ?? ".";
    if (!shareId) throw new Error("A share id is required");
    const bundle = await collectBundle(directory);
    const binding = await writeBinding(directory, {
      shareId,
      bundlePath: ".",
      revision: typeof flags.revision === "string" ? flags.revision : undefined,
      digest: bundleDigest(bundle),
    });
    await rememberBundle({
      dir: directory,
      shareId,
      slug: "",
      title: "",
      revision:
        typeof flags.revision === "string" ? Number(flags.revision) || 0 : 0,
      digest: bundleDigest(bundle),
    });
    out(
      resultEnvelope("bind", {
        status: "ready",
        workspace: { shareId },
        binding,
        next: [`npx okfshare@latest push ${directory} --yes`],
      }),
      flags,
    );
    return;
  }
  if (command === "unbind") {
    await removeBinding(args[0] ?? ".");
    await forgetBundle(args[0] ?? ".");
    out(
      resultEnvelope("unbind", {
        status: "ready",
        next: ["npx okfshare@latest status"],
      }),
      flags,
    );
    return;
  }
  if (command === "status") {
    const targetDir = args[0];
    const cwdBound = targetDir ? null : await bindingStatus(".");
    if (!targetDir && !cwdBound?.bound) {
      const bundles = await listBundles();
      out(
        resultEnvelope("status", {
          status: "ready",
          workspace: {
            bundles: bundles.map((bundle) => ({
              dir: bundle.dir,
              shareId: bundle.shareId,
              revision: bundle.revision,
              stale: false,
            })),
          },
          next: bundles.length
            ? ["npx okfshare@latest status <dir>"]
            : ["npx okfshare@latest init <dir>"],
        }),
        flags,
      );
      return;
    }
    const status = await (targetDir ? bindingStatus(targetDir) : cwdBound!);
    if (status.bound && status.binding) {
      try {
        const current = await collectBundle(status.binding.bundlePath);
        status.stale =
          status.stale || status.binding.digest !== bundleDigest(current);
        (status as Record<string, unknown>).digest = bundleDigest(current);
      } catch {
        status.stale = true;
      }
    }
    out(
      resultEnvelope("status", {
        status: status.stale ? "partial" : "ready",
        workspace: status,
        next: status.stale
          ? ["npx okfshare@latest pull <SHARE_ID> <fresh-dir> --yes"]
          : [`npx okfshare@latest push . --yes`],
      }),
      flags,
    );
    return;
  }
  if (command === "validate") {
    const directory = args[0] ?? ".";
    const bundle = await collectBundleWithOverrides(
      directory,
      bundleOverrides(flags),
    );
    const errors = bundle.root
      ? validateBundle(bundle)
      : ["A bundle-root README.md or index.md is required"];
    if (errors.length) throw new Error(errors.join("; "));
    out(
      resultEnvelope("validate", {
        bundle: bundleSummary(directory, bundle),
        validation: { valid: true, errors: [], warnings: [] },
        next: [`npx okfshare@latest publish ${directory} --yes`],
      }),
      flags,
    );
    return;
  }
  if (command === "publish" || command === "update") {
    let shareId = args[0];
    let directory = command === "publish" ? (args[0] ?? ".") : args[1];
    if (command === "update" && !directory) {
      const bound = await bindingStatus(".");
      if (bound.stale)
        throw new Error(
          "Cannot update from a stale project binding; restore or rebind the bundle first",
        );
      if (bound.bound && bound.binding) {
        shareId = bound.binding.shareId;
        directory = bound.binding.bundlePath;
      }
    }
    if (!directory) throw new Error("A directory is required");
    if (command === "update" && !shareId)
      throw new Error(
        "A share id or an unambiguous project binding is required",
      );
    const payload = await bundlePayload(directory, flags);
    await confirmChange(flags, command);
    if (flags.dryRun) {
      out(
        resultEnvelope(command, {
          dryRun: true,
          bundle: {
            path: directory,
            files: payload.files.map((file) => file.path).length,
            digest: bundleDigest(payload),
          },
          share: command === "update" ? { id: shareId } : undefined,
        }),
        flags,
      );
      return;
    }
    const api = await authClient(flags);
    const fileFlags = Array.isArray(flags.file) ? (flags.file as string[]) : [];
    const patchMode = command === "update" && fileFlags.length > 0;
    let baseRevision: string | number = "";
    if (patchMode) {
      const desired =
        typeof flags["expected-revision"] === "string"
          ? flags["expected-revision"]
          : "current";
      if (desired === "current") {
        const revisions = await api.revisions(shareId!);
        const data =
          (revisions as { data?: { number?: number; id?: string }[] }).data ??
          [];
        const latest = data[data.length - 1];
        if (!latest?.number)
          throw new Error(
            "Cannot determine the current revision for patch mode",
          );
        baseRevision = latest.number;
      } else {
        baseRevision = desired;
      }
    }
    const patchFiles = patchMode
      ? payload.files
          .filter(
            (file) =>
              fileFlags.includes(file.path) ||
              fileFlags.some((requested) =>
                file.path.endsWith(`/${requested}`),
              ),
          )
          .map(({ path, content }) => ({ path, content }))
      : [];
    if (patchMode && patchFiles.length === 0)
      throw new Error(
        "No patch files matched in the bundle; check --file paths or use full update",
      );
    const result =
      command === "publish"
        ? await api.publish(payload, randomUUID())
        : patchMode
          ? await api.patch(
              shareId!,
              { files: patchFiles },
              randomUUID(),
              baseRevision,
            )
          : await api.update(
              shareId!,
              payload,
              randomUUID(),
              typeof flags["expected-revision"] === "string"
                ? flags["expected-revision"]
                : undefined,
            );
    const published = (result ?? {}) as Record<string, unknown>;
    const publishedShare = (published.share ?? {}) as Record<string, unknown>;
    const publishedRevision = (published.revision ?? {}) as Record<
      string,
      unknown
    >;
    out(
      resultEnvelope(command, {
        share: result,
        bundle: {
          path: directory,
          files: payload.files.length,
          digest: bundleDigest(payload),
        },
        next:
          command === "publish"
            ? [
                `npx okfshare@latest bind ${str(publishedShare.id)} ${directory}`,
                `npx okfshare@latest open ${str(publishedShare.id)}`,
              ]
            : [`npx okfshare@latest log ${shareId}`],
      }),
      flags,
    );
    if (typeof publishedShare.id === "string")
      await rememberBundle({
        dir: directory,
        shareId: publishedShare.id,
        slug:
          typeof publishedShare.slug === "string" ? publishedShare.slug : "",
        title:
          typeof publishedShare.title === "string" ? publishedShare.title : "",
        revision:
          typeof publishedRevision.number === "number"
            ? publishedRevision.number
            : 0,
        digest: bundleDigest(payload),
      });
    if (command === "update") {
      const bound = await bindingStatus(directory);
      if (
        bound.bound &&
        bound.binding &&
        bound.binding.shareId === shareId &&
        !flags.dryRun
      ) {
        const revision = (result as Record<string, unknown>).revision;
        await writeBinding(directory, {
          ...bound.binding,
          bundlePath: directory,
          revision:
            typeof revision === "object" && revision && "number" in revision
              ? String((revision as { number: number }).number)
              : bound.binding.revision,
          digest: bundleDigest(payload),
        });
      }
    }
    return;
  }
  if (command === "list") {
    const topic = Array.isArray(flags.topic)
      ? (flags.topic[0] as string)
      : typeof flags.topic === "string"
        ? flags.topic
        : undefined;
    const shares = await (await authClient(flags)).list(topic);
    out(resultEnvelope("list", { shares }), flags);
    return;
  }
  if (command === "open") {
    if (!args[0]) throw new Error("An id or slug is required");
    const share = await (await authClient(flags)).open(args[0]);
    out(resultEnvelope("open", { share }), flags);
    return;
  }
  if (command === "rollback") {
    if (!args[0] || !args[1])
      throw new Error("An id or slug and revision are required");
    await confirmChange(flags, command);
    if (flags.dryRun)
      out(
        resultEnvelope(command, {
          dryRun: true,
          share: { id: args[0], revision: args[1] },
        }),
        flags,
      );
    else
      out(
        resultEnvelope("rollback", {
          share: await (
            await authClient(flags)
          ).rollback(
            args[0],
            args[1],
            randomUUID(),
            typeof flags["expected-revision"] === "string"
              ? flags["expected-revision"]
              : undefined,
          ),
          next: [
            `npx okfshare@latest open ${args[0]}`,
            `npx okfshare@latest log ${args[0]}`,
          ],
        }),
        flags,
      );
    return;
  }
  if (command === "diff") {
    if (!args[0] || !args[1] || !args[2])
      throw new Error(
        "A share id, from revision, and to revision are required",
      );
    const from = parsePositiveInteger(args[1], "from revision");
    const to = parsePositiveInteger(args[2], "to revision");
    const result = await (await authClient(flags)).diff(args[0], from, to);
    out(resultEnvelope("diff", { diff: result }), flags);
    return;
  }
  if (command === "proposals") {
    const sub = args[0];
    if (sub === "list") {
      if (!args[1]) throw new Error("proposals list needs SHARE_ID");
      const list = await (await authClient(flags)).proposals(args[1]);
      out(
        resultEnvelope("proposals", {
          shareId: args[1],
          proposals: (list as { data?: unknown[] }).data ?? [],
        }),
        flags,
      );
      return;
    }
    if (sub === "propose") {
      if (!args[1]) throw new Error("proposals propose needs SHARE_ID");
      const fromShareId = flags["from-share"];
      if (typeof fromShareId !== "string")
        throw new Error("proposals propose requires --from-share FORK_ID");
      const title =
        typeof flags.title === "string" ? flags.title : "Propose changes";
      const description =
        typeof flags.description === "string" ? flags.description : "";
      const result = await (
        await authClient(flags)
      ).propose(args[1], { fromShareId, title, description });
      out(
        resultEnvelope("proposals", {
          proposal: result,
          next: [
            `npx okfshare@latest proposals merge ${str((result as Record<string, unknown>).id)}`,
          ],
        }),
        flags,
      );
      return;
    }
    if (sub === "merge" || sub === "reject") {
      if (!args[1]) throw new Error(`proposals ${sub} needs PROPOSAL_ID`);
      await confirmChange(flags, `proposals ${sub}`);
      const result =
        sub === "merge"
          ? await (await authClient(flags)).mergeProposal(args[1])
          : await (await authClient(flags)).rejectProposal(args[1]);
      out(
        resultEnvelope(`proposal-${sub}`, {
          proposal: result,
        }),
        flags,
      );
      return;
    }
    throw new Error(
      "Usage: npx okfshare@latest proposals list|propose|merge|reject ...",
    );
  }
  if (command === "explore") {
    const topic =
      typeof flags.topic === "string"
        ? flags.topic
        : Array.isArray(flags.topic)
          ? (flags.topic[0] as string)
          : undefined;
    const limit =
      flags.limit === undefined
        ? undefined
        : parseBoundedInteger(flags.limit, "limit", 1, 100);
    const data = await (await authClient(flags)).explore(topic, limit);
    out(
      resultEnvelope("explore", {
        explore: (data as { data?: unknown[] }).data ?? [],
      }),
      flags,
    );
    return;
  }
  if (command === "fork") {
    if (!args[0]) throw new Error("An id or slug is required");
    await confirmChange(flags, command);
    if (flags.dryRun)
      out(
        resultEnvelope("fork", { dryRun: true, share: { id: args[0] } }),
        flags,
      );
    else {
      const forked = await (await authClient(flags)).fork(args[0]);
      const forkShare = (forked ?? {}) as Record<string, unknown>;
      out(
        resultEnvelope("fork", {
          share: forked,
          next: [
            `npx okfshare@latest open ${str(forkShare.id)}`,
            `npx okfshare@latest search ${str(forkShare.id)} "what changed"`,
          ],
        }),
        flags,
      );
    }
    return;
  }
  if (command === "pull") {
    let shareId = args[0];
    let destination = args[1];
    if (args.length === 1) {
      const bound = await bindingStatus(".");
      if (bound.stale)
        throw new Error(
          "Cannot pull from a stale project binding; restore or rebind the bundle first",
        );
      if (bound.bound && bound.binding) {
        shareId = bound.binding.shareId;
        destination = args[0];
      }
    }
    if (!shareId || !destination)
      throw new Error("A share id and destination are required");
    const revision = parseRevision(flags.revision ?? "current");
    await confirmChange(flags, "pull the share bundle");
    const response = await (await authClient(flags)).bundle(shareId, revision);
    const result = await pullBundle(
      response,
      destination,
      Boolean(flags.dryRun),
    );
    if (!flags.dryRun) {
      const bound = await bindingStatus(".");
      if (bound.bound && bound.binding && bound.binding.shareId === shareId) {
        try {
          const pulledBundle = await collectBundle(destination);
          await writeBinding(".", {
            ...bound.binding,
            bundlePath: destination,
            revision: String(result.revision.number),
            digest: bundleDigest(pulledBundle),
          });
        } catch {}
      }
      await rememberBundle({
        dir: destination,
        shareId,
        slug: "",
        title: "",
        revision: result.revision.number,
        digest: "",
      });
    }
    out(
      resultEnvelope("pull", {
        ...result,
        dryRun: Boolean(flags.dryRun),
        next: [`npx okfshare@latest status ${destination}`],
      }),
      flags,
    );
    return;
  }
  if (command === "log") {
    if (!args[0]) throw new Error("An id or slug is required");
    const history = await (await authClient(flags)).revisions(args[0]);
    const revisions = Array.isArray(history.data) ? history.data : [];
    out(
      resultEnvelope("log", {
        share: { id: args[0] },
        revisions,
        next: [`npx okfshare@latest diff ${args[0]} 1 ${revisions.length}`],
      }),
      flags,
    );
    return;
  }
  if (command === "search" || command === "context") {
    let shareId = args[0];
    let query = args[1];
    let boundRevision: string | undefined;
    if (args.length === 1) {
      const bound = await bindingStatus(".");
      if (bound.bound && bound.binding) {
        shareId = bound.binding.shareId;
        query = args[0];
        boundRevision = bound.binding.revision;
      }
    }
    if (!shareId || !query)
      throw new Error("A share id and query are required");
    const revision = parseRevision(
      flags.revision ?? boundRevision ?? "current",
    );
    const numericFlag = (key: string): number | undefined => {
      const value = flags[key];
      if (value === undefined) return undefined;
      return key === "limit"
        ? parseBoundedInteger(value, key, 1, 100)
        : parseBoundedInteger(value, key, 500, 16_000);
    };
    const api = await authClient(flags);
    const result =
      command === "search"
        ? await api.search(
            shareId,
            query,
            revision,
            numericFlag("limit"),
            typeof flags.mode === "string" ? flags.mode : undefined,
          )
        : await api.context(
            shareId,
            query,
            revision,
            numericFlag("max-tokens"),
          );
    out(resultEnvelope(command, { [command]: result }), flags);
    return;
  }
  if (command === "skills") {
    const [subcommand, name = "okfshare"] = args;
    const adapter = new AgentSkillsAdapter({
      scope: (flags.scope as "user" | "project" | undefined) ?? "user",
      projectDir: typeof flags.project === "string" ? flags.project : undefined,
      dryRun: flags.dryRun,
      yes: Boolean(flags.yes),
    });
    if (subcommand === "status") out(await adapter.status(name), flags);
    else {
      await confirmChange(flags, `change the ${name} skill installation`);
      out(
        subcommand === "install"
          ? await adapter.install(name)
          : subcommand === "uninstall"
            ? await adapter.uninstall(name)
            : (() => {
                throw new Error(
                  "Usage: npx okfshare@latest skills install|status|uninstall [okfshare]",
                );
              })(),
        flags,
      );
    }
    return;
  }
  throw new Error(`Unknown command: ${command}${didYouMean(command)}`);
}

export const didYouMean = (input: string) => {
  const threshold = 3;
  let best: string | null = null;
  let bestDistance = threshold;
  for (const candidate of commands) {
    const distance = levenshtein(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (
    input.startsWith(best ?? "\u0000") &&
    best !== input &&
    bestDistance === threshold
  )
    best = null;
  if (best === input || (best && input.startsWith(best) && best !== input))
    return "";
  return best ? `\nDid you mean: ${best}?` : "";
};

export const levenshtein = (a: string, b: string) => {
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let index = 1; index <= a.length; index++) {
    let diagonal = prev[0]!;
    prev[0] = index;
    for (let j = 1; j <= b.length; j++) {
      const prior = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a[index - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = prior;
    }
  }
  return prev[b.length]!;
};
export function isEntryPoint(
  argvPath: string | undefined,
  modulePath = fileURLToPath(import.meta.url),
) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1]))
  main(process.argv.slice(2)).catch((error: unknown) => {
    let parsed: ReturnType<typeof parseFlags>;
    try {
      parsed = parseFlags(process.argv.slice(2));
    } catch {
      parsed = {
        positional: [],
        flags: { json: process.argv.includes("--json"), dryRun: false },
      };
    }
    const secrets = [parsed.flags.password, process.env.OKFSHARE_TOKEN].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const message = redactSecrets(
      error instanceof ApiError && error.status === 401
        ? "Authentication failed"
        : error instanceof Error
          ? error.message
          : "Unexpected error",
      secrets,
    );
    const json = process.argv.includes("--json");
    const status = error instanceof ApiError ? error.status : undefined;
    const classified = classifyCliError(error);
    const hint = errorHint(message);
    const exitCode =
      message === "Cancelled"
        ? EXIT_CODES.cancelled
        : status === 401 || status === 403
          ? EXIT_CODES.auth
          : status === 409
            ? EXIT_CODES.conflict
            : status && status >= 500
              ? EXIT_CODES.network
              : error instanceof Error &&
                  /usage|required|unknown flag|must be|invalid/i.test(message)
                ? EXIT_CODES.usage
                : classified.exitCode;
    if (json)
      process.stdout.write(
        `${JSON.stringify({
          ...resultEnvelope(process.argv[2] ?? "unknown", {
            ok: false,
            status: message === "Cancelled" ? "cancelled" : "failed",
            errors: [
              {
                code:
                  status === 401
                    ? "AUTHENTICATION_REQUIRED"
                    : status === 409
                      ? "CONFLICT"
                      : classified.code,
                message,
                status,
                ...(error instanceof ApiError && error.details !== undefined
                  ? { details: error.details }
                  : {}),
                ...(hint.hint ? { hint: hint.hint } : {}),
              },
            ],
            next: hint.next ?? [],
          }),
        })}\n`,
      );
    else {
      process.stderr.write(`✗ ${message}\n`);
      if (hint.hint) process.stderr.write(`  ${hint.hint}\n`);
      if (hint.next?.length) {
        process.stderr.write("  try:\n");
        for (const step of hint.next) process.stderr.write(`    ${step}\n`);
      }
    }
    process.exitCode = exitCode;
  });
