import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorHint, renderHuman, str } from "../src/render.js";
import { resultEnvelope } from "../src/index.js";
import {
  collectBundle,
  scaffoldBundle,
  validateBundle,
} from "../src/bundle.js";

const searchApiResult = {
  contractVersion: 1,
  data: {
    share: { id: "sh_1", slug: "abc123" },
    revision: { id: "rev_1", number: 3, contentDigest: "sha256-x" },
    query: "rollback safety",
    total: 2,
    diagnostics: { terms: ["rollback"] },
    results: [
      {
        path: "projects/deploy.md",
        title: "Deploy",
        score: 0.9,
        startLine: 10,
        endLine: 22,
        snippet: "Rollback is automatic when errors exceed two percent.",
        citation: {
          url: "/s/abc123/revision/3/projects/deploy.md#L10-L22",
          revision: 3,
          path: "projects/deploy.md",
          lineRange: { start: 10, end: 22 },
        },
      },
    ],
  },
  nextCursor: null,
};

describe("human rendering", () => {
  it("renders search results as a compact table with one cite line", () => {
    const text = renderHuman(
      resultEnvelope("search", { search: searchApiResult }),
    );
    expect(text).toContain('search "rollback safety"');
    expect(text).toContain("rev 3");
    expect(text).toContain("projects/deploy.md");
    expect(text).toContain("#L10-L22");
    expect(text).not.toContain('"contractVersion"');
  });

  it("renders context chunks with truncation warning", () => {
    const text = renderHuman(
      resultEnvelope("context", {
        context: {
          contractVersion: 1,
          data: {
            query: "q",
            budget: 500,
            usedTokens: 480,
            truncated: true,
            chunks: [
              {
                path: "a.md",
                content: "Body text.",
                citation: { lineRange: { start: 1, end: 4 } },
              },
            ],
          },
        },
      }),
    );
    expect(text).toContain("TRUNCATED");
    expect(text).toContain("Body text.");
  });

  it("renders list envelopes including the {data} wrapper and empty state", () => {
    const populated = renderHuman(
      resultEnvelope("list", {
        shares: {
          data: [
            {
              id: "sh_1",
              slug: "abc",
              visibility: "unlisted",
              title: "Notes",
            },
          ],
        },
      }),
    );
    expect(populated).toContain("sh_1");
    expect(populated).toContain("Notes");
    const empty = renderHuman(resultEnvelope("list", { shares: { data: [] } }));
    expect(empty).toContain("No shares yet");
  });

  it("renders publish with share URL and bind hint", () => {
    const text = renderHuman(
      resultEnvelope("publish", {
        share: {
          share: { id: "sh_9", slug: "xyz", title: "T" },
          revision: { number: 1 },
        },
        bundle: { path: "./k", files: 3, digest: "sha256-abcdef" },
      }),
    );
    expect(text).toContain("rev 1");
    expect(text).toContain("https://okfshare.app/s/xyz");
    expect(text).toContain("bind sh_9 ./k");
  });

  it("returns null for unknown shapes so out() can fall back to compact JSON", () => {
    expect(renderHuman({ custom: { nested: [1, 2] } })).toBeNull();
  });

  it("keeps string passthrough", () => {
    expect(renderHuman("Unbound.")).toBe("Unbound.");
  });
});

describe("error hints", () => {
  it("maps auth failures to login guidance", () => {
    const hint = errorHint("Authentication failed");
    expect(hint.hint).toBeTruthy();
    expect(hint.next?.join("\n")).toContain("login");
  });

  it("maps conflicts to expected-revision recovery", () => {
    const hint = errorHint("Revision conflict: expected revision 4");
    expect(hint.next?.join("\n")).toContain("--expected-revision");
  });

  it("returns no hint for unknown messages", () => {
    expect(errorHint("totally novel failure")).toEqual({});
  });
});

describe("init scaffolding", () => {
  it("scaffolds a bundle that passes validation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "okfshare-init-"));
    const dir = join(parent, "fresh");
    const created = await scaffoldBundle(dir, { title: "My Notes" });
    expect(created).toContain("index.md");
    expect(created).toContain("log.md");
    expect(
      created.some(
        (file) =>
          file.endsWith(".md") && file !== "index.md" && file !== "log.md",
      ),
    ).toBe(true);
    const bundle = await collectBundle(dir);
    expect(validateBundle(bundle)).toEqual([]);
  }, 20000);

  it("refuses non-empty directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-init-"));
    await writeFile(join(dir, "occupied.txt"), "x", "utf8");
    await expect(scaffoldBundle(dir)).rejects.toThrow(/non-empty/);
  });
});

describe("str helper", () => {
  it("coerces safely", () => {
    expect(str(undefined)).toBe("");
    expect(str(5)).toBe("5");
    expect(str("x")).toBe("x");
  });
});
