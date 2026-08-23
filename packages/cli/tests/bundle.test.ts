import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectBundle,
  collectBundleWithOverrides,
  validateBundle,
} from "../src/bundle.js";

describe("collectBundle", () => {
  it("recurses markdown and ignores generated directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-"));
    await mkdir(join(dir, "nested"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "README.md"), "# Hello");
    await writeFile(join(dir, "nested", "guide.md"), "guide");
    await writeFile(join(dir, "node_modules", "bad.md"), "bad");
    const bundle = await collectBundle(dir);
    expect(bundle.files.map((file) => file.path)).toEqual([
      "README.md",
      "nested/guide.md",
    ]);
    expect(bundle.readme).toBe("README.md");
  });
  it("excludes agent skill directories without excluding intended GitHub documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-agent-skills-"));
    await mkdir(join(dir, ".agents", "skills"), { recursive: true });
    await mkdir(join(dir, ".opencode", "skills"), { recursive: true });
    await mkdir(join(dir, ".github", "skills"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# Knowledge");
    await writeFile(
      join(dir, ".agents", "skills", "SKILL.md"),
      "---\ntype: Agent\n---\nprivate instructions",
    );
    await writeFile(
      join(dir, ".opencode", "skills", "SKILL.md"),
      "---\ntype: Agent\n---\nprivate instructions",
    );
    await writeFile(
      join(dir, ".github", "skills", "SKILL.md"),
      "---\ntype: Agent\n---\nprivate instructions",
    );
    await writeFile(
      join(dir, ".github", "release.md"),
      "---\ntype: Note\n---\nrelease notes",
    );
    const bundle = await collectBundle(dir);
    expect(bundle.files.map((file) => file.path)).toEqual([
      ".github/release.md",
      "README.md",
    ]);
  });

  it("enforces OKF frontmatter and the server file limits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-invalid-"));
    await writeFile(join(dir, "index.md"), "# valid root");
    await writeFile(join(dir, "note.md"), "# missing type");
    const bundle = await collectBundle(dir);
    expect(validateBundle(bundle)).toContain(
      "Every non-reserved markdown file needs a non-empty YAML type: note.md",
    );

    const boundary = await mkdtemp(join(tmpdir(), "okfshare-boundary-"));
    await writeFile(join(boundary, "index.md"), "# root");
    await writeFile(
      join(boundary, "note.md"),
      `---\ntype: Note\n---\n${"x".repeat(100_001)}`,
    );
    await expect(collectBundle(boundary)).rejects.toThrow(
      "note.md exceeds the 100000 byte file limit",
    );
  });

  it("uses path globs and refuses symlinks and obvious secret files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-safety-"));
    await writeFile(
      join(dir, "okfshare.json"),
      JSON.stringify({ include: ["**/*.md"], exclude: ["draft/*.md"] }),
    );
    await mkdir(join(dir, "draft"));
    await writeFile(join(dir, "index.md"), "# root");
    await writeFile(join(dir, "draft", "ignored.md"), "# ignored");
    await writeFile(join(dir, "credentials.md"), "token");
    await expect(collectBundle(dir)).rejects.toThrow("Private or secret file");
  });

  it("flags real inline secrets but allows placeholder values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-secrets-"));
    await writeFile(join(dir, "index.md"), "# root");
    await writeFile(
      join(dir, "doc.md"),
      "API_KEY=1234567890abcdef\nGITHUB_CLIENT_SECRET=...\npassword=x\n",
    );
    await expect(collectBundle(dir)).rejects.toThrow(
      "Possible secret detected",
    );

    const clean = await mkdtemp(join(tmpdir(), "okfshare-placeholder-"));
    await writeFile(
      join(clean, "README.md"),
      "WORKOS_API_KEY=sk_test_...\nGITHUB_CLIENT_SECRET=...\nAPI_KEY=<your-key-here>\n# fine\n",
    );
    const bundle = await collectBundle(clean);
    expect(bundle.files.map((file) => file.path)).toContain("README.md");
  });
  it("detects structured provider credentials and connection strings", async () => {
    const secrets = [
      '{"access_token":"real-token-value-123"}',
      "apiToken: real-api-token-value-123",
      "CLIENT_SECRET='real-client-secret-123'",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "GITHUB_TOKEN=ghp_123456789012345678901234",
      "DATABASE_URL=postgres://user:password@db.example.test/app",
    ];
    for (const value of secrets) {
      const dir = await mkdtemp(join(tmpdir(), "okfshare-structured-secret-"));
      await writeFile(join(dir, "README.md"), `# root\n${value}`);
      await expect(collectBundle(dir)).rejects.toThrow(
        "Possible secret detected in: README.md",
      );
    }
  });

  it("walks the publishing directory and selects an exact configured nested root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-root-"));
    await mkdir(join(dir, "docs"));
    await writeFile(
      join(dir, "okfshare.json"),
      JSON.stringify({ root: "docs/guide.md" }),
    );
    await writeFile(join(dir, "README.md"), "---\ntype: Note\n---\nreadme");
    await writeFile(
      join(dir, "docs", "guide.md"),
      "---\ntype: Guide\n---\n# Guide",
    );
    const bundle = await collectBundle(dir);
    expect(bundle.files.map((file) => file.path)).toContain("README.md");
    expect(bundle.root).toBe("docs/guide.md");
    expect(bundle.title).toBe("Guide");
  });

  it("rejects missing, unsafe, and non-Markdown configured roots", async () => {
    for (const root of ["missing.md", "../outside.md", "docs"]) {
      const dir = await mkdtemp(join(tmpdir(), "okfshare-bad-root-"));
      await writeFile(join(dir, "okfshare.json"), JSON.stringify({ root }));
      await writeFile(join(dir, "README.md"), "---\ntype: Note\n---\nroot");
      await expect(collectBundle(dir)).rejects.toThrow(/Configured root/);
    }
  });

  it("lets command-line metadata overrides take precedence over config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-overrides-"));
    await writeFile(
      join(dir, "okfshare.json"),
      JSON.stringify({
        root: "README.md",
        title: "Config title",
        description: "Config description",
        visibility: "public",
      }),
    );
    await writeFile(join(dir, "README.md"), "---\ntype: Note\n---\nroot");
    await mkdir(join(dir, "docs"));
    await writeFile(
      join(dir, "docs", "guide.md"),
      "---\ntype: Guide\n---\n# Guide",
    );
    const bundle = await collectBundleWithOverrides(dir, {
      root: "docs/guide.md",
      title: "Flag title",
      description: "Flag description",
      visibility: "password",
      password: "flag-password",
    });
    expect(bundle.title).toBe("Flag title");
    expect(bundle.root).toBe("docs/guide.md");
    expect(bundle.description).toBe("Flag description");
    expect(bundle.visibility).toBe("password");
    expect(bundle.password).toBe("flag-password");
  });

  it("infers a title for a config-free valid root bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfshare-title-"));
    await writeFile(
      join(dir, "README.md"),
      "---\ntype: Note\n---\n# Knowledge",
    );
    const bundle = await collectBundle(dir);
    expect(bundle.title).toBe("Knowledge");
    expect(bundle.visibility).toBe("unlisted");
    expect(validateBundle(bundle)).toEqual([]);
  });
});
