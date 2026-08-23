type Row = Record<string, unknown>;

const bytes = (n: unknown): string => {
  const value = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(value)) return "?";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
};

export const str = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : String(value);

const cell = (value: unknown, width: number): string => {
  const text = str(value);
  return text.length > width
    ? `${text.slice(0, width - 1)}…`
    : text.padEnd(width);
};

const table = (headers: string[], widths: number[], rows: string[][]): string =>
  [
    headers.map((h, i) => cell(h, widths[i])).join(" "),
    rows.map((r) => r.join(" ").trimEnd()).join("\n"),
  ]
    .join("\n")
    .trimEnd();

const shortDigest = (digest: unknown): string => {
  const text = str(digest);
  return text.length > 12 ? text.slice(0, 12) : text;
};

const shareUrl = (slugOrId: unknown): string =>
  `https://okfshare.app/s/${str(slugOrId)}`;

const isEnvelope = (value: unknown): value is Row =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "operation" in (value as Row) &&
  "ok" in (value as Row);

function renderSearch(data: Row): string {
  const results = Array.isArray(data.results) ? (data.results as Row[]) : [];
  const revision = (data.revision ?? {}) as Row;
  const lines = [
    `search "${str(data.query)}" · ${results.length}${data.total !== undefined && data.total !== results.length ? ` of ${str(data.total)}` : ""} hits · rev ${str(revision.number)}${data.truncated === true ? " · truncated" : ""}`,
  ];
  for (const hit of results) {
    const citation = (hit.citation ?? {}) as Row;
    const range = citation.lineRange
      ? `#L${str((citation.lineRange as Row).start)}-L${str((citation.lineRange as Row).end)}`
      : "";
    lines.push(
      `\n[${cell(hit.score, 4).trim()}] ${str(hit.path)}${range}\n  ${str(
        hit.snippet ?? hit.content,
      )
        .replace(/\s+/g, " ")
        .slice(0, 160)}`,
    );
  }
  lines.push(
    `\ncite: https://okfshare.app/s/<slug>/revision/${str(revision.number)}/<path>#L<start>-L<end>`,
  );
  return lines.join("\n");
}

function renderContext(data: Row): string {
  const chunks = Array.isArray(data.chunks) ? (data.chunks as Row[]) : [];
  const lines = [
    `context "${str(data.query)}" · ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} · ~${str(data.usedTokens)} tokens${data.truncated === true ? " · TRUNCATED (raise --max-tokens)" : ""}`,
  ];
  for (const chunk of chunks) {
    const citation = (chunk.citation ?? {}) as Row;
    lines.push(
      `\n— ${str(chunk.path)}${citation.lineRange ? `:${str((citation.lineRange as Row).start)}-${str((citation.lineRange as Row).end)}` : ""}\n${str(chunk.content ?? chunk.snippet).trim()}`,
    );
  }
  return lines.join("\n");
}

