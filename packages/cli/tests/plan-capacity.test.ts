import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, SAFE_MAX_LIMITS, resolveLimits } from "../src/limits.js";
import { validateBundle, type Bundle } from "../src/bundle.js";
import { decodePullBundle, pullBundle } from "../src/retrieval.js";

const pro = {
  maxFiles: 250,
  maxFileBytes: 500_000,
  maxBundleBytes: 10_000_000,
};

const content = (padding = "") =>
  `---\ntype: Concept\n---\n# Concept\n${padding}`;

const bundleWith = (files: { path: string; content: string }[]): Bundle => ({
  directory: "",
  title: "Plan capacity",
  root: "index.md",
  readme: "index.md",
  files: [
    { path: "index.md", content: "# Root", bytes: 6 },
    ...files.map((file) => ({
      ...file,
      bytes: Buffer.byteLength(file.content),
    })),
  ],
  totalBytes:
    6 + files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
});

const pullResponse = (files: { path: string; content: string }[]) => ({
  data: {
    share: {
      id: "share-1",
      slug: "slug-1",
      title: "Title",
      description: "Description",
      visibility: "public",
      status: "active",
    },
    revision: {
      id: "revision-1",
      number: 1,
      immutable: true,
      sizeBytes: 10_000_000_000,
      fileCount: files.length + 1,
      createdAt: "now",
    },
    bundle: {
      title: "Title",
      description: "Description",
      root: "index.md",
      okfVersion: null,
      files: [{ path: "index.md", content: "# Root" }, ...files],
      concepts: [],
      reserved: {},
      types: [],
      trustSummary: {},
      graph: {},
    },
  },
});

describe("CLI write validation uses server entitlements", () => {
  it("widens Free defaults from Pro entitlements", () => {
    expect(resolveLimits({ ...pro })).toEqual({
      ...pro,
      maxPathBytes: 240,
    });
    expect(resolveLimits(null)).toEqual(LIMITS);
    expect(resolveLimits({ maxFiles: "nope" })).toEqual(LIMITS);
  });

  it("accepts a Pro workspace crossing every Free write limit", () => {
    const limits = resolveLimits(pro);
    const files = Array.from({ length: 26 }, (_, index) => ({
      path: `doc-${index}.md`,
      content: content(),
    }));
    files.push({ path: "big.md", content: content("x".repeat(100_001)) });
    files.push({ path: "wide.md", content: content("y".repeat(400_000)) });
    const bundle = bundleWith(files);
    expect(validateBundle(bundle, limits)).toEqual([]);
  });

  it("rejects a Pro workspace above the Pro limits", () => {
    const limits = resolveLimits(pro);
    const tooMany = bundleWith(
      Array.from({ length: pro.maxFiles }, (_, index) => ({
        path: `doc-${index}.md`,
        content: content(),
      })),
    );
    expect(validateBundle(tooMany, limits)).toContain(
      `Bundle exceeds the ${pro.maxFiles} file limit`,
    );
    const tooBigFile = bundleWith([
      { path: "big.md", content: content("x".repeat(pro.maxFileBytes + 1)) },
    ]);
    expect(validateBundle(tooBigFile, limits)).toContain(
      `big.md exceeds the ${pro.maxFileBytes} byte file limit`,
    );
    const tooBigBundle = bundleWith(
      Array.from({ length: 25 }, (_, index) => ({
        path: `doc-${index}.md`,
        content: content("x".repeat(450_000)),
      })),
    );
    expect(validateBundle(tooBigBundle, limits)).toContain(
      `Bundle exceeds the ${pro.maxBundleBytes} byte limit`,
    );
  });

  it("still caps Free workspaces at the Free limits by default", () => {
    const files = Array.from({ length: 25 }, (_, index) => ({
      path: `doc-${index}.md`,
      content: content(),
    }));
    expect(validateBundle(bundleWith(files))).toContain(
      `Bundle exceeds the ${LIMITS.maxFiles} file limit`,
    );
    expect(
      validateBundle(
        bundleWith([{ path: "big.md", content: content("x".repeat(100_001)) }]),
      ),
    ).toContain("big.md exceeds the 100000 byte file limit");
    expect(
      validateBundle(
        bundleWith([
          { path: "big.md", content: content("x".repeat(100_001)) },
          { path: "wide.md", content: content("y".repeat(400_000)) },
          { path: "wide2.md", content: content("y".repeat(400_000)) },
          { path: "wide3.md", content: content("y".repeat(400_000)) },
        ]),
      ),
    ).toContain(`Bundle exceeds the ${LIMITS.maxBundleBytes} byte limit`);
  });
});

describe("CLI retrieval uses safe maximum ceilings, not Free constants", () => {
  it("pulls a Pro bundle above every Free limit", async () => {
    const files = [
      { path: "big.md", content: content("x".repeat(100_001)) },
      { path: "wide.md", content: content("y".repeat(400_000)) },
      { path: "wide2.md", content: content("y".repeat(400_000)) },
      { path: "wide3.md", content: content("y".repeat(400_000)) },
      ...Array.from({ length: 24 }, (_, index) => ({
        path: `doc-${index}.md`,
        content: content(),
      })),
    ];
    const decoded = decodePullBundle(pullResponse(files));
    expect(decoded.bundle.files).toHaveLength(files.length + 1);
    const parent = await mkdtemp(join(tmpdir(), "okfshare-pro-pull-"));
    const result = await pullBundle(
      pullResponse(files),
      join(parent, "knowledge"),
    );
    expect(result.files).toBe(files.length + 1);
    expect(result.sourceBytes).toBeGreaterThan(1_000_000);
  });

  it("rejects pulls above the hard absolute ceilings", async () => {
    expect(() =>
      decodePullBundle(
        pullResponse(
          Array.from({ length: 250 }, (_, index) => ({
            path: `doc-${index}.md`,
            content: content(),
          })),
        ),
      ),
    ).toThrow(`Bundle exceeds the ${SAFE_MAX_LIMITS.maxFiles} file limit`);
    expect(() =>
      decodePullBundle(
        pullResponse([
          { path: "huge.md", content: content("x".repeat(500_001)) },
        ]),
      ),
    ).toThrow("byte file limit");
    expect(() =>
      decodePullBundle(
        pullResponse(
          Array.from({ length: 25 }, (_, index) => ({
            path: `doc-${index}.md`,
            content: content("x".repeat(450_000)),
          })),
        ),
      ),
    ).toThrow("byte limit");
  });
});
