#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  args: (args: Record<string, unknown>) => string[];
  allowed?: string;
  oneTimeCredential?: boolean;
};

const CLI = process.env.OKFSHARE_CLI ?? "npx okfshare@latest";

const runCli = (args: string[]) =>
  new Promise<{ stdout: string; stderr: string; exit: number }>((resolve) => {
    const parts = CLI.split(/\s+/);
    const child = spawn(parts[0]!, parts.slice(1).concat(args), {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutText = "";
    let stderrText = "";
    child.stdout.on("data", (chunk) => (stdoutText += chunk));
    child.stderr.on("data", (chunk) => (stderrText += chunk));
    child.on("close", (exit) =>
      resolve({ stdout: stdoutText, stderr: stderrText, exit: exit ?? 1 }),
    );
  });

const list = (args: Record<string, unknown>) => [
  "list",
  ...(args.topic ? ["--topic", String(args.topic)] : []),
  "--json",
];

const search = (args: Record<string, unknown>) => {
  if (!args.share || !args.query)
    throw new Error("search needs share and query");
  return [
    "search",
    String(args.share),
    String(args.query),
    ...(args.revision && args.revision !== "current"
      ? ["--revision", String(args.revision)]
      : []),
    ...(args.limit ? ["--limit", String(args.limit)] : []),
    ...(args.mode ? ["--mode", String(args.mode)] : []),
    "--json",
  ];
};

const context = (args: Record<string, unknown>) => {
  if (!args.share || !args.question)
    throw new Error("context needs share and question");
  return [
    "context",
    String(args.share),
    String(args.question),
    ...(args.revision && args.revision !== "current"
      ? ["--revision", String(args.revision)]
      : []),
    ...(args["max-tokens"] ? ["--max-tokens", String(args["max-tokens"])] : []),
    "--json",
  ];
};

const openShare = (args: Record<string, unknown>) => {
  if (!args.share) throw new Error("open needs share");
  return ["open", String(args.share), "--json"];
};

const diff = (args: Record<string, unknown>) => {
  if (!args.share || args.from === undefined || args.to === undefined)
    throw new Error("diff needs share, from, to");
  return [
    "diff",
    String(args.share),
    String(args.from),
    String(args.to),
    "--json",
  ];
};

const logRevisions = (args: Record<string, unknown>) => {
  if (!args.share) throw new Error("log needs share");
  return ["log", String(args.share), "--json"];
};

const validate = (args: Record<string, unknown>) => {
  if (!args.directory) throw new Error("validate needs directory");
  return [
    "validate",
    String(args.directory),
    ...(args.json ? [] : []),
    "--json",
  ];
};

const whoami = () => ["whoami", "--json"];

const stringProperty = (description: string) => ({
  type: "string",
  description,
});
const numberProperty = (minimum = 1, maximum = 200) => ({
  type: "number",
  minimum,
  maximum,
});
const actionProperty = (values: string[]) => ({
  type: "string",
  enum: values,
});
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});
const dataSchema = objectSchema({});
const flag = (args: Record<string, unknown>, name: string, flagName = name) =>
  args[name] === undefined ? [] : [`--${flagName}`, String(args[name])];
const csv = (args: Record<string, unknown>, name: string) =>
  Array.isArray(args[name])
    ? (args[name] as unknown[]).flatMap((v) => [`--${name}`, String(v)])
    : [];
