import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LIMITS } from "./limits.js";
import {
  isSafeRelativeMarkdownPath,
  validateBundle,
  type Bundle,
} from "./bundle.js";

type RemoteFile = { path: string; content: string };
type PullData = {
  share: {
    id: string;
    slug: string;
    title: string;
    description: string;
    visibility: string;
    status: string;
  };
  revision: {
    id: string;
    number: number;
    immutable: boolean;
    sizeBytes: number;
    fileCount: number;
    createdAt: string;
  };
  bundle: {
    title: string;
    description: string;
    root: string;
    okfVersion: string;
    files: RemoteFile[];
    [key: string]: unknown;
  };
};

function decodedPathIsUnsafe(path: string): boolean {
  if (path.includes("%")) return true;
  if (
    Buffer.byteLength(path, "utf8") > LIMITS.maxPathBytes ||
    path
      .split("/")
      .some(
        (segment) => Buffer.byteLength(segment, "utf8") > LIMITS.maxPathBytes,
      )
  )
    return true;
  const normalized = path.normalize("NFKC");
  if (normalized !== path && !isSafeRelativeMarkdownPath(normalized))
    return true;
  return (
    !isSafeRelativeMarkdownPath(path) ||
    /(?:^|\/|\\)\.\.(?:\/|\\|$)/.test(path) ||
    path.startsWith("/") ||
    path.includes("\\")
  );
}

export function decodePullBundle(data: unknown): PullData {
  if (!data || typeof data !== "object" || !("data" in data))
    throw new Error("Invalid bundle response");
  const value = (data as { data?: unknown }).data;
  if (!value || typeof value !== "object")
    throw new Error("Invalid bundle response data");
  const result = value as Record<string, unknown>;
  const bundle = result.bundle as Record<string, unknown>;
  const files = bundle?.files;
  if (!bundle || !Array.isArray(files))
    throw new Error("Invalid remote bundle");
  const seen = new Set<string>();
  const collisionKeys = new Set<string>();
  const remoteFiles: RemoteFile[] = [];
  let totalBytes = 0;
  for (const item of files) {
    if (!item || typeof item !== "object")
      throw new Error("Invalid remote file");
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.content !== "string")
      throw new Error("Invalid remote file fields");
    if (
      decodedPathIsUnsafe(file.path) ||
      !file.path.toLowerCase().endsWith(".md")
    )
      throw new Error(`Unsafe Markdown path: ${file.path}`);
    if (seen.has(file.path))
      throw new Error(`Duplicate remote path: ${file.path}`);
    const key = file.path.normalize("NFKC").toLowerCase();
    if (collisionKeys.has(key))
      throw new Error(`Filesystem-colliding remote path: ${file.path}`);
    seen.add(file.path);
    collisionKeys.add(key);
    const bytes = Buffer.byteLength(file.content);
    if (bytes > LIMITS.maxFileBytes)
      throw new Error(
        `${file.path} exceeds the ${LIMITS.maxFileBytes} byte file limit`,
      );
    totalBytes += bytes;
    remoteFiles.push({ path: file.path, content: file.content });
  }
  if (remoteFiles.length > LIMITS.maxFiles)
    throw new Error(`Bundle exceeds the ${LIMITS.maxFiles} file limit`);
  if (totalBytes > LIMITS.maxBundleBytes)
    throw new Error(`Bundle exceeds the ${LIMITS.maxBundleBytes} byte limit`);
  if (
    typeof bundle.root !== "string" ||
    decodedPathIsUnsafe(bundle.root) ||
    !seen.has(bundle.root) ||
    !bundle.root.toLowerCase().endsWith(".md")
  )
    throw new Error("Root must be an existing safe markdown path");
  const share = result.share as Record<string, unknown>;
  const revision = result.revision as Record<string, unknown>;
  if (!share || typeof share.id !== "string" || typeof share.slug !== "string")
    throw new Error("Invalid bundle share");
  if (
    !revision ||
    typeof revision.id !== "string" ||
    typeof revision.number !== "number" ||
    !Number.isSafeInteger(revision.number) ||
    revision.number < 1 ||
    revision.immutable !== true ||
    typeof revision.sizeBytes !== "number" ||
    !Number.isSafeInteger(revision.sizeBytes) ||
    revision.sizeBytes < 0 ||
    typeof revision.fileCount !== "number" ||
    !Number.isSafeInteger(revision.fileCount) ||
    revision.fileCount < 0
  )
    throw new Error("Invalid bundle revision");
  if (revision.fileCount !== files.length)
    throw new Error("Remote bundle file count does not match its files");
  const candidate = {
    directory: "",
    title: typeof bundle.title === "string" ? bundle.title : undefined,
    description:
      typeof bundle.description === "string" ? bundle.description : undefined,
    visibility:
      typeof share.visibility === "string" ? share.visibility : undefined,
    root: bundle.root,
    files: remoteFiles.map((file) => ({
      ...file,
      bytes: Buffer.byteLength(file.content),
    })),
    totalBytes,
  } as Bundle;
  if (revision.sizeBytes < totalBytes)
    throw new Error("Stored revision bytes are smaller than source bytes");
  const errors = validateBundle(candidate);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    share: share as PullData["share"],
    revision: revision as PullData["revision"],
    bundle: { ...bundle, files: remoteFiles } as PullData["bundle"],
  };
}

