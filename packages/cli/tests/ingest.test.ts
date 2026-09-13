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
import { ingestRepository, discoverAndDraft } from "../src/ingest.js";
import { collectBundleWithOverrides, validateBundle } from "../src/bundle.js";
import { resolveLimits } from "../src/limits.js";

describe("okfshare ingest", () => {
  it("uses the selected plan limits while collecting source files", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-pro-ingest-"));
    const outputDir = join(repoDir, "knowledge");
    await writeFile(
      join(repoDir, "README.md"),
      `# Large README\n${"x".repeat(100_001)}`,
    );

    const result = await discoverAndDraft(repoDir, outputDir, {
      limits: resolveLimits({
        maxFiles: 250,
        maxFileBytes: 500_000,
        maxBundleBytes: 10_000_000,
      }),
    });

    expect(result.discovered.map((file) => file.sourcePath)).toContain(
      "README.md",
    );
    expect(
      result.files.find((file) => file.path === "readme.md")?.bytes,
    ).toBeGreaterThan(100_000);
  });

  it("discovers README, agent rules, docs, and ADRs and creates a valid OKF draft", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-repo-test-"));
    const outputDir = join(repoDir, "knowledge");

    // 1. README
    await writeFile(
      join(repoDir, "README.md"),
      "# Awesome Project\n\nThis is an awesome project repository.\n",
    );

    // 2. Agent rules
    await writeFile(
      join(repoDir, ".cursorrules"),
      "You are a helpful pair programmer. Follow strict typing.\n",
    );
    await writeFile(
      join(repoDir, "CLAUDE.md"),
      "# Claude Code Guidelines\n\nAlways run tests before committing.\n",
    );
    await mkdir(join(repoDir, ".github"), { recursive: true });
    await writeFile(
      join(repoDir, ".github", "copilot-instructions.md"),
      "# Copilot Instructions\n\nFollow project architecture.\n",
    );

    // 3. ADRs
    await mkdir(join(repoDir, "docs", "adr"), { recursive: true });
    await writeFile(
      join(repoDir, "docs", "adr", "0001-use-sqlite.md"),
      "# 1. Use SQLite for Local Storage\n\nWe decide to use SQLite.\n",
    );

    // 4. Docs
    await writeFile(
      join(repoDir, "docs", "architecture.md"),
      "# Architecture Overview\n\nSystem architecture details.\n",
    );
    await writeFile(
      join(repoDir, "SECURITY.md"),
      "# Security Policy\n\nReport vulnerabilities via email.\n",
    );

    // Ignored directories (should not be ingested)
    await mkdir(join(repoDir, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(
      join(repoDir, "node_modules", "some-pkg", "README.md"),
      "# Bad",
    );
    await mkdir(join(repoDir, ".git"), { recursive: true });
    await writeFile(join(repoDir, ".git", "config.md"), "# Git");

    const result = await ingestRepository(repoDir, outputDir, {
      title: "Awesome Project Knowledge",
      description: "Complete knowledge base for Awesome Project",
      topics: ["awesome", "project"],
      yes: true,
    });

    expect(result.ok).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.errors).toEqual([]);
    expect(result.discovered.length).toBeGreaterThanOrEqual(6);

    // Check categories in discovered list
    const categories = new Set(result.discovered.map((d) => d.category));
    expect(categories.has("readme")).toBe(true);
    expect(categories.has("agent-rules")).toBe(true);
    expect(categories.has("adrs")).toBe(true);
    expect(categories.has("docs")).toBe(true);

    // Check generated index.md on disk
    const indexContent = await readFile(join(outputDir, "index.md"), "utf8");
    expect(indexContent).toContain('okf_version: "0.2"');
    expect(indexContent).toContain("# Awesome Project Knowledge");
    expect(indexContent).toContain("### Overview");
    expect(indexContent).toContain("### Agent Rules & Guidelines");
    expect(indexContent).toContain("### Architecture Decisions");
    expect(indexContent).toContain("### Documentation");

    // Check okfshare.json
    const configContent = await readFile(
      join(outputDir, "okfshare.json"),
      "utf8",
    );
    const config = JSON.parse(configContent);
    expect(config.title).toBe("Awesome Project Knowledge");
    expect(config.root).toBe("index.md");
    expect(config.topics).toEqual(["awesome", "project"]);

    // Verify on-disk bundle directly with bundle collector & validator
    const bundle = await collectBundleWithOverrides(outputDir);
    const validationErrors = validateBundle(bundle);
    expect(validationErrors).toEqual([]);

    // Check next commands guidance
    expect(result.next).toEqual([
      `npx okfshare@latest publish ${outputDir} --yes`,
      `npx okfshare@latest bind <SHARE_ID> ${outputDir}`,
      'npx okfshare@latest context <SHARE_ID> "How does this project work?"',
      'npx okfshare@latest search <SHARE_ID> "architecture"',
    ]);
  });

  it("handles dry-run mode without writing files to disk", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-dryrun-repo-"));
    const outputDir = join(repoDir, "knowledge-dryrun");

    await writeFile(join(repoDir, "README.md"), "# Dry Run Test\n");
    await writeFile(join(repoDir, "CLAUDE.md"), "# Claude Rules\n");

    const result = await ingestRepository(repoDir, outputDir, {
      dryRun: true,
      yes: true,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.discovered.length).toBe(2);
    expect(result.bundle.files).toBe(3); // index.md + readme + claude

    // Verify output directory was NOT created
    await expect(readFile(join(outputDir, "index.md"))).rejects.toThrow();
  });

  it("omits secret-bearing files and records warnings", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-secret-repo-"));
    const outputDir = join(repoDir, "knowledge");

    await writeFile(join(repoDir, "README.md"), "# Safe Readme\n");
    await writeFile(
      join(repoDir, "secret-notes.md"),
      "# Sensitive Notes\n\napi_key: sk_live_1234567890abcdef123456\n",
    );

    const result = await ingestRepository(repoDir, outputDir, { yes: true });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain(
      "Possible secret detected in secret-notes.md",
    );

    // secret-notes.md must not be in discovered or draft bundle
    expect(
      result.discovered.some((d) => d.sourcePath === "secret-notes.md"),
    ).toBe(false);
  });

  it("preserves and complements existing YAML frontmatter", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-frontmatter-repo-"));
    const outputDir = join(repoDir, "knowledge");

    const source =
      '---\n# keep this comment\ntitle: "Custom Readme Title"\nstatus: stable\n---\n\n# Body content\n\n';
    await writeFile(join(repoDir, "README.md"), source);

    const { files } = await discoverAndDraft(repoDir, outputDir);
    const readmeFile = files.find((f) => f.path === "readme.md");
    expect(readmeFile).toBeDefined();
    expect(readmeFile?.content).toBe(
      source.replace("status: stable\n", "status: stable\ntype: readme\n"),
    );
    await writeFile(
      join(repoDir, "typed.md"),
      "---\n# preserve\ntype: custom\ntitle: 'Quoted'\n---\nbody\n",
    );
    const typed = (
      await discoverAndDraft(repoDir, join(repoDir, "two"))
    ).files.find((file) => file.path === "typed.md");
    expect(typed?.content).toBe(
      "---\n# preserve\ntype: custom\ntitle: 'Quoted'\n---\nbody\n",
    );
  });

  it("is wall-clock independent and rejects malformed frontmatter", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-deterministic-repo-"));
    await writeFile(join(repoDir, "README.md"), "# Stable\n\nBody\n");
    await writeFile(
      join(repoDir, "docs.md"),
      "---\ntitle: [broken\n---\nBody\n",
    );

    const first = await discoverAndDraft(repoDir, join(repoDir, "one"));
    const second = await discoverAndDraft(repoDir, join(repoDir, "two"));
    expect(first.files).toEqual(second.files);
    expect(first.warnings).toContain(
      "Skipped docs.md: malformed YAML frontmatter (fix YAML before ingesting)",
    );
    expect(first.files.some((file) => file.content.includes("[broken"))).toBe(
      false,
    );
  });

  it("skips frontmatter with invalid type values", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-invalid-type-repo-"));
    await writeFile(join(repoDir, "number.md"), "---\ntype: 42\n---\nbody\n");
    await writeFile(join(repoDir, "blank.md"), '---\ntype: ""\n---\nbody\n');

    const result = await discoverAndDraft(repoDir, join(repoDir, "draft"));
    expect(result.discovered).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped blank.md: frontmatter type must be a non-empty string",
      "Skipped number.md: frontmatter type must be a non-empty string",
    ]);
  });

  it("cleans up staging when generated validation fails", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-cleanup-repo-"));
    const outputDir = join(repoDir, "draft");
    await writeFile(join(repoDir, "README.md"), "# Stable\n");

    await expect(
      ingestRepository(repoDir, outputDir, {
        title: "x".repeat(201),
        yes: true,
      }),
    ).rejects.toThrow("Generated OKF draft failed validation");
    await expect(readFile(outputDir, "utf8")).rejects.toThrow();
    const entries = await readdir(repoDir);
    expect(entries.some((entry) => entry.startsWith(".okfshare-ingest-"))).toBe(
      false,
    );
  });

  it("cleans up the claimed destination when a staged move fails", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-move-failure-repo-"));
    const outputDir = join(repoDir, "draft");
    await writeFile(join(repoDir, "README.md"), "# Stable\n");

    await expect(
      ingestRepository(repoDir, outputDir, {
        yes: true,
        fileOps: {
          rename: async () => {
            throw new Error("forced move failure");
          },
        },
      }),
    ).rejects.toThrow("forced move failure");
    await expect(readFile(join(outputDir, "index.md"))).rejects.toThrow();
    const entries = await readdir(repoDir);
    expect(entries.some((entry) => entry.startsWith(".okfshare-ingest-"))).toBe(
      false,
    );
  });

  it("rejects non-existent or invalid repository directory", async () => {
    await expect(
      ingestRepository("/non/existent/path/for/sure", "/tmp/out"),
    ).rejects.toThrow("Repository path must be a real directory");
  });

  it("creates an empty but reviewable draft when no knowledge is found", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-empty-repo-"));
    const outputDir = join(repoDir, "knowledge");

    const result = await ingestRepository(repoDir, outputDir, { yes: true });

    expect(result.ok).toBe(true);
    expect(result.discovered).toEqual([]);
    expect(result.warnings).toContain(
      "No relevant Markdown knowledge files were discovered",
    );
    expect(await readFile(join(outputDir, "index.md"), "utf8")).toContain(
      "## Contents",
    );
  });

  it("rejects an existing destination, including a destination symlink", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-existing-repo-"));
    const existing = join(repoDir, "knowledge");
    await mkdir(existing);
    await expect(
      ingestRepository(repoDir, existing, { yes: true }),
    ).rejects.toThrow("existing ingest destination");

    const other = await mkdtemp(join(tmpdir(), "okf-symlink-target-"));
    const link = join(repoDir, "linked-knowledge");
    await symlink(other, link);
    await expect(
      ingestRepository(repoDir, link, { yes: true }),
    ).rejects.toThrow("path containing a symlink");
  });

  it("does not follow symlinked knowledge files or directories", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-symlink-repo-"));
    const outside = await mkdtemp(join(tmpdir(), "okf-outside-"));
    await writeFile(join(outside, "README.md"), "# Should not be copied\n");
    await symlink(join(outside, "README.md"), join(repoDir, "README.md"));
    await symlink(outside, join(repoDir, "docs"));

    const result = await ingestRepository(repoDir, join(repoDir, "knowledge"), {
      yes: true,
    });
    expect(result.discovered).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped symlink candidate: README.md",
      "Skipped symlink candidate: docs",
      "No relevant Markdown knowledge files were discovered",
    ]);

    const ignoredTarget = await mkdtemp(join(tmpdir(), "okf-ignored-link-"));
    await symlink(ignoredTarget, join(repoDir, "node_modules"));
    const ignoredResult = await discoverAndDraft(
      repoDir,
      join(repoDir, "other-draft"),
    );
    expect(ignoredResult.warnings).not.toContain(
      "Skipped symlink candidate: node_modules",
    );
  });

  it("skips unsafe expanded targets and keeps collisions valid", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-target-boundary-repo-"));
    await writeFile(join(repoDir, ".cursorrules"), "cursor\n");
    await writeFile(join(repoDir, "cursorrules"), "cursor\n");
    await writeFile(
      join(repoDir, `agent-${"x".repeat(245)}.md`),
      "# Long rules\n",
    );

    const result = await ingestRepository(repoDir, join(repoDir, "draft"), {
      yes: true,
    });
    expect(result.ok).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.discovered.map((file) => file.targetPath)).toEqual([
      "rules/cursorrules.md",
      "rules/cursorrules-1.md",
    ]);
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("generated target path") ||
          warning.includes("unsafe or oversized canonical path"),
      ),
    ).toBe(true);
  });

  it("enforces the shared file limit while retaining deterministic priority", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-limit-repo-"));
    for (let index = 0; index < 30; index++)
      await writeFile(
        join(repoDir, `note-${String(index).padStart(2, "0")}.md`),
        `# Note ${index}\n`,
      );

    const result = await ingestRepository(repoDir, join(repoDir, "knowledge"), {
      yes: true,
    });
    expect(result.bundle.files).toBe(25);
    expect(
      result.warnings.some((warning) =>
        warning.toLowerCase().includes("file limit"),
      ),
    ).toBe(true);
    expect(result.discovered[0]?.sourcePath).toBe("note-00.md");
  });

  it("retains a stable aggregate-limit prefix and reports omitted files", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-aggregate-limit-repo-"));
    for (let index = 0; index < 15; index++)
      await writeFile(
        join(repoDir, `note-${String(index).padStart(2, "0")}.md`),
        `# Note ${index}\n${"x".repeat(90_000)}\n`,
      );

    const result = await ingestRepository(repoDir, join(repoDir, "knowledge"), {
      yes: true,
    });
    expect(result.ok).toBe(true);
    expect(result.bundle.bytes).toBeLessThanOrEqual(1_000_000);
    expect(result.discovered.map((file) => file.sourcePath)).toEqual(
      result.discovered.map((file) => file.sourcePath).sort(),
    );
    expect(
      result.warnings.filter((warning) =>
        warning.includes("aggregate bundle limit"),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("okfshare condensation", () => {
  it("detects git URLs", async () => {
    const { isGitUrl } = await import("../src/ingest.js");
    expect(isGitUrl("https://github.com/vercel/next.js")).toBe(true);
    expect(isGitUrl("git@github.com:vercel/next.js.git")).toBe(true);
    expect(isGitUrl("https://github.com/nodejs/node.git")).toBe(true);
    expect(isGitUrl("./local/repo")).toBe(false);
    expect(isGitUrl("/abs/path")).toBe(false);
  });

  it("scores canonical docs above changelogs and translations", async () => {
    const { docValueScore } = await import("../src/ingest.js");
    expect(docValueScore("docs/index.md")).toBeGreaterThan(
      docValueScore("docs/getting-started.md"),
    );
    expect(docValueScore("docs/getting-started.md")).toBeGreaterThan(
      docValueScore("docs/changelog.md"),
    );
    expect(docValueScore("docs/api/routing.md")).toBeGreaterThan(
      docValueScore("docs/translations/fr/routing.md"),
    );
  });

  it("condenses a large docs tree to high-value pages", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "okf-condense-"));
    await writeFile(join(repoDir, "README.md"), "# Project\n\nOverview.\n");
    await mkdir(join(repoDir, "docs"), { recursive: true });
    for (const [name, body] of [
      ["a-changelog.md", "Release history and changes."],
      ["b-license.md", "Licence text."],
      ["c-getting-started.md", "Install and start quickly."],
      ["d-api.md", "Core API reference."],
    ] as const)
      await writeFile(join(repoDir, "docs", name), `# ${name}\n\n${body}\n`);

    const limits = { ...resolveLimits(null), maxFiles: 4 };
    const condensed = await discoverAndDraft(
      repoDir,
      join(repoDir, "out-condensed"),
      { condense: true, limits },
    );
    const paths = condensed.discovered.map((file) => file.sourcePath);
    expect(paths).toContain("docs/c-getting-started.md");
    expect(paths).toContain("docs/d-api.md");
    expect(paths).not.toContain("docs/a-changelog.md");

    const plain = await discoverAndDraft(repoDir, join(repoDir, "out-plain"), {
      limits,
    });
    // Without condensing, alphabetical order wins and low-value docs are kept.
    expect(plain.discovered.map((file) => file.sourcePath)).toContain(
      "docs/a-changelog.md",
    );
  });
});
