import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  constants,
  open,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export type Scope = "user" | "project";
export type InstallMode = "copy" | "link";
export type AdapterId =
  | "opencode"
  | "claude"
  | "codex"
  | "copilot"
  | "gemini"
  | "antigravity"
  | "universal";
export interface Target {
  adapter: AdapterId;
  label: string;
  skillsDir: string;
  detected: boolean;
  selected: boolean;
  detection: string[];
  duplicateRisk: string[];
}
export interface ManifestEntry {
  path: string;
  checksum: string;
  mode: InstallMode;
  source: string;
  installedAt: string;
  installerVersion?: string;
  sourceChecksum?: string;
  skillVersion?: string;
}
export interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}
export interface InstallOptions {
  scope: Scope;
  projectDir?: string;
  homeDir?: string;
  mode?: InstallMode;
  dryRun?: boolean;
  yes?: boolean;
  source?: string;
  adapters?: AdapterId[];
  approveModified?: boolean;
}
export interface OperationResult {
  ok: boolean;
  action: string;
  changed: string[];
  skipped: string[];
  errors: string[];
  targets: Target[];
}

export const INSTALLER_VERSION = "0.1.6";

export class UnknownAdapterError extends Error {
  constructor(public readonly ids: string[]) {
    super(`Unknown adapter${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`);
    this.name = "UnknownAdapterError";
  }
}

const manifestName = ".okfshare-agent-installer.json";
const adapters: Array<{
  id: AdapterId;
  label: string;
  user: string;
  project: string;
  marker: string;
  command?: string;
}> = [
  {
    id: "opencode",
    label: "OpenCode",
    user: ".config/opencode/skills",
    project: ".opencode/skills",
    marker: ".config/opencode",
    command: "opencode",
  },
  {
    id: "claude",
    label: "Claude Code",
    user: ".claude/skills",
    project: ".claude/skills",
    marker: ".claude",
  },
  {
    id: "codex",
    label: "Codex",
    user: ".codex/skills",
    project: ".codex/skills",
    marker: ".codex",
    command: "codex",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    user: ".copilot/skills",
    project: ".github/skills",
    marker: ".github",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    user: ".gemini/skills",
    project: ".gemini/skills",
    marker: ".gemini",
    command: "gemini",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    user: ".gemini/antigravity/skills",
    project: ".gemini/antigravity/skills",
    marker: ".gemini",
  },
  {
    id: "universal",
    label: "Universal agents",
    user: ".agents/skills",
    project: ".agents/skills",
    marker: "",
  },
];

export function canonicalSkillPath(): string {
  const packaged = resolve(import.meta.dirname, "../skill/SKILL.md");
  const checkedOut = resolve(
    import.meta.dirname,
    "../../../skills/okfshare/SKILL.md",
  );
  return existsSync(checkedOut) ? checkedOut : packaged;
}
export function checksum(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function detectTargets(
  options: Pick<
    InstallOptions,
    "scope" | "projectDir" | "homeDir" | "adapters"
  >,
): Target[] {
  const base =
    options.scope === "user"
      ? (options.homeDir ?? homedir())
      : (options.projectDir ?? process.cwd());
  const unknown = (options.adapters ?? []).filter(
    (id) => !adapters.some((adapter) => adapter.id === id),
  );
  if (unknown.length) throw new UnknownAdapterError(unknown);
  const universalDetected =
    !options.adapters || options.adapters.includes("universal");
  return adapters.map((adapter) => {
    const detection = [
      ...(adapter.marker && existsSync(join(base, adapter.marker))
        ? [`${adapter.marker} directory`]
        : []),
      ...(adapter.command && commandAvailable(adapter.command)
        ? [`${adapter.command} executable`]
        : []),
      ...(adapter.marker === "" ? ["universal fallback"] : []),
    ];
    const detected = detection.length > 0;
    return {
      adapter: adapter.id,
      label: adapter.label,
      skillsDir: join(
        base,
        options.scope === "user" ? adapter.user : adapter.project,
      ),
      detected,
      selected: !options.adapters || options.adapters.includes(adapter.id),
      detection,
      duplicateRisk:
        detected && adapter.id !== "universal" && universalDetected
          ? [
              "Universal fallback may install a duplicate skill in another agent directory",
            ]
          : adapter.id === "universal" &&
              detected &&
              adapters.some(
                (candidate) =>
                  candidate.id !== "universal" &&
                  (candidate.marker === "" ||
                    existsSync(join(base, candidate.marker))),
              )
            ? [
                "Detected adapter targets may duplicate this universal installation",
              ]
            : [],
    };
  });
}
function commandAvailable(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => existsSync(join(dir, command)));
}

