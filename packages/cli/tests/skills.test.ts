import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSkillsAdapter } from "../src/skills.js";
import { detectTargets } from "@okfshare/agent-installer";

describe("CLI skills integration", () => {
  it("uses the agent installer for dry-run, install, status, and uninstall", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "okfshare-cli-skills-"));
    const previewAdapter = new AgentSkillsAdapter({
      scope: "project",
      projectDir,
      dryRun: true,
      yes: true,
    });

    const preview = (await previewAdapter.install("okfshare")) as {
      changed: string[];
    };
    expect(preview.changed).toContain(
      join(projectDir, ".agents/skills/okfshare/SKILL.md"),
    );
    const adapter = new AgentSkillsAdapter({
      scope: "project",
      projectDir,
      yes: true,
    });
    await adapter.install("okfshare");
    expect(
      await readFile(
        join(projectDir, ".agents/skills/okfshare/SKILL.md"),
        "utf8",
      ),
    ).toContain("name: okfshare");
    expect(
      (
        (await adapter.status("okfshare")) as Array<{ installed: boolean }>
      ).some((item) => item.installed),
    ).toBe(true);
    const removed = (await adapter.uninstall("okfshare")) as {
      changed: string[];
    };
    expect(removed.changed).toContain(
      join(projectDir, ".agents/skills/okfshare/SKILL.md"),
    );
  });
  it("passes explicit adapter selection through to the installer target model", () => {
    const targets = detectTargets({
      scope: "project",
      projectDir: process.cwd(),
      adapters: ["universal"],
    });
    expect(
      targets.find((target) => target.adapter === "universal")?.selected,
    ).toBe(true);
    expect(
      targets.find((target) => target.adapter === "claude")?.selected,
    ).toBe(false);
  });
});