async function destinationState(destination: string): Promise<void> {
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink())
      throw new Error("Destination must not be an existing symlink");
    throw new Error("Destination must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertRealAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`Symlinked parent is not allowed: ${current}`);
      if (!info.isDirectory())
        throw new Error(`Parent is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function pullBundle(
  response: unknown,
  destination: string,
  dryRun = false,
) {
  const pulled = decodePullBundle(response);
  const target = resolve(destination);
  const parent = dirname(target);
  await destinationState(target);
  await assertRealAncestors(parent);
  if (dryRun)
    return {
      share: pulled.share,
      revision: pulled.revision,
      files: pulled.bundle.files.length,
      bytes: pulled.bundle.files.reduce(
        (n, f) => n + Buffer.byteLength(f.content),
        0,
      ),
      destination: target,
    };
  await mkdir(parent, { recursive: true });
  await assertRealAncestors(parent);
  const checkedParent = await realpath(parent);
  const stage = await mkdtemp(join(parent, `.okfshare-pull-${process.pid}-`));
  let reserved = false;
  try {
    for (const file of pulled.bundle.files) {
      const output = join(stage, file.path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, file.content, "utf8");
    }
    const sourceBytes = pulled.bundle.files.reduce(
      (n, f) => n + Buffer.byteLength(f.content),
      0,
    );
    const storedBytes = pulled.revision.sizeBytes;
    await writeFile(
      join(stage, "okfshare.json"),
      JSON.stringify(
        {
          root: pulled.bundle.root,
          title: pulled.bundle.title,
          description: pulled.bundle.description,
          visibility: pulled.share.visibility,
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(stage, ".okfshare-pull.json"),
      JSON.stringify(
        {
          version: 1,
          shareId: pulled.share.id,
          slug: pulled.share.slug,
          revision: { id: pulled.revision.id, number: pulled.revision.number },
          sourceBytes,
          storedBytes,
        },
        null,
        2,
      ) + "\n",
    );
    await mkdir(target);
    reserved = true;
    if (
      (await realpath(target)) !== target ||
      (await realpath(parent)) !== checkedParent
    )
      throw new Error("Pull placement path changed while staging");
    for (const entry of await readdir(stage))
      await rename(join(stage, entry), join(target, entry));
    await rm(stage, { recursive: true, force: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (reserved) {
      const message =
        error instanceof Error ? error.message : "unknown placement error";
      throw new Error(
        `Pull failed after reserving ${target}; the partial destination was preserved. ${message}`,
      );
    }
    throw error;
  }
  const sourceBytes = pulled.bundle.files.reduce(
    (n, f) => n + Buffer.byteLength(f.content),
    0,
  );
  return {
    share: pulled.share,
    revision: pulled.revision,
    files: pulled.bundle.files.length,
    sourceBytes,
    storedBytes: pulled.revision.sizeBytes,
    destination: target,
  };
}