function skillVersion(body: string): string | undefined {
  return body.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
}
const delimiter = process.platform === "win32" ? ";" : ":";

async function readManifest(dir: string): Promise<Manifest> {
  const path = join(dir, manifestName);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { version: 1, entries: [] };
    throw new Error(
      `Unsafe manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error(`Unsafe manifest ${path}: not a regular file`);
    const parsed = JSON.parse(await handle.readFile("utf8")) as Manifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries))
      throw new Error(`Unsafe manifest ${path}: invalid format`);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`Unsafe manifest ${path}: invalid JSON`);
    throw error;
  } finally {
    await handle.close();
  }
}

async function verifiedDirectory(dir: string): Promise<string> {
  await assertSafePath(dir, false);
  const physical = await realpath(dir);
  const stat = await lstat(physical);
  if (!stat.isDirectory()) throw new Error(`Unsafe parent directory: ${dir}`);
  return physical;
}

async function fsyncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    if (process.platform !== "win32")
      throw new Error(`Unable to sync directory: ${dir}`);
  }
}

async function manifestExistsAsUnsafe(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(`Refusing symlink manifest: ${path}`);
    if (!stat.isFile())
      throw new Error(`Refusing nonregular manifest: ${path}`);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw error;
  }
}

async function atomicWriteManifest(
  dir: string,
  manifest: Manifest,
): Promise<void> {
  const physical = await verifiedDirectory(dir);
  const path = join(physical, manifestName);
  await manifestExistsAsUnsafe(path);
  const temporaryDirectory = await mkdtemp(
    join(physical, ".okfshare-manifest-"),
  );
  const temporary = join(temporaryDirectory, "manifest.json");
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    if ((await realpath(dir)) !== physical)
      throw new Error(`Parent directory changed during manifest write: ${dir}`);
    await manifestExistsAsUnsafe(path);
    await rename(temporary, path);
    await fsyncDirectory(physical);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeManifest(
  dir: string,
  manifest: Manifest,
  dryRun: boolean,
): Promise<void> {
  if (!dryRun) await atomicWriteManifest(dir, manifest);
}
async function installedChecksum(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink()
      ? checksum(await readlink(path))
      : checksum(await readFile(path));
  } catch {
    return undefined;
  }
}

async function assertSafePath(
  path: string,
  allowMissing = true,
): Promise<void> {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`Refusing symlink path: ${current}`);
      if (!stat.isDirectory())
        throw new Error(`Unsupported non-directory path: ${current}`);
      await access(current, constants.W_OK);
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Refusing symlink")
      )
        throw error;
      if (
        error instanceof Error &&
        error.message.startsWith("Unsupported non-directory")
      )
        throw error;
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code !== "ENOENT"
      )
        throw new Error(`Unsafe or non-writable path: ${current}`);
      if (!allowMissing)
        throw new Error(`Required path does not exist: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Unsupported path: ${absolute}`);
    current = parent;
  }
}

function assertSupportedTarget(base: string, target: Target): void {
  const rel = relative(resolve(base), resolve(target.skillsDir));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Unsupported target path: ${target.skillsDir}`);
}

