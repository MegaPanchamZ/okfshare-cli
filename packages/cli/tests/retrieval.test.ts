import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePullBundle, pullBundle } from "../src/retrieval.js";

const rootContent = "---\ntype: Note\n---\n# Root\n";
function response(
  files = [{ path: "README.md", content: rootContent }],
  overrides: Record<string, unknown> = {},
) {
  return {
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
        id: "revision-2",
        number: 2,
        immutable: true,
        sizeBytes: 9000,
        fileCount: files.length,
        createdAt: "now",
      },
      bundle: {
        title: "Title",
        description: "Description",
        root: "README.md",
        okfVersion: null,
        files,
        concepts: [],
        reserved: {},
        types: [],
        trustSummary: {},
        graph: {},
        ...overrides,
      },
    },
  };
}

describe("retrieval pull safety", () => {
  it("pulls safely and writes pinned metadata even when encoded size is larger", async () => {
    const parent = await mkdtemp(join(tmpdir(), "okfshare-pull-"));
    const destination = join(parent, "knowledge");
    const result = await pullBundle(response(), destination);
    expect(result.revision.number).toBe(2);
    expect(result.sourceBytes).toBe(Buffer.byteLength(rootContent));
    expect(result.storedBytes).toBe(9000);
    expect(await readdir(destination)).toEqual(
      expect.arrayContaining([
        "README.md",
        "okfshare.json",
        ".okfshare-pull.json",
      ]),
    );
    expect(
      JSON.parse(
        await readFile(join(destination, ".okfshare-pull.json"), "utf8"),
      ),
    ).toMatchObject({
      shareId: "share-1",
      revision: { id: "revision-2", number: 2 },
      sourceBytes: Buffer.byteLength(rootContent),
      storedBytes: 9000,
    });
  });

  it("dry-runs without creating a destination", async () => {
    const parent = await mkdtemp(join(tmpdir(), "okfshare-dry-"));
    const destination = join(parent, "missing");
    await pullBundle(response(), destination, true);
    await expect(readdir(destination)).rejects.toThrow();
  });

  it.each([
    "../evil.md",
    "dir\\evil.md",
    "%2e%2e/evil.md",
    "dir%2f..%2fevil.md",
  ])("rejects unsafe path %s", async (path) => {
    await expect(
      pullBundle(
        response([{ path, content: rootContent }]),
        join(tmpdir(), "unused"),
        true,
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicates, invalid roots, caps, nonempty destinations, and symlinks", async () => {
    await expect(
      pullBundle(
        response([
          { path: "README.md", content: rootContent },
          { path: "README.md", content: rootContent },
        ]),
        join(tmpdir(), "unused"),
        true,
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      pullBundle(
        response([{ path: "README.md", content: rootContent }], {
          root: "missing.md",
        }),
        join(tmpdir(), "unused"),
        true,
      ),
    ).rejects.toThrow("Root");
    const tooMany = Array.from({ length: 26 }, (_, index) => ({
      path: index ? `file-${index}.md` : "README.md",
      content: rootContent,
    }));
    await expect(
      pullBundle(response(tooMany), join(tmpdir(), "unused"), true),
    ).rejects.toThrow("file limit");
    await expect(
      pullBundle(
        response([{ path: "README.md", content: "x".repeat(100_001) }]),
        join(tmpdir(), "unused"),
        true,
      ),
    ).rejects.toThrow("byte file limit");
    const tooLarge = Array.from({ length: 11 }, (_, index) => ({
      path: index ? `file-${index}.md` : "README.md",
      content: "x".repeat(100_000),
    }));
    await expect(
      pullBundle(response(tooLarge), join(tmpdir(), "unused"), true),
    ).rejects.toThrow("byte limit");
    const parent = await mkdtemp(join(tmpdir(), "okfshare-destination-"));
    const nonempty = join(parent, "nonempty");
    await mkdir(nonempty);
    await writeFile(join(nonempty, "old.md"), "old");
    await expect(pullBundle(response(), nonempty, true)).rejects.toThrow(
      "already exist",
    );
    const link = join(parent, "link");
    await symlink(nonempty, link);
    await expect(pullBundle(response(), link, true)).rejects.toThrow("symlink");
  });

  it("does not leave a staging directory after final placement", async () => {
    const parent = await mkdtemp(join(tmpdir(), "okfshare-stage-"));
    const destination = join(parent, "destination");
    await expect(pullBundle(response(), destination)).resolves.toBeTruthy();
    expect(
      (await readdir(parent)).filter((name) =>
        name.startsWith(".okfshare-pull-"),
      ).length,
    ).toBe(0);
  });

  it("rejects existing destinations and symlinked parent ancestors", async () => {
    const parent = await mkdtemp(join(tmpdir(), "okfshare-parent-"));
    const existing = join(parent, "existing");
    await mkdir(existing);
    await expect(pullBundle(response(), existing)).rejects.toThrow(
      "already exist",
    );
    const real = join(parent, "real");
    await mkdir(real);
    const linked = join(parent, "linked");
    await symlink(real, linked);
    await expect(
      pullBundle(response(), join(linked, "destination")),
    ).rejects.toThrow("Symlinked parent");
  });

  it("rejects filesystem-colliding and Windows-invalid paths", async () => {
    await expect(
      pullBundle(
        response([
          { path: "README.md", content: rootContent },
          { path: "docs/Guide.md", content: rootContent },
          { path: "docs/guide.md", content: rootContent },
        ]),
        join(tmpdir(), "unused"),
        true,
      ),
    ).rejects.toThrow("colliding");
    for (const path of ["CON.md", "notes. md", "notes.md ", "notes:.md"]) {
      await expect(
        pullBundle(
          response([{ path, content: rootContent }]),
          join(tmpdir(), "unused"),
          true,
        ),
      ).rejects.toThrow();
    }
  });

  it("enforces UTF-8 byte limits for complete paths and segments", async () => {
    for (const path of [
      `${"é".repeat(120)}.md`,
      `docs/${"é".repeat(120)}.md`,
    ]) {
      await expect(
        pullBundle(
          response([{ path, content: rootContent }], { root: path }),
          join(tmpdir(), "unused"),
          true,
        ),
      ).rejects.toThrow();
    }
  });

  it("strictly decodes the pull response", () => {
    expect(decodePullBundle(response()).revision.sizeBytes).toBe(9000);
    expect(() => decodePullBundle({ data: {} })).toThrow();
    const tooSmall = response();
    tooSmall.data.revision.sizeBytes = 1;
    expect(() => decodePullBundle(tooSmall)).toThrow("smaller than source");
  });
});