export function renderHuman(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const shares = value.filter(
      (row) =>
        typeof row === "object" && row !== null && "slug" in (row as Row),
    ) as Row[];
    if (shares.length) {
      const topicList = (row: Row) =>
        Array.isArray(row.topics) ? (row.topics as unknown[]) : [];
      const withTopics = shares.some((row) => topicList(row).length > 0);
      const headers = withTopics
        ? ["id", "slug", "visibility", "title", "topics"]
        : ["id", "slug", "visibility", "title"];
      const widths = withTopics ? [34, 34, 10, 44, 24] : [34, 34, 10, 44];
      return table(
        headers,
        widths,
        shares.map((share) => [
          str(share.id),
          str(share.slug),
          str(share.visibility),
          str(share.title),
          ...(withTopics
            ? [
                ((share as Row).topics as string[])?.join(", ").slice(0, 24) ??
                  "",
              ]
            : []),
        ]),
      );
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Row;

  if (isEnvelope(row)) {
    const operation = str(row.operation);
    if (operation === "validate") {
      const bundle = (row.bundle ?? {}) as Row;
      return `✓ Bundle valid — ${str(bundle.files)} file${bundle.files === 1 ? "" : "s"}, ${bytes(bundle.bytes)}, digest ${shortDigest(bundle.digest)}\nnext: npx okfshare@latest publish ${str(bundle.path) || "."} --yes`;
    }
    if (
      operation === "publish" ||
      operation === "update" ||
      operation === "push"
    ) {
      const wrapper = (row.share ?? {}) as Row;
      const share = (wrapper.share ?? wrapper ?? {}) as Row;
      const revision = (wrapper.revision ?? row.revision ?? {}) as Row;
      const bundle = (row.bundle ?? {}) as Row;
      const lines = [`✓ ${str(share.title) || str(share.id)} ${str(share.id)}`];
      if (revision.number !== undefined)
        lines[0] += ` · rev ${str(revision.number)}`;
      if (share.slug) lines.push(shareUrl(share.slug));
      const topics = share.topics;
      if (Array.isArray(topics) && topics.length)
        lines.push(`topics: ${topics.map((t: unknown) => str(t)).join(", ")}`);
      lines.push(
        `${str(bundle.files)} files · digest ${shortDigest(bundle.digest)}`,
      );
      lines.push(
        operation === "publish"
          ? `next: npx okfshare@latest bind ${str(share.id)} ${str(bundle.path) || "."}`
          : `next: npx okfshare@latest log ${str(share.id)}`,
      );
      return lines.join("\n");
    }
    if (operation === "rollback") {
      const wrapper = (row.share ?? {}) as Row;
      const revision = (wrapper.revision ?? {}) as Row;
      const shareId = str(wrapper.id || revision.shareId);
      return [
        `✓ Rolled back — prior revision restored as rev ${str(revision.number)} on ${shareId}`,
        "history is immutable; nothing was deleted",
        `next: npx okfshare@latest log ${shareId}`,
      ].join("\n");
    }
    if (operation === "pull") {
      return `✓ Pulled rev ${str((row.revision as Row)?.number)} · ${str(row.files)} files · ${bytes(row.bytes)} → ${str(row.destination)}`;
    }
    if (operation === "log") {
      const revisions = Array.isArray(row.revisions)
        ? (row.revisions as Row[])
        : [];
      if (!revisions.length) return "No revisions yet.";
      return table(
        ["rev", "created", "bytes", "files", "digest"],
        [5, 20, 9, 6, 13],
        revisions.map((rev) => [
          str(rev.number),
          str(rev.createdAt).replace("T", " ").slice(0, 19),
          bytes(rev.sizeBytes),
          str(rev.fileCount),
          shortDigest(rev.contentDigest),
        ]),
      );
    }
    if (operation === "diff") {
      const diff = (row.diff ?? row) as Row;
      const data = ((diff as Row).data ?? diff) as Row;
      const files = (data.files ?? {}) as Row;
      const lines: string[] = [];
      const revNumbers = [data.from, data.to].map((r) =>
        str(((r ?? {}) as Row).number),
      );
      lines.push(`diff rev ${revNumbers[0]} → rev ${revNumbers[1]}`);
      for (const path of (files.added as string[]) ?? [])
        lines.push(`+ ${path} (added)`);
      for (const path of (files.removed as string[]) ?? [])
        lines.push(`- ${path} (removed)`);
      for (const entry of (files.diffs as Row[]) ?? []) {
        lines.push(`± ${str(entry.path)}`);
        for (const hunk of (entry.hunks ?? []) as Row[]) {
          lines.push(
            `  @@ -${str(hunk.aStart)},${str(hunk.aLines)} +${str(hunk.bStart)},${str(hunk.bLines)} @@`,
          );
          for (const change of (hunk.changes ?? []) as Row[]) {
            const prefix =
              change.type === "add" ? "+" : change.type === "del" ? "-" : " ";
            lines.push(`  ${prefix} ${str(change.line)}`);
          }
        }
      }
      return lines.join("\n");
    }
    if (operation === "status") {
      const workspace = (row.workspace ?? {}) as Row;
      if (workspace.bundles) {
        const bundles = workspace.bundles as Row[];
        if (!bundles.length)
          return "No known bundles in this workspace cache.\nnext: npx okfshare@latest init <dir>";
        return table(
          ["dir", "share", "rev", "state"],
          [30, 16, 5, 8],
          bundles.map((bundle) => [
            str(bundle.dir),
            str(bundle.shareId),
            str(bundle.revision),
            str(bundle.stale === true ? "stale" : "synced"),
          ]),
        );
      }
      const binding = (workspace.binding ?? {}) as Row;
      if (workspace.bound !== true)
        return "Not bound. next: npx okfshare@latest bind SHARE_ID .";
      return [
        `bound: ${str(binding.shareId)} @ rev ${str(binding.revision)}`,
        workspace.stale === true
          ? "⚠ local copy differs from last published digest (stale)"
          : "✓ local copy matches last published digest",
        `next: npx okfshare@latest push . --yes`,
      ].join("\n");
    }
    if (operation === "search" || operation === "context") {
      const payload = row[operation];
      const data =
        typeof payload === "object" && payload !== null
          ? ((payload as Row).data as Row | undefined)
          : undefined;
      if (!data) return null;
      return operation === "search" ? renderSearch(data) : renderContext(data);
    }
    if (operation === "explore") {
      const list = Array.isArray(row.explore) ? (row.explore as unknown[]) : [];
      if (!list.length)
        return "Nothing in the explore feed yet.\nnext: npx okfshare@latest publish <dir> --visibility public --yes";
      return renderHuman(list);
    }
    if (operation === "list") {
      const wrapper = row.shares;
      const list = Array.isArray(wrapper)
        ? wrapper
        : typeof wrapper === "object" &&
            wrapper !== null &&
            Array.isArray((wrapper as Row).data)
          ? ((wrapper as Row).data as unknown[])
          : [];
      if (!Array.isArray(list)) return null;
      if (!list.length)
        return "No shares yet.\nnext: npx okfshare@latest publish <dir> --yes";
      return renderHuman(list);
    }
    if (operation === "open") {
      const share = row.share;
      if (typeof share !== "object" || share === null) return null;
      const s = share as Row;
      const revision = (s.revision ?? {}) as Row;
      return [
        `${str(s.title) || "share"} · ${str(s.id)}`,
        `rev ${str(revision.number ?? "?")} · ${str(s.visibility)} · ${str(s.status)}`,
        s.slug ? shareUrl(s.slug) : "",
        str(s.description),
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (operation === "init") {
      const bundle = (row.bundle ?? {}) as Row;
      const created = Array.isArray(row.created)
        ? (row.created as string[])
        : [];
      return [
        `✓ Created OKF bundle at ${str(bundle.path)} (${created.length} files)`,
        ...created.map((file) => `  - ${file}`),
        `next: npx okfshare@latest validate ${str(bundle.path)}`,
      ].join("\n");
    }
    return null;
  }

  return null;
}

export function errorHint(message: string): {
  hint?: string;
  next?: string[];
} {
  const m = message.toLowerCase();
  if (/enoent|no such file or directory/.test(m))
    return {
      hint: "A local file or directory was missing.",
      next: ["check the path, then rerun"],
    };
  if (/authentication|unauthorized|401/.test(m))
    return {
      hint: "No valid credential found.",
      next: [
        "login: npx okfshare@latest login",
        "browserless: set OKFSHARE_TOKEN in the process environment, then run npx okfshare@latest whoami",
      ],
    };
  if (/forbidden|scope|403/.test(m))
    return {
      hint: "The credential lacks the required scope (workspace:read to retrieve, workspace:write to mutate).",
      next: ["check: npx okfshare@latest whoami"],
    };
  if (/conflict|expected revision|409|stale/.test(m))
    return {
      hint: "The remote moved since you last looked. Re-read the current revision before mutating.",
      next: [
        "inspect: npx okfshare@latest log <SHARE_ID>",
        "retry with: --expected-revision <N>",
      ],
    };
  if (/quota|limit reached|too many/.test(m))
    return {
      hint: "Workspace quota exceeded. Delete unused shares or reduce bundle size.",
      next: ["review: npx okfshare@latest list"],
    };
  if (/not found|no such|404/.test(m))
    return {
      hint: "The id or slug did not resolve in this workspace.",
      next: ["list shares: npx okfshare@latest list"],
    };
  if (/frontmatter|type:|validation|invalid|must /.test(m))
    return {
      hint: "Fix the reported bundle issues, then revalidate.",
      next: ["recheck: npx okfshare@latest validate <dir>"],
    };
  if (/destination|already exists|directory/.test(m) && /pull/.test(m))
    return {
      hint: "Pull only writes to a directory that does not exist yet.",
      next: [
        "retry with a fresh path: npx okfshare@latest pull <SHARE_ID> <new-dir> --yes",
      ],
    };
  if (/refusing noninteractive|--yes/.test(m))
    return {
      hint: "Mutations need explicit consent when no terminal is attached.",
      next: ["rerun with --yes (apply) or --dry-run (preview)"],
    };
  if (/network|fetch failed|econn|timeout|5\d\d/.test(m))
    return {
      hint: "The API was unreachable or failed. Safe to retry; publishes are idempotent.",
    };
  return {};
}