const assertSafeData = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      /private.?key|secret|password|credential|access.?token|refresh.?token|api.?key/i.test(
        key,
      )
    )
      throw new Error(
        "Private keys, credentials, and signing secrets are not accepted by MCP tools",
      );
    assertSafeData(nested);
  }
};
const jsonData = (args: Record<string, unknown>) => {
  if (args.data === undefined) return [];
  assertSafeData(args.data);
  return ["--data", JSON.stringify(args.data)];
};
const confirmed = (args: Record<string, unknown>, action: string) => {
  if (args.confirm !== true) throw new Error(`${action} requires confirm=true`);
  return ["--yes"];
};
const mutationConfirmation = (
  args: Record<string, unknown>,
  action: string,
  actions: string[],
) => (actions.includes(String(args.action)) ? confirmed(args, action) : []);
const graph = (action: string) => (args: Record<string, unknown>) => [
  "graph",
  action,
  ...(action === "search"
    ? [
        String(
          args.workspaceId ??
            (() => {
              throw new Error("graph search needs workspaceId");
            })(),
        ),
        String(
          args.query ??
            (() => {
              throw new Error("graph search needs query");
            })(),
        ),
      ]
    : [
        String(
          args.shareId ??
            (() => {
              throw new Error(`graph ${action} needs shareId`);
            })(),
        ),
      ]),
  ...flag(args, "revision"),
  ...flag(args, "limit"),
  ...flag(args, "entity"),
  ...flag(args, "depth"),
  ...flag(args, "maxHops", "max-hops"),
  ...flag(args, "from"),
  ...flag(args, "to"),
  ...flag(args, "q"),
  ...csv(args, "entityTypes"),
  ...csv(args, "edgeTypes"),
  "--json",
];
const blame = (action: string) => (args: Record<string, unknown>) => [
  "blame",
  action,
  String(args.shareId),
  ...flag(args, "revision"),
  ...flag(args, "query", "q"),
  "--json",
];
const attest = (action: string) => (args: Record<string, unknown>) => [
  "attest",
  action,
  String(
    args.shareId ??
      (() => {
        throw new Error("attest needs shareId");
      })(),
  ),
  String(
    args.revision ??
      (() => {
        throw new Error("attest needs revision");
      })(),
  ),
  ...(action === "submit" ? jsonData(args) : []),
  ...flag(args, "attestationId", "attestation-id"),
  ...flag(args, "publicKey", "public-key"),
  ...flag(args, "signature"),
  ...flag(args, "attesterId", "attester-id"),
  ...(action === "submit" ? confirmed(args, "attestation submit") : []),
  "--json",
];
const refs = (args: Record<string, unknown>) => [
  ...(() => {
    const action = String(args.action);
    const refType =
      args.refType === undefined ? undefined : String(args.refType);
    const category = refType
      ? (
          {
            branch: "branches",
            channel: "channels",
            tag: "tags",
            release: "releases",
          } as Record<string, string>
        )[refType]
      : undefined;
    if (refType && !category)
      throw new Error("refs refType must be branch, channel, tag, or release");
    const categorized = category && !["move", "delete"].includes(action);
    const prefix = categorized
      ? ["refs", category, String(args.shareId), action]
      : ["refs", action, String(args.shareId)];
    const positional = ["get", "resolve", "move", "delete"].includes(action)
      ? [String(args.label ?? args.revision ?? "current")]
      : [];
    return [
      ...prefix,
      ...positional,
      ...jsonData(args),
      ...(["get", "resolve", "move", "delete"].includes(action)
        ? []
        : flag(args, "label")),
      ...(!categorized ? flag(args, "refType", "ref-type") : []),
      ...flag(args, "targetRevisionId", "target-revision-id"),
      ...flag(args, "expectedRevisionId", "expected-revision-id"),
      ...mutationConfirmation(args, `refs ${args.action}`, [
        "create",
        "move",
        "delete",
      ]),
      "--json",
    ];
  })(),
];
const proposals = (args: Record<string, unknown>) => [
  "proposals",
  String(args.action),
  ...(args.action === "list"
    ? [
        String(
          args.shareId ??
            (() => {
              throw new Error("proposals list needs shareId");
            })(),
        ),
      ]
    : [
        String(
          args.proposalId ??
            (() => {
              throw new Error(`proposals ${args.action} needs proposalId`);
            })(),
        ),
      ]),
  ...jsonData(args),
  ...flag(args, "parentId", "parent-id"),
  ...mutationConfirmation(args, `proposal ${args.action}`, [
    "reviewer",
    "review",
    "comment",
    "check",
    "reopen",
    "merge",
    "reject",
  ]),
  "--json",
];
const workspaceCrud = (command: string) => (args: Record<string, unknown>) => [
  command,
  String(args.action),
  String(args.workspaceId),
  ...(args.targetId ? [String(args.targetId)] : []),
  ...jsonData(args),
  ...mutationConfirmation(args, `${command} ${args.action}`, [
    "create",
    "update",
    "delete",
  ]),
  "--json",
];
const organizations = (args: Record<string, unknown>) => [
  "orgs",
  String(args.action),
  ...(args.workspaceId ? [String(args.workspaceId)] : []),
  ...(args.userId ? [String(args.userId)] : []),
  ...jsonData(args),
  ...mutationConfirmation(args, `orgs ${args.action}`, [
    "create",
    "update",
    "delete",
    "transfer",
  ]),
  "--json",
];
const teams = (args: Record<string, unknown>) => [
  "teams",
  String(args.action),
  String(args.workspaceId),
  ...(args.teamId ? [String(args.teamId)] : []),
  ...(String(args.action) === "members"
    ? [
        String(args.memberAction ?? "list"),
        ...(args.memberId ? [String(args.memberId)] : []),
      ]
    : String(args.action) === "member-delete" && args.memberId
      ? [String(args.memberId)]
      : []),
  ...(String(args.action) === "member-add" ||
  (String(args.action) === "members" && args.memberAction === "add")
    ? jsonData(args)
    : []),
  ...mutationConfirmation(args, `teams ${args.action}`, [
    "create",
    "update",
    "delete",
    "member-add",
    "member-delete",
  ]),
  "--json",
];
const serviceAccounts = (args: Record<string, unknown>) => [
  "service-accounts",
  String(args.action),
  String(args.workspaceId),
  ...(args.accountId ? [String(args.accountId)] : []),
  ...(["rotate", "revoke"].includes(String(args.action)) && args.credentialId
    ? [String(args.credentialId)]
    : []),
  ...jsonData(args),
  ...mutationConfirmation(args, `credential ${args.action}`, [
    "create",
    "enable",
    "disable",
    "issue",
    "rotate",
    "revoke",
  ]),
  "--json",
];
const audit = (args: Record<string, unknown>) => [
  "audit",
  String(args.operation ?? args.action),
  ...flag(args, "format"),
  ...flag(args, "limit"),
  ...flag(args, "action"),
  ...flag(args, "actorType", "actor-type"),
  ...flag(args, "actorId", "actor-id"),
  ...flag(args, "category"),
  ...flag(args, "outcome"),
  ...flag(args, "resourceId", "resource-id"),
  ...flag(args, "from"),
  ...flag(args, "to"),
  "--json",
];
const governance = (args: Record<string, unknown>) => [
  ...(args.area === "retention" && args.action === "dry-run"
    ? ["retention", "dry-run", "--json"]
    : [
        "governance",
        String(args.area),
        String(args.action ?? "list"),
        ...(args.area === "policy" && args.policyType
          ? [String(args.policyType)]
          : []),
        ...(args.area !== "policy" && args.itemId ? [String(args.itemId)] : []),
        ...jsonData(args),
        ...mutationConfirmation(args, `governance ${args.action}`, [
          "create",
          "update",
          "put",
          "delete",
          "release",
        ]),
        "--json",
      ]),
];
const portability = (args: Record<string, unknown>) => [
  "export",
  String(args.target),
  ...(args.shareId ? [String(args.shareId)] : []),
  ...flag(args, "format"),
  ...flag(args, "intent"),
  "--json",
];
const ops = (args: Record<string, unknown>) => [
  "ops",
  String(args.action ?? "status"),
  ...flag(args, "timeout"),
  ...flag(args, "windowHours", "window-hours"),
  ...flag(args, "targetSlo", "target-slo"),
  ...flag(args, "target"),
  "--json",
];
const fork = (args: Record<string, unknown>) => {
  const action = String(args.action ?? "create");
  const share = String(
    args.shareId ??
      (() => {
        throw new Error(`fork ${action} needs shareId`);
      })(),
  );
  return [
    "fork",
    action === "create" ? "create" : action,
    share,
    ...(action === "status" ? [] : confirmed(args, `fork ${action}`)),
    "--json",
  ];
};
const status = (args: Record<string, unknown>) => [
  "status",
  ...(args.directory ? [String(args.directory)] : []),
  "--json",
];
const pull = (args: Record<string, unknown>) => [
  "pull",
  String(args.shareId),
  String(args.destination),
  ...flag(args, "revision"),
  ...confirmed(args, "pull"),
  "--json",
];
const siem = (args: Record<string, unknown>) => [
  "siem",
  String(args.action),
  String(args.workspaceId),
  ...(args.webhookId ? [String(args.webhookId)] : []),
  ...jsonData(args),
  ...(String(args.action) === "create" ||
  String(args.action) === "update" ||
  String(args.action) === "delete"
    ? confirmed(args, `siem ${args.action}`)
    : []),
  "--json",
];
const integrity = (args: Record<string, unknown>) => [
  "integrity",
  String(args.shareId),
  ...(args.revision ? [String(args.revision)] : []),
  ...flag(args, "limit"),
  ...flag(args, "cursor"),
  ...(args.full === true ? ["--full"] : []),
  "--json",
];
const rulesets = (args: Record<string, unknown>) => {
  const action = String(args.action ?? "list");
  return [
    "rulesets",
    action,
    String(args.workspaceId),
    ...(["get", "update", "delete", "evaluate"].includes(action) &&
    args.rulesetId
      ? [String(args.rulesetId)]
      : []),
    ...(args.data === undefined ? [] : jsonData(args)),
    ...(action === "create" || action === "update" || action === "delete"
      ? confirmed(args, `rulesets ${action}`)
      : []),
    "--json",
  ];
};
const shareAccess = (args: Record<string, unknown>) => [
  ...(String(args.area) === "private"
    ? [
        "share-access",
        "private",
        String(args.shareId),
        ...confirmed(args, "make share private"),
      ]
    : [
        "share-access",
        String(args.area),
        String(args.shareId),
        ...(args.action ? [String(args.action)] : []),
        ...(args.resourceId ? [String(args.resourceId)] : []),
        ...flag(args, "userId", "user-id"),
        ...flag(args, "role"),
        ...jsonData(args),
        ...(String(args.action) === "create" ||
        String(args.action) === "update" ||
        String(args.action) === "delete"
          ? confirmed(args, `share-access ${args.area} ${args.action}`)
          : []),
      ]),
  "--json",
];
const webhooks = (args: Record<string, unknown>) => [
  "webhooks",
  String(args.action ?? "list"),
  ...(args.webhookId ? [String(args.webhookId)] : []),
  ...jsonData(args),
  ...(String(args.action) === "create" ||
  String(args.action) === "update" ||
  String(args.action) === "delete"
    ? confirmed(args, `webhooks ${args.action}`)
    : []),
  "--json",
];
const domains = (args: Record<string, unknown>) => [
  "domains",
  String(args.action ?? "list"),
  ...(args.domainId ? [String(args.domainId)] : []),
  ...(args.verificationToken === undefined
    ? jsonData(args)
    : ["--data", JSON.stringify({ token: String(args.verificationToken) })]),
  ...(String(args.action) === "create" ||
  String(args.action) === "verify" ||
  String(args.action) === "delete"
    ? confirmed(args, `domains ${args.action}`)
    : []),
  "--json",
];
const admin = (args: Record<string, unknown>) => [
  "admin",
  String(args.area ?? "access"),
  ...(args.workspaceId ? [String(args.workspaceId)] : []),
  ...(args.resourceId ? [String(args.resourceId)] : []),
  ...jsonData(args),
  ...(args.resourceId || args.data !== undefined
    ? confirmed(args, `admin ${args.area}`)
    : []),
  "--json",
];
const capabilities = (args: Record<string, unknown>) => [
  "capabilities",
  String(args.scope),
  String(args.id),
  "--json",
];
const organizationAdministrators = (args: Record<string, unknown>) => [
  "orgs",
  "administrators",
  String(args.action),
  String(args.workspaceId),
  ...jsonData(args),
  ...flag(args, "billingOwnerId", "billing-owner-id"),
  ...flag(args, "securityAdministratorId", "security-administrator-id"),
  ...(args.action === "set"
    ? confirmed(args, "assign organization administrators")
    : []),
  "--json",
];

