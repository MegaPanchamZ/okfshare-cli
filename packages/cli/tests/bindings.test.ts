import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindingStatus,
  bundleDigest,
  readBinding,
  writeBinding,
} from "../src/bindings.js";

describe("project bindings", () => {
  it("uses one canonical digest for collected bundles and API payloads", () => {
    const bundle = {
      root: "index.md",
      title: "Canonical",
      description: "Digest",
      visibility: "unlisted",
      files: [{ path: "index.md", content: "# Canonical\n", bytes: 12 }],
    };
    expect(
      bundleDigest({
        root: bundle.root,
        title: bundle.title,
        description: bundle.description,
        visibility: bundle.visibility,
        files: bundle.files.map(({ path, content }) => ({ path, content })),
      }),
    ).toBe(bundleDigest(bundle));
  });

  it("stores only canonical share, path, revision, and digest facts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okfshare-binding-"));
    await mkdir(join(directory, "docs"));
    const bundle = {
      root: "README.md",
      title: "Title",
      description: "",
      visibility: "unlisted",
      files: [{ path: "README.md", content: "root", bytes: 4 }],
    };
    const digest = bundleDigest(bundle);
    await writeBinding(directory, {
      shareId: "share-1",
      bundlePath: "docs",
      revision: "2",
      digest,
    });
    const stored = JSON.parse(
      await readFile(join(directory, ".okfshare-binding.json"), "utf8"),
    );
    expect(stored.bundlePath).toBe("docs");
    expect(stored).not.toHaveProperty("token");
    expect(await readBinding(directory)).toMatchObject({
      shareId: "share-1",
      revision: "2",
      digest,
    });
    expect(await bindingStatus(directory)).toMatchObject({
      bound: true,
      stale: false,
    });
  });
  it("rejects checked-in absolute or escaping binding paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okfshare-binding-safe-"));
    await writeFile(
      join(directory, ".okfshare-binding.json"),
      JSON.stringify({ version: 1, shareId: "x", bundlePath: "../" }),
    );
    await expect(bindingStatus(directory)).rejects.toThrow(
      "inside the project",
    );
  });
  it("reports a moved or missing bundle as bound and stale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okfshare-binding-moved-"));
    await writeFile(
      join(directory, ".okfshare-binding.json"),
      JSON.stringify({
        version: 1,
        shareId: "x",
        bundlePath: "moved-bundle",
        revision: "2",
      }),
    );
    expect(await bindingStatus(directory)).toMatchObject({
      bound: true,
      stale: true,
      binding: { shareId: "x" },
    });
  });
  it("rejects a symlinked binding file on replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okfshare-binding-link-"));
    await symlink(
      join(directory, "elsewhere"),
      join(directory, ".okfshare-binding.json"),
    );
    await expect(
      writeBinding(directory, { shareId: "x", bundlePath: "." }),
    ).rejects.toThrow("regular non-symlink");
  });
});
