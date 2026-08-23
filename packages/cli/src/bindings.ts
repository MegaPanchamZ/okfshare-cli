import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import constants from "node:constants";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Bundle } from "./bundle.js";
const { O_CREAT, O_EXCL, O_NOFOLLOW, O_TRUNC, O_WRONLY } = constants;

export type ProjectBinding = {
  version: 1;
  shareId: string;
  bundlePath: string;
  revision?: string;
  digest?: string;
};

export const bindingFile = (directory = ".") =>
  join(resolve(directory), ".okfshare-binding.json");

export function bundleDigest(
  bundle: Pick<Bundle, "root" | "title" | "description" | "visibility"> & {
    files: Array<Pick<Bundle["files"][number], "path" | "content">>;
  },
): string {
  const canonical = JSON.stringify({
    root: bundle.root,
    title: bundle.title,
    description: bundle.description,
    visibility: bundle.visibility,
    files: bundle.files.map(({ path, content }) => ({ path, content })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function readBinding(
  directory = ".",
): Promise<ProjectBinding | undefined> {
  try {
    const fileInfo = await lstat(bindingFile(directory));
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
      throw new Error("Binding file must be a regular non-symlink file");
    const value: unknown = JSON.parse(
      await readFile(bindingFile(directory), "utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid binding");
    const item = value as Record<string, unknown>;
    if (
      item.version !== 1 ||
      typeof item.shareId !== "string" ||
      typeof item.bundlePath !== "string"
    )
      throw new Error("Invalid binding");
    const root = await realDirectory(directory, "binding root");
    const storedPath = item.bundlePath;
    if (isAbsolute(storedPath))
      throw new Error("Binding bundle path must be project-relative");
    const bundlePath = await containedRealDirectory(
      root,
      resolve(root, storedPath),
      "binding bundle",
      true,
    );
    if (item.revision !== undefined && typeof item.revision !== "string")
      throw new Error("Invalid binding revision");
    if (item.digest !== undefined && typeof item.digest !== "string")
      throw new Error("Invalid binding digest");
    return { ...(value as ProjectBinding), bundlePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeBinding(
  directory: string,
  binding: Omit<ProjectBinding, "version">,
): Promise<ProjectBinding> {
  const root = await realDirectory(directory, "binding root");
  const requested = isAbsolute(binding.bundlePath)
    ? binding.bundlePath
    : resolve(root, binding.bundlePath);
  const bundlePath = await containedRealDirectory(
    root,
    requested,
    "binding bundle",
  );
  const storedPath = relative(root, bundlePath) || ".";
  const result: ProjectBinding = { version: 1, ...binding, bundlePath };
  const destination = bindingFile(root);
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error("Binding file must be a regular non-symlink file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(
    root,
    `.okfshare-binding.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(
    temporary,
    O_WRONLY | O_CREAT | O_EXCL | O_TRUNC | O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(
      `${JSON.stringify({ ...result, bundlePath: storedPath }, null, 2)}\n`,
      "utf8",
    );
    await file.chmod(0o600);
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return result;
}

async function realDirectory(path: string, name: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${name} must be a real directory`);
  return realpath(path);
}

async function containedRealDirectory(
  root: string,
  requested: string,
  name: string,
  allowMissing = false,
): Promise<string> {
  const candidate = resolve(requested);
  const lexical = relative(root, candidate);
  if (lexical.startsWith("..") || isAbsolute(lexical))
    throw new Error(`${name} must stay inside the project`);
  let canonical: string;
  try {
    canonical = await realDirectory(candidate, name);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
      return candidate;
    throw error;
  }
  const actual = relative(root, canonical);
  if (actual.startsWith("..") || isAbsolute(actual))
    throw new Error(`${name} must stay inside the project`);
  return canonical;
}

export async function removeBinding(directory = "."): Promise<void> {
  await rm(bindingFile(directory), { force: true });
}

export async function bindingStatus(directory = ".") {
  const binding = await readBinding(directory);
  if (!binding) return { bound: false };
  let present = true;
  try {
    const info = await lstat(binding.bundlePath);
    present = info.isDirectory() && !info.isSymbolicLink();
  } catch {
    present = false;
  }
  return { bound: true, binding, stale: !present };
}