export const TOOL_LIST: Tool[] = [
  {
    name: "okfshare_list",
    description: "List shares in the authenticated workspace",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Filter by topic label" },
      },
    },
    args: list,
  },
  {
    name: "okfshare_search",
    description:
      "Search a share's revision and return cited snippets (use citations to answer questions)",
    inputSchema: {
      type: "object",
      required: ["share", "query"],
      properties: {
        share: { type: "string", description: "share id or slug" },
        query: { type: "string", description: "search query" },
        revision: { type: "string", description: "current or N" },
        limit: { type: "number", minimum: 1, maximum: 100 },
        mode: { type: "string", description: "lexical or semantic" },
      },
    },
    args: search,
  },
  {
    name: "okfshare_context",
    description:
      "Return cited context for a question from one share's revision",
    inputSchema: {
      type: "object",
      required: ["share", "question"],
      properties: {
        share: { type: "string" },
        question: { type: "string" },
        revision: { type: "string" },
        "max-tokens": { type: "number", minimum: 500, maximum: 16000 },
      },
    },
    args: context,
  },
  {
    name: "okfshare_open",
    description: "Inspect one share's metadata",
    inputSchema: {
      type: "object",
      required: ["share"],
      properties: { share: { type: "string" } },
    },
    args: openShare,
  },
  {
    name: "okfshare_diff",
    description: "Compare two revisions of a share",
    inputSchema: {
      type: "object",
      required: ["share", "from", "to"],
      properties: {
        share: { type: "string" },
        from: { type: "number" },
        to: { type: "number" },
      },
    },
    args: diff,
  },
  {
    name: "okfshare_log",
    description: "List immutable revisions with sizes and digests",
    inputSchema: {
      type: "object",
      required: ["share"],
      properties: { share: { type: "string" } },
    },
    args: logRevisions,
  },
  {
    name: "okfshare_validate",
    description: "Validate a local directory as an OKF bundle",
    inputSchema: {
      type: "object",
      required: ["directory"],
      properties: { directory: { type: "string" } },
    },
    args: validate,
  },
  {
    name: "okfshare_whoami",
    description: "Check the authenticated workspace",
    inputSchema: { type: "object", properties: {} },
    args: whoami,
  },
  {
    name: "okfshare_capabilities",
    description: "Inspect effective workspace or share capabilities",
    inputSchema: objectSchema(
      {
        scope: actionProperty(["workspace", "share"]),
        id: stringProperty("workspace or share id"),
      },
      ["scope", "id"],
    ),
    args: capabilities,
  },
  {
    name: "okfshare_organization_administrators",
    description:
      "Inspect or assign organization billing and security administrators",
    inputSchema: objectSchema(
      {
        action: actionProperty(["get", "set"]),
        workspaceId: stringProperty("workspace id"),
        billingOwnerId: stringProperty("billing owner user id"),
        securityAdministratorId: stringProperty(
          "security administrator user id",
        ),
        data: dataSchema,
        confirm: { type: "boolean", description: "Required true for set" },
      },
      ["action", "workspaceId"],
    ),
    args: organizationAdministrators,
  },
  {
    name: "okfshare_fork",
    description:
      "Create a fork of a share (the resulting share preserves lineage)",
    inputSchema: objectSchema(
      {
        action: actionProperty(["create", "status", "sync"]),
        shareId: stringProperty("source share id or slug"),
        confirm: { type: "boolean", description: "Required true" },
      },
      ["shareId"],
    ),
    args: fork,
  },
  {
    name: "okfshare_status",
    description: "Inspect local bindings and whether a local bundle is stale",
    inputSchema: objectSchema({
      directory: stringProperty("optional local directory"),
    }),
    args: status,
  },
  {
    name: "okfshare_pull",
    description: "Materialize a share revision into a local directory",
    inputSchema: objectSchema(
      {
        shareId: stringProperty("share id or slug"),
        destination: stringProperty("destination directory"),
        revision: stringProperty("revision number or current"),
        confirm: { type: "boolean", description: "Required true" },
      },
      ["shareId", "destination", "confirm"],
    ),
    args: pull,
  },
  {
    name: "okfshare_integrity",
    description:
      "Verify one revision or a bounded, cursor-paginated revision history",
    inputSchema: objectSchema(
      {
        shareId: stringProperty("share id"),
        revision: stringProperty("optional revision number"),
        limit: numberProperty(1, 100),
        cursor: stringProperty("pagination cursor"),
        full: { type: "boolean" },
      },
      ["shareId"],
    ),
    args: integrity,
  },
  {
    name: "okfshare_share_access",
    description:
      "List or manage direct share roles and grants, or make a share private",
    inputSchema: objectSchema(
      {
        area: actionProperty(["roles", "grants", "private"]),
        action: actionProperty(["list", "create", "update", "delete"]),
        shareId: stringProperty("share id"),
        resourceId: stringProperty("grant id"),
        userId: stringProperty("user id"),
        role: stringProperty("share role"),
        data: dataSchema,
        confirm: { type: "boolean" },
      },
      ["area", "shareId"],
    ),
    args: shareAccess,
  },
  {
    name: "okfshare_rulesets",
    description:
      "List, inspect, create, update, delete, validate, or evaluate workspace rulesets",
    inputSchema: objectSchema(
      {
        action: actionProperty([
          "list",
          "get",
          "create",
          "update",
          "delete",
          "evaluate",
          "validate",
        ]),
        workspaceId: stringProperty("workspace id"),
        rulesetId: stringProperty("ruleset id for get/update/delete/evaluate"),
        data: dataSchema,
        confirm: { type: "boolean" },
      },
      ["action", "workspaceId"],
    ),
    args: rulesets,
  },
  {
    name: "okfshare_webhooks",
    description: "List, inspect, create, update, or delete product webhooks",
    inputSchema: objectSchema(
      {
        action: actionProperty(["list", "get", "create", "update", "delete"]),
        webhookId: stringProperty("webhook id"),
        data: dataSchema,
        confirm: { type: "boolean" },
      },
      ["action"],
    ),
    args: webhooks,
  },
  {
    name: "okfshare_domains",
    description: "Manage organization domains and perform manual verification",
    inputSchema: objectSchema(
      {
        action: actionProperty(["list", "get", "create", "verify", "delete"]),
        domainId: stringProperty("domain id"),
        verificationToken: stringProperty(
          "manual DNS verification token; never log or persist",
        ),
        data: dataSchema,
        confirm: { type: "boolean" },
      },
      ["action"],
    ),
    args: domains,
  },
  {
    name: "okfshare_admin",
    description:
      "Inspect administrator access and manage operator workspace settings and policies",
    inputSchema: objectSchema(
      {
        area: actionProperty([
          "access",
          "overview",
          "funnel",
          "settings",
          "policies",
        ]),
        workspaceId: stringProperty("workspace id for settings or policies"),
        resourceId: stringProperty("setting key or policy type"),
        data: dataSchema,
        confirm: { type: "boolean" },
      },
      ["area"],
    ),
    args: admin,
  },
  {
    name: "okfshare_billing",
    description:
      "Inspect the authenticated account billing and entitlement snapshot",
    inputSchema: objectSchema({}),
    args: () => ["billing", "--json"],
  },
  {
    name: "okfshare_graph",
    description:
      "Search or inspect the knowledge graph (snapshot, neighbors, path, diff, provenance, related)",
    inputSchema: objectSchema(
      {
        action: actionProperty([
          "search",
          "snapshot",
          "neighbors",
          "path",
          "diff",
          "provenance",
          "related",
        ]),
        workspaceId: stringProperty("workspace id for graph search"),
        shareId: stringProperty("share id"),
        query: stringProperty("graph search query"),
        q: stringProperty("graph query"),
        revision: stringProperty("revision"),
        limit: numberProperty(),
        entity: stringProperty("entity id"),
        entityTypes: { type: "array", items: { type: "string" } },
        edgeTypes: { type: "array", items: { type: "string" } },
        depth: numberProperty(1, 3),
        maxHops: numberProperty(1, 10),
        from: stringProperty("source revision"),
        to: stringProperty("target revision"),
      },
      ["action"],
    ),
    args: (args: Record<string, unknown>) => graph(String(args.action))(args),
  },
  {
    name: "okfshare_blame",
    description: "Explain line or semantic ownership of a share",
    inputSchema: objectSchema(
      {
        action: actionProperty(["line", "semantic"]),
        shareId: stringProperty("share id"),
        revision: stringProperty("revision"),
        query: stringProperty("semantic blame query"),
      },
      ["action", "shareId"],
    ),
    args: (args: Record<string, unknown>) => blame(String(args.action))(args),
  },
  {
    name: "okfshare_attestations",
    description:
      "List, verify, or submit revision attestations; private keys are never accepted",
    inputSchema: objectSchema(
      {
        action: actionProperty(["list", "verify", "submit"]),
        shareId: stringProperty("share id"),
        revision: stringProperty("revision"),
        attestationId: stringProperty("attestation id"),
        data: dataSchema,
        publicKey: stringProperty("public key"),
        signature: stringProperty("signature"),
        attesterId: stringProperty("attester id"),
      },
      ["action", "shareId", "revision"],
    ),
    args: (args: Record<string, unknown>) => attest(String(args.action))(args),
  },
  {
    name: "okfshare_refs",
    description:
      "List, resolve, inspect, create, move, or delete branches, channels, tags, and releases",
    inputSchema: objectSchema(
      {
        action: actionProperty([
          "list",
          "get",
          "resolve",
          "create",
          "move",
          "delete",
        ]),
        shareId: stringProperty("share id"),
        refType: actionProperty(["branch", "channel", "tag", "release"]),
        label: stringProperty("ref label"),
        revision: stringProperty("revision"),
        targetRevisionId: stringProperty("target revision id"),
        expectedRevisionId: stringProperty("expected current revision id"),
        data: dataSchema,
        confirm: {
          type: "boolean",
          description: "Required true for mutations",
        },
      },
      ["action", "shareId"],
    ),
    args: refs,
  },
  {
    name: "okfshare_proposals",
    description:
      "Inspect and manage proposal reviews, comments, checks, and lifecycle",
    inputSchema: objectSchema(
      {
        action: actionProperty([
          "list",
          "detail",
          "review",
          "comment",
          "check",
          "reviewer",
          "reopen",
          "merge",
          "reject",
        ]),
        proposalId: stringProperty("proposal id"),
        data: dataSchema,
        parentId: stringProperty("parent comment id"),
        confirm: {
          type: "boolean",
          description: "Required true for merge or reopen",
        },
      },
      ["action"],
    ),
    args: proposals,
  },
  {
    name: "okfshare_roles",
    description: "List, get, create, update, or delete workspace roles",
    inputSchema: objectSchema(
      {
        action: actionProperty(["list", "get", "create", "update", "delete"]),
        workspaceId: stringProperty("workspace id"),
        targetId: stringProperty("role id"),
        data: dataSchema,
        confirm: { type: "boolean", description: "Required true for delete" },
      },
      ["action", "workspaceId"],
    ),
    args: workspaceCrud("roles"),
  },
  {
    name: "okfshare_bindings",
    description: "List or remove workspace role bindings",
    inputSchema: objectSchema(
      {
        action: actionProperty(["list", "create", "delete"]),
        workspaceId: stringProperty("workspace id"),
        targetId: stringProperty("binding id for delete"),
        data: dataSchema,
        confirm: {
          type: "boolean",
          description: "Required true for create or delete",
        },
      },
      ["action", "workspaceId"],
    ),
    args: workspaceCrud("bindings"),
  },
  {
    name: "okfshare_organizations",
    description:
      "List, inspect, create, update, delete, or transfer organization ownership",
    inputSchema: objectSchema(
      {
        action: actionProperty([
          "list",
          "get",
          "create",
          "update",
          "delete",
          "transfer",
        ]),
        workspaceId: stringProperty("workspace id"),
        userId: stringProperty("new owner user id"),
        data: dataSchema,
        confirm: {
          type: "boolean",
          description: "Required true for delete or transfer",
        },
      },
      ["action"],
    ),
    args: organizations,
  },
  {
    name: "okfshare_teams",
    description: "List and manage organization teams and membership roles",
    inputSchema: objectSchema(
      {
        action: actionProperty([
          "list",
          "get",
          "create",
          "update",
          "delete",
          "members",
          "member-add",
          "member-list",
          "member-delete",
        ]),
        workspaceId: stringProperty("workspace id"),
        teamId: stringProperty("team id"),
        memberAction: actionProperty(["list", "add", "delete"]),
        memberId: stringProperty("member id"),
        data: dataSchema,
        confirm: { type: "boolean", description: "Required true for delete" },
      },
      ["action", "workspaceId"],
    ),
    args: teams,
  },
  {
    name: "okfshare_service_accounts",
    description:
      "Manage service accounts and credentials. Credential tokens are returned once and never stored by this server",
    inputSchema: objectSchema(
      {
        action: actionProperty([
          "list",
          "get",
          "create",
          "enable",
          "disable",
          "credentials",
          "issue",
          "rotate",
          "revoke",
        ]),
        workspaceId: stringProperty("workspace id"),
        accountId: stringProperty("service account id"),
        credentialId: stringProperty("credential id"),
        data: dataSchema,
        confirm: { type: "boolean", description: "Required true for revoke" },
      },
      ["action", "workspaceId"],
    ),
    args: serviceAccounts,
    oneTimeCredential: true,
  },
  {
    name: "okfshare_siem",
    description: "List and manage workspace SIEM webhook destinations",
    inputSchema: objectSchema(
      {
        action: actionProperty(["list", "get", "create", "update", "delete"]),
        workspaceId: stringProperty("workspace id"),
        webhookId: stringProperty("SIEM webhook id"),
        data: dataSchema,
        confirm: {
          type: "boolean",
          description: "Required true for mutations",
        },
      },
      ["action", "workspaceId"],
    ),
    args: siem,
  },
  {
    name: "okfshare_audit",
    description: "Search audit events or export audit metadata as CSV/NDJSON",
    inputSchema: objectSchema(
      {
        action: actionProperty(["list", "export"]),
        format: actionProperty(["csv", "ndjson"]),
        actionFilter: stringProperty("event action"),
        actorType: stringProperty("actor type"),
        actorId: stringProperty("actor id"),
        category: stringProperty("category"),
        outcome: stringProperty("outcome"),
        resourceId: stringProperty("resource id"),
        from: stringProperty("start time"),
        to: stringProperty("end time"),
        limit: numberProperty(),
      },
      ["action"],
    ),
    args: (args: Record<string, unknown>) =>
      audit({ ...args, operation: args.action, action: args.actionFilter }),
  },
  {
    name: "okfshare_governance",
    description:
      "Inspect governance policies and legal holds, or run retention dry-runs",
    inputSchema: objectSchema(
      {
        area: actionProperty(["retention", "legal-hold", "policy"]),
        action: actionProperty([
          "list",
          "get",
          "create",
          "update",
          "put",
          "delete",
          "release",
          "dry-run",
        ]),
        policyType: stringProperty("policy type"),
        itemId: stringProperty("hold or policy id"),
        data: dataSchema,
        confirm: {
          type: "boolean",
          description: "Required true for delete or release",
        },
      },
      ["area"],
    ),
    args: governance,
  },
  {
    name: "okfshare_portability_export",
    description: "Export workspace, share, or account portability metadata",
    inputSchema: objectSchema(
      {
        target: actionProperty(["workspace", "share", "account"]),
        shareId: stringProperty("share id for share export"),
        format: actionProperty(["ndjson", "tar"]),
        intent: stringProperty("export intent"),
      },
      ["target"],
    ),
    args: portability,
  },
  {
    name: "okfshare_ops",
    description: "Read operations status, dependencies, or SLO information",
    inputSchema: objectSchema({
      action: actionProperty(["status", "dependencies", "slo"]),
      timeout: numberProperty(1, 300000),
      windowHours: numberProperty(1, 8760),
      targetSlo: numberProperty(1, 100),
      target: stringProperty("operations target"),
    }),
    args: ops,
  },
].map((tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    additionalProperties:
      (tool.inputSchema as { additionalProperties?: boolean })
        .additionalProperties ?? false,
  },
}));

