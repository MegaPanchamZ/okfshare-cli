import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalSkillPath,
  install,
  replaceFileForTest,
  status,
  uninstall,
} from "../src/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "okfshare-installer-"));
  const home = await mkdtemp(join(tmpdir(), "okfshare-home-"));
  const source = join(root, "SKILL.md");
  await writeFile(source, "canonical skill\n");
  return { root, home, source };
}

describe("agent installer", () => {
  it("installs, reports clean state, and removes its own file", async () => {
    const { home, source } = await fixture();
    const options = {
      scope: "user" as const,
      homeDir: home,
      source,
      yes: true,
    };
    const installed = await install(options);
    expect(installed.ok).toBe(true);
    const states = await status(options);
    expect(states.find((item) => item.adapter === "universal")?.installed).toBe(
      true,
    );
    const universal = states.find((item) => item.adapter === "universal");
    expect(universal?.checksum).toBeDefined();
    expect(universal?.canonicalChecksum).toBeDefined();
    expect(universal?.installerVersion).toBe("0.1.6");
    expect(universal?.compatible).toBe(false);
    expect(
      await readFile(join(home, ".agents/skills/okfshare/SKILL.md"), "utf8"),
    ).toBe("canonical skill\n");
    const removed = await uninstall(options);
    expect(removed.changed).toContain(
      join(home, ".agents/skills/okfshare/SKILL.md"),
    );
  });

  it("does not overwrite a modified managed file", async () => {
    const { home, source } = await fixture();
    const options = {
      scope: "user" as const,
      homeDir: home,
      source,
      yes: true,
    };
    await install(options);
    const destination = join(home, ".agents/skills/okfshare/SKILL.md");
    await writeFile(destination, "local edit\n");
    const result = await install(options);
    expect(result.skipped.some((item) => item.includes("user-modified"))).toBe(
      true,
    );
    expect(await readFile(destination, "utf8")).toBe("local edit\n");
  });

  it("preserves the original when the staged rename fails", async () => {
    const { root, source } = await fixture();
    const destination = join(root, "destination.md");
    await writeFile(destination, "original\n");
    const failingRename = async () => {
      throw new Error("injected rename failure");
    };
    await expect(
      replaceFileForTest(
        destination,
        new TextEncoder().encode("replacement\n"),
        source,
        "copy",
        failingRename,
      ),
    ).rejects.toThrow("injected rename failure");
    expect(await readFile(destination, "utf8")).toBe("original\n");
  });

  it("treats an unchanged managed skill as an idempotent update", async () => {
    const { home, source } = await fixture();
    const options = {
      scope: "user" as const,
      homeDir: home,
      source,
      yes: true,
    };
    await install(options);
    const result = await install(options);
    expect(result.changed).toHaveLength(0);
    expect(
      result.skipped.some((item) => item.includes("already current")),
    ).toBe(true);
  });

  it("reports canonical skill version, checksum, and compatibility", async () => {
    const { home } = await fixture();
    const options = { scope: "user" as const, homeDir: home, yes: true };
    await install(options);
    const universal = (await status(options)).find(
      (target) => target.adapter === "universal",
    );
    expect(universal?.skillVersion).toBe("1");
    expect(universal?.checksum).toBe(universal?.canonicalChecksum);
    expect(universal?.compatible).toBe(true);
    expect(universal?.safe).toBe(true);
  });

  it("requires explicit approval before replacing a modified skill", async () => {
    const { home, source } = await fixture();
    const options = {
      scope: "user" as const,
      homeDir: home,
      source,
      yes: true,
    };
    await install(options);
    const destination = join(home, ".agents/skills/okfshare/SKILL.md");
    await writeFile(destination, "local edit\n");
    expect(
      (await install({ ...options, approveModified: true })).changed,
    ).toContain(destination);
    expect(await readFile(destination, "utf8")).toBe("canonical skill\n");
  });

  it("supports adapter selection and reports detection evidence", async () => {
    const { home, source } = await fixture();
    const result = await install({
      scope: "user",
      homeDir: home,
      source,
      adapters: ["universal"],
      dryRun: true,
    });
    expect(result.targets).toHaveLength(7);
    const universal = result.targets.find(
      (target) => target.adapter === "universal",
    );
    expect(universal?.selected).toBe(true);
    expect(universal?.detection).toContain("universal fallback");
    expect(result.targets.filter((target) => target.selected)).toHaveLength(1);
    expect(
      result.targets.find((target) => target.adapter === "claude")?.skillsDir,
    ).toBe(join(home, ".claude/skills"));
    expect(
      result.targets.find((target) => target.adapter === "claude")?.selected,
    ).toBe(false);
    expect(result.changed).toContain(
      join(home, ".agents/skills/okfshare/SKILL.md"),
    );
  });

  it("rejects unknown adapter selections", async () => {
    const { home, source } = await fixture();
    await expect(
      install({
        scope: "user",
        homeDir: home,
        source,
        adapters: ["made-up" as never],
      }),
    ).rejects.toThrow("Unknown adapter");
  });

  it("refuses a symlinked target directory", async () => {
    const { home, source, root } = await fixture();
    await symlink(root, join(home, ".agents"));
    const result = await install({
      scope: "user",
      homeDir: home,
      source,
      yes: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("symlink"))).toBe(true);
  });

  it("keeps successful targets when another detected target is unsafe", async () => {
    const { home, source, root } = await fixture();
    await symlink(root, join(home, ".claude"));
    const result = await install({
      scope: "user",
      homeDir: home,
      source,
      yes: true,
    });
    expect(result.errors.some((error) => error.includes("Claude Code"))).toBe(
      true,
    );
    expect(result.changed).toContain(
      join(home, ".agents/skills/okfshare/SKILL.md"),
    );
  });

  it("rejects a symlinked manifest without touching its target", async () => {
    const { home, source, root } = await fixture();
    const skillsDir = join(home, ".agents/skills");
    const outside = join(root, "outside-manifest.json");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(outside, '{"version":1,"entries":[]}\n');
    await symlink(outside, join(skillsDir, ".okfshare-agent-installer.json"));
    const result = await install({
      scope: "user",
      homeDir: home,
      source,
      yes: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("manifest"))).toBe(
      true,
    );
    expect(await readFile(outside, "utf8")).toBe(
      '{"version":1,"entries":[]}\n',
    );
    const universal = (await status({ scope: "user", homeDir: home })).find(
      (target) => target.adapter === "universal",
    );
    expect(universal?.safe).toBe(false);
  });

  it("does not follow a manifest swapped to a symlink between updates", async () => {
    const { home, source, root } = await fixture();
    const options = {
      scope: "user" as const,
      homeDir: home,
      source,
      yes: true,
    };
    await install(options);
    const outside = join(root, "swapped-manifest.json");
    const manifest = join(
      home,
      ".agents/skills/.okfshare-agent-installer.json",
    );
    await writeFile(outside, '{"version":1,"entries":[]}\n');
    await rm(manifest);
    await symlink(outside, manifest);
    const result = await install(options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("manifest"))).toBe(
      true,
    );
    expect(await readFile(outside, "utf8")).toBe(
      '{"version":1,"entries":[]}\n',
    );
  });

  it("supports project scope and dry runs", async () => {
    const { root, source } = await fixture();
    const result = await install({
      scope: "project",
      projectDir: root,
      source,
      dryRun: true,
    });
    expect(result.changed).toContain(
      join(root, ".agents/skills/okfshare/SKILL.md"),
    );
    await expect(
      readFile(join(root, ".agents/skills/okfshare/SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("refuses non-dry-run library changes without explicit approval", async () => {
    const { home, source } = await fixture();
    await expect(
      install({ scope: "user", homeDir: home, source }),
    ).rejects.toThrow("noninteractive");
  });

  it("does not remove unrelated files during uninstall", async () => {
    const { home, source } = await fixture();
    const options = {
      scope: "user" as const,
      homeDir: home,
      source,
      yes: true,
    };
    await install(options);
    const extra = join(home, ".agents/skills/okfshare/notes.md");
    await writeFile(extra, "keep me\n");
    await uninstall(options);
    expect(await readFile(extra, "utf8")).toBe("keep me\n");
  });

  it("ships the canonical retrieval contract and safety guidance", async () => {
    const skill = await readFile(canonicalSkillPath(), "utf8");
    const packaged = await readFile(
      resolve(import.meta.dirname, "../skill/SKILL.md"),
      "utf8",
    );
    expect(packaged).toBe(skill);
    expect(skill).toContain("npx okfshare@latest pull SHARE_ID");
    expect(skill).toContain("npx okfshare@latest search SHARE_ID");
    expect(skill).toContain("npx okfshare@latest context SHARE_ID");
    expect(skill).toContain("destination must not already exist");
    expect(skill).toContain("destination parent must not be writable");
    expect(skill).toContain("Validate before publishing");
    expect(skill).toContain("browserless or agent shell");
    expect(skill).toContain("must not read, print, echo, persist, or log");
    expect(skill).toContain("run `login` in a real terminal");
    expect(skill).toContain("directory `0700`, file `0600`");
    expect(skill).toContain("workspace:read");
    expect(skill).toContain("workspace:write");
    expect(skill).toContain(
      "API keys and\nCLI credentials are both accepted bearer forms",
    );
    expect(skill).toContain(
      "run both `npx okfshare@latest whoami` and `npx okfshare@latest doctor --json`",
    );
    expect(skill).toContain("do not work around it");
    expect(skill).not.toMatch(/OKFSHARE_TOKEN\s*=\s*['"][^'"]+['"]/);
    expect(skill).not.toMatch(/(^|\s)okfshare\s+(discover|build)/m);
    expect(skill).not.toMatch(
      /(^|\s)okfshare\s+(login|publish|pull|search|context)/m,
    );
    expect(skill).not.toMatch(/^\s*okfshare\s+[a-z]/m);
    expect(skill).not.toMatch(/^\s*npx okfshare\s+(?!@latest)[a-z]/m);
    const commandLines = skill
      .split("\n")
      .filter((line) => line.trim().startsWith("npx "));
    expect(commandLines.length).toBeGreaterThan(8);
    expect(
      commandLines.every((line) =>
        line.trim().startsWith("npx okfshare@latest "),
      ),
    ).toBe(true);
    for (const flag of [
      "--json",
      "--yes",
      "--dry-run",
      "--revision",
      "--limit",
      "--max-tokens",
      "--root",
      "--visibility",
    ]) {
      expect(skill).toContain(flag);
    }
  });

  it("documents only commands and flags present in the real CLI source", async () => {
    const cliSourcePath = resolve(
      import.meta.dirname,
      "../../cli/src/index.ts",
    );
    expect(existsSync(cliSourcePath)).toBe(true);
    const cliSource = await readFile(cliSourcePath, "utf8");
    const cliMetadata = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../../cli/package.json"),
        "utf8",
      ),
    ) as { name?: string; bin?: { okfshare?: string } };
    expect(cliMetadata.name).toBe("okfshare");
    expect(cliMetadata.bin?.okfshare).toBe("dist/index.js");
    const commandSet =
      cliSource.match(/const commands = new Set\(\[([^\]]+)\]\)/)?.[1] ?? "";
    const commands = [...commandSet.matchAll(/"([a-z-]+)"/g)].map(
      (match) => match[1],
    );
    const flagSets = [
      ...cliSource.matchAll(/new Set\(\[([^\]]+)\]\)/g),
    ].flatMap((match) =>
      [...match[1].matchAll(/"([a-z-]+)"/g)].map((item) => item[1]),
    );
    expect(commands.length).toBeGreaterThan(0);
    const documented = (await readFile(canonicalSkillPath(), "utf8"))
      .split("\n")
      .filter((line) => line.trim().startsWith("npx okfshare@latest "));
    for (const line of documented) {
      const command = line.trim().split(/\s+/)[2];
      if (command !== "--help") expect(commands).toContain(command);
      for (const flag of line.match(/--[a-z-]+/g) ?? []) {
        expect(flagSets).toContain(flag.slice(2));
      }
    }
  });
});
