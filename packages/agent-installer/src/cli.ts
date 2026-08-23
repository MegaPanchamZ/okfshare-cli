#!/usr/bin/env node
import {
  install,
  status,
  uninstall,
  type InstallMode,
  type Scope,
  type AdapterId,
} from "./index.js";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const has = (flag: string) => args.includes(flag);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const list = (flag: string) => {
  const selected = value(flag);
  return typeof selected === "string"
    ? (selected.split(",").filter(Boolean) as AdapterId[])
    : undefined;
};
const scope = (value("--scope") as Scope | undefined) ?? "user";
const options = {
  scope,
  projectDir: value("--project"),
  mode: (has("--link") ? "link" : "copy") as InstallMode,
  dryRun: has("--dry-run"),
  yes: has("--yes"),
  adapters: list("--adapters"),
  approveModified: has("--approve-modified"),
};
if (!has("--yes") && !has("--dry-run") && command !== "status") {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Refusing noninteractive change; pass --yes or --dry-run.");
    process.exitCode = 2;
  } else {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await prompt.question(
      `Apply ${command} for ${scope} scope? [y/N] `,
    );
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) process.exitCode = 1;
    else options.yes = true;
  }
}
if (process.exitCode === undefined) {
  if (command === "install")
    console.log(JSON.stringify(await install(options), null, 2));
  else if (command === "uninstall")
    console.log(JSON.stringify(await uninstall(options), null, 2));
  else if (command === "status")
    console.log(JSON.stringify(await status(options), null, 2));
  else {
    console.error(
      "Usage: okfshare-agent <install|status|uninstall> [--scope user|project] [--project path] [--adapters ids] [--dry-run] [--yes] [--approve-modified] [--link]",
    );
    process.exitCode = 2;
  }
}