const toolByName = new Map(TOOL_LIST.map((tool) => [tool.name, tool]));

type Rpc = {
  id?: string | number;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
  result?: unknown;
  error?: { code?: number; message?: string };
};

const send = (response: Rpc) => {
  stdout.write(`${JSON.stringify(response)}\n`);
};

export const safeOutput = (text: string, oneTimeCredential = false): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.replace(
      /(authorization|bearer|token|credential|secret|private.?key|password)\s*[:=]\s*[^\s,}]+/gi,
      "$1: [redacted]",
    );
  }
  const removeSecrets = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(removeSecrets);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) =>
            !/private.?key|secret|password|api.?key/i.test(key) &&
            (oneTimeCredential ||
              !/credential|access.?token|refresh.?token|token/i.test(key)),
        )
        .map(([key, nested]) => [key, removeSecrets(nested)]),
    );
  };
  const clean = removeSecrets(parsed);
  if (oneTimeCredential && clean && typeof clean === "object")
    return JSON.stringify({
      ...(clean as Record<string, unknown>),
      oneTimeCredential: true,
      warning:
        "Credential token is displayed once. Store it securely; okfshare-mcp does not retain it.",
    });
  return JSON.stringify(clean);
};

const handle = async (rpc: Rpc): Promise<Rpc> => {
  if (rpc.method === "initialize") {
    return {
      ...rpc,
      result: {
        protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "okfshare-mcp", version: "0.1.0" },
      },
    };
  }
  if (rpc.method === "tools/list") {
    return {
      ...rpc,
      result: {
        tools: TOOL_LIST.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      },
    };
  }
  if (rpc.method === "tools/call") {
    const params = (rpc.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const tool = params.name ? toolByName.get(params.name) : undefined;
    if (!tool) {
      return {
        ...rpc,
        error: { code: -32602, message: `Unknown tool: ${params.name ?? ""}` },
      };
    }
    try {
      const result = await runCli(tool.args(params.arguments ?? {}));
      const oneTime =
        tool.oneTimeCredential === true &&
        ["credentials", "issue", "rotate"].includes(
          String((params.arguments ?? {}).action),
        );
      const output = oneTime
        ? safeOutput(
            result.stdout.trim() || result.stderr.trim() || "(no output)",
            true,
          )
        : safeOutput(
            result.stdout.trim() || result.stderr.trim() || "(no output)",
          );
      const content =
        result.exit === 0
          ? {
              kind: "text",
              text: output,
            }
          : {
              kind: "text",
              text: safeOutput(
                result.stderr.trim() || result.stdout.trim() || "CLI failed",
              ),
            };
      return {
        ...rpc,
        result: {
          content: [content],
          isError: result.exit !== 0,
          meta: { exitCode: result.exit },
        },
      };
    } catch (error) {
      return {
        ...rpc,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  return { ...rpc, result: { capabilities: { tools: {} } } };
};

let buffer = "";
const isMain = process.argv[1]?.replaceAll("\\", "/").endsWith("/index.js");
if (isMain) stdin.setEncoding("utf8");
if (isMain)
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let rpc: Rpc;
      try {
        rpc = JSON.parse(line);
      } catch {
        continue;
      }
      void handle(rpc).then(send);
    }
  });
