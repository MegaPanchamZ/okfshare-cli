import {
  install,
  status,
  uninstall,
  type Scope,
  type AdapterId,
} from "@okfshare/agent-installer";

export type SkillStatus = {
  installed: boolean;
  location?: string;
  version?: string;
};
export interface SkillsAdapter {
  install(name: string): Promise<unknown>;
  status(name?: string): Promise<unknown>;
  uninstall(name: string): Promise<unknown>;
}
export type SkillOptions = {
  scope?: Scope;
  projectDir?: string;
  dryRun?: boolean;
  yes?: boolean;
  adapters?: AdapterId[];
};
export class AgentSkillsAdapter implements SkillsAdapter {
  constructor(private readonly options: SkillOptions = {}) {}
  private optionsFor() {
    return {
      scope: this.options.scope ?? "user",
      projectDir: this.options.projectDir,
      dryRun: this.options.dryRun,
      yes: this.options.yes,
      adapters: this.options.adapters,
    };
  }
  async install(name: string) {
    if (name !== "okfshare") throw new Error(`Unknown skill: ${name}`);
    return install(this.optionsFor());
  }
  async status(name = "okfshare") {
    if (name !== "okfshare") throw new Error(`Unknown skill: ${name}`);
    return status(this.optionsFor());
  }
  async uninstall(name: string) {
    if (name !== "okfshare") throw new Error(`Unknown skill: ${name}`);
    return uninstall(this.optionsFor());
  }
}
