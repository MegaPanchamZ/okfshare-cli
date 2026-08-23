#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  args: (args: Record<string, unknown>) => string[];
  allowed?: string;
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
  ...(args.limit ? ["--limit", String(args.limit)] : []),
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

const TOOL_LIST: Tool[] = [
  {
    name: "okfshare_list",
    description: "List shares in the authenticated workspace",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Filter by topic label" },
        limit: { type: "number", minimum: 1, maximum: 100 },
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
];

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
      const content =
        result.exit === 0
          ? {
              kind: "text",
              text:
                result.stdout.trim() || result.stderr.trim() || "(no output)",
            }
          : {
              kind: "text",
              text:
                result.stderr.trim() || result.stdout.trim() || "CLI failed",
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
stdin.setEncoding("utf8");
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