async function withTargetLock<T>(
  dir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = join(dir, ".okfshare-agent-installer.lock");
  await mkdir(lock, { recursive: false }).catch(() => {
    throw new Error(`Another installer operation is in progress for ${dir}`);
  });
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

type RenameOperation = (from: string, to: string) => Promise<void>;

async function replaceFile(
  destination: string,
  body: Uint8Array,
  source: string,
  mode: InstallMode,
  renameOperation: RenameOperation = rename,
): Promise<void> {
  const parent = dirname(destination);
  const safeParent = await verifiedDirectory(parent);
  const safeDestination = join(safeParent, basename(destination));
  const temporaryDirectory = await mkdtemp(
    join(safeParent, ".okfshare-agent-installer-"),
  );
  const temporary = join(temporaryDirectory, "SKILL.md");
  const backup = join(temporaryDirectory, "original");
  let preserveTemporaryDirectory = false;
  try {
    if (mode === "link") await symlink(resolve(source), temporary);
    else {
      await writeFile(temporary, body, { mode: 0o644 });
      await chmod(temporary, 0o644);
    }
    const stagedStat = await lstat(temporary);
    if (mode === "link" ? !stagedStat.isSymbolicLink() : !stagedStat.isFile())
      throw new Error(`Unsafe staged replacement: ${temporary}`);
    const destinationStat = await lstat(safeDestination).catch(() => undefined);
    if (
      destinationStat &&
      (destinationStat.isSymbolicLink() || !destinationStat.isFile())
    )
      throw new Error(`Refusing unsafe destination: ${safeDestination}`);
    if (process.platform === "win32" && destinationStat) {
      await renameOperation(safeDestination, backup);
      try {
        await renameOperation(temporary, safeDestination);
      } catch (error) {
        try {
          await renameOperation(backup, safeDestination);
        } catch (restoreError) {
          preserveTemporaryDirectory = true;
          throw new Error(
            `Replacement failed and original was preserved at ${backup}: ${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            }`,
          );
        }
        throw error;
      }
    } else {
      await renameOperation(temporary, safeDestination);
    }
  } finally {
    if (!preserveTemporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function replaceFileForTest(
  destination: string,
  body: Uint8Array,
  source: string,
  mode: InstallMode,
  renameOperation: RenameOperation,
): Promise<void> {
  return replaceFile(destination, body, source, mode, renameOperation);
}

export async function install(
  options: InstallOptions,
): Promise<OperationResult> {
  const source = options.source ?? canonicalSkillPath();
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile())
    throw new Error(`Unsupported canonical skill source: ${source}`);
  const body = await readFile(source);
  const sourceChecksum = checksum(body);
  const base =
    options.scope === "user"
      ? (options.homeDir ?? homedir())
      : (options.projectDir ?? process.cwd());
  const allTargets = detectTargets(options);
  if (!options.dryRun && !options.yes)
    throw new Error("Refusing noninteractive change; pass yes or dryRun");
  const targets = allTargets.filter(
    (target) => target.detected && target.selected,
  );
  const result: OperationResult = {
    ok: true,
    action: "install",
    changed: [],
    skipped: [],
    errors: [],
    targets: allTargets,
  };
  for (const target of targets) {
    const displayDestination = join(target.skillsDir, "okfshare", "SKILL.md");
    try {
      assertSupportedTarget(base, target);
      await assertSafePath(target.skillsDir);
      if (!options.dryRun) await mkdir(target.skillsDir, { recursive: true });
      const physicalTarget = options.dryRun
        ? undefined
        : await verifiedDirectory(target.skillsDir);
      let destination = join(
        physicalTarget ?? target.skillsDir,
        "okfshare",
        "SKILL.md",
      );
      const operation = async () => {
        if (!options.dryRun) {
          const destinationParent = dirname(destination);
          await assertSafePath(destinationParent);
          await mkdir(destinationParent, { recursive: true });
          const physicalDestinationParent =
            await verifiedDirectory(destinationParent);
          destination = join(physicalDestinationParent, "SKILL.md");
        }
        const manifestDir = physicalTarget ?? target.skillsDir;
        const manifest = await readManifest(manifestDir);
        const entry = manifest.entries.find(
          (item) => item.path === destination,
        );
        const current = await installedChecksum(destination);
        if (
          current &&
          current !== (entry?.checksum ?? "") &&
          !(options.approveModified && options.yes)
        ) {
          result.skipped.push(
            `${target.label}: ${displayDestination} (user-modified; pass explicit approval)`,
          );
          return;
        }
        if (
          current &&
          entry &&
          current === entry.checksum &&
          entry.sourceChecksum === sourceChecksum &&
          entry.mode === (options.mode ?? "copy")
        ) {
          result.skipped.push(
            `${target.label}: ${displayDestination} (already current)`,
          );
          return;
        }
        result.changed.push(displayDestination);
        if (options.dryRun) return;
        const destinationStat = await lstat(destination).catch(() => undefined);
        if (destinationStat?.isSymbolicLink())
          throw new Error(`Refusing symlink destination: ${destination}`);
        await replaceFile(destination, body, source, options.mode ?? "copy");
        manifest.entries = manifest.entries.filter(
          (item) => item.path !== destination,
        );
        manifest.entries.push({
          path: destination,
          checksum:
            options.mode === "link"
              ? checksum(resolve(source))
              : sourceChecksum,
          sourceChecksum,
          skillVersion: skillVersion(new TextDecoder().decode(body)),
          mode: options.mode ?? "copy",
          source: resolve(source),
          installerVersion: INSTALLER_VERSION,
          installedAt: new Date().toISOString(),
        });
        await writeManifest(manifestDir, manifest, false);
      };
      if (options.dryRun) await operation();
      else await withTargetLock(physicalTarget!, operation);
    } catch (error) {
      result.errors.push(
        `${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

export async function status(
  options: Pick<
    InstallOptions,
    "scope" | "projectDir" | "homeDir" | "adapters"
  >,
): Promise<
  Array<
    Target & {
      installed: boolean;
      modified: boolean;
      checksum?: string;
      installedChecksum?: string;
      canonicalChecksum: string;
      compatible: boolean;
      installerVersion?: string;
      skillVersion?: string;
      safe: boolean;
      issue?: string;
    }
  >
> {
  const targets = detectTargets(options);
  const expectedChecksum = checksum(await readFile(canonicalSkillPath()));
  return Promise.all(
    targets.map(async (target) => {
      let manifest: Manifest = { version: 1, entries: [] };
      let current: string | undefined;
      let safe = true;
      let issue: string | undefined;
      try {
        await assertSafePath(target.skillsDir);
        if (existsSync(target.skillsDir)) {
          const physicalTarget = await verifiedDirectory(target.skillsDir);
          const path = join(physicalTarget, "okfshare", "SKILL.md");
          manifest = await readManifest(physicalTarget);
          await assertSafePath(dirname(path));
          const destinationStat = await lstat(path).catch(() => undefined);
          const physicalEntry = manifest.entries.find(
            (item) => item.path === path,
          );
          if (
            destinationStat?.isSymbolicLink() &&
            (!physicalEntry ||
              physicalEntry.mode !== "link" ||
              (await readlink(path)) !== resolve(physicalEntry.source))
          )
            throw new Error(`Unsafe destination symlink: ${path}`);
          current = await installedChecksum(path);
        }
      } catch (error) {
        safe = false;
        issue = error instanceof Error ? error.message : String(error);
      }
      const path = join(target.skillsDir, "okfshare", "SKILL.md");
      const entry = manifest.entries.find(
        (item) => item.path === path || item.path === resolve(path),
      );
      return {
        ...target,
        installed: Boolean(current),
        modified: Boolean(current && (!entry || current !== entry.checksum)),
        checksum: current,
        installedChecksum: current,
        canonicalChecksum: expectedChecksum,
        compatible: Boolean(
          entry &&
          entry.installerVersion === INSTALLER_VERSION &&
          entry.sourceChecksum === expectedChecksum,
        ),
        installerVersion: entry?.installerVersion,
        skillVersion: entry?.skillVersion,
        safe,
        issue,
      };
    }),
  );
}

export async function uninstall(
  options: InstallOptions,
): Promise<OperationResult> {
  const allTargets = detectTargets(options);
  if (!options.dryRun && !options.yes)
    throw new Error("Refusing noninteractive change; pass yes or dryRun");
  const targets = allTargets.filter(
    (target) => target.detected && target.selected,
  );
  const result: OperationResult = {
    ok: true,
    action: "uninstall",
    changed: [],
    skipped: [],
    errors: [],
    targets: allTargets,
  };
  for (const target of targets) {
    const displayDir = join(target.skillsDir, "okfshare");
    const displayPath = join(displayDir, "SKILL.md");
    if (!existsSync(target.skillsDir)) continue;
    try {
      assertSupportedTarget(
        options.scope === "user"
          ? (options.homeDir ?? homedir())
          : (options.projectDir ?? process.cwd()),
        target,
      );
      const physicalTarget = await verifiedDirectory(target.skillsDir);
      const dir = join(physicalTarget, "okfshare");
      let physicalSkillDir = dir;
      const operation = async () => {
        await assertSafePath(dir);
        if (existsSync(dir)) physicalSkillDir = await verifiedDirectory(dir);
        const safePath = join(physicalSkillDir, "SKILL.md");
        const manifest = await readManifest(physicalTarget);
        const entry = manifest.entries.find(
          (item) => item.path === safePath || item.path === displayPath,
        );
        const current = await installedChecksum(safePath);
        if (!current) return;
        if (
          (!entry || current !== entry.checksum) &&
          !(options.approveModified && options.yes)
        ) {
          result.skipped.push(
            `${target.label}: ${displayPath} (user-modified; pass explicit approval)`,
          );
          return;
        }
        result.changed.push(displayPath);
        if (!options.dryRun) {
          const stat = await lstat(safePath);
          if (stat.isSymbolicLink()) {
            if (
              entry?.mode !== "link" ||
              (await readlink(safePath)) !== resolve(entry.source)
            )
              throw new Error(
                `Refusing arbitrary symlink destination: ${safePath}`,
              );
          } else if (!stat.isFile()) {
            throw new Error(`Refusing nonregular destination: ${safePath}`);
          }
          await rm(safePath, { force: true });
          try {
            await rmdir(physicalSkillDir);
          } catch {}
          await writeManifest(
            physicalTarget,
            {
              ...manifest,
              entries: manifest.entries.filter(
                (item) => item.path !== safePath && item.path !== displayPath,
              ),
            },
            false,
          );
        }
      };
      if (options.dryRun) await operation();
      else await withTargetLock(physicalTarget, operation);
    } catch (error) {
      result.errors.push(
        `${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}
