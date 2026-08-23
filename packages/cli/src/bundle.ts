import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { LIMITS } from "./limits.js";
import { readConfig, type OkfConfig } from "./config.js";
import { parse as parseYaml } from "yaml";

export type BundleFile = { path: string; content: string; bytes: number };
export type Bundle = {
  directory: string;
  title?: string;
  description?: string;
  topics?: string[];
  visibility?: string;
  password?: string;
  files: BundleFile[];
  totalBytes: number;
  root?: string;
  readme?: string;
};
export type BundleOverrides = Partial<
  Pick<
    Bundle,
    "title" | "description" | "topics" | "root" | "visibility" | "password"
  >
>;
const ignored = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".agents",
  ".opencode",
  ".claude",
  ".codex",
  ".copilot",
  ".gemini",
]);

function matches(path: string, patterns: string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => {
    let expression = "";
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern[index];
      if (character === "*" && pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          expression += "(?:.*/)?";
          index++;
        } else expression += ".*";
      } else if (character === "*") expression += "[^/]*";
      else if (character === "?") expression += "[^/]";
      else
        expression += /[.+^${}()|[\]\\]/.test(character)
          ? `\\${character}`
          : character;
    }
    const re = new RegExp(`^${expression}$`);
    return re.test(path);
  });
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
  return (
    normalized.includes("...") ||
    normalized.includes("…") ||
    /^(?:changeme|change-me|replace[-_ ]?me|redacted|null|undefined|none|example|sample|test|dummy|your[-_ ]?[^ ]+)$/.test(
      normalized,
    ) ||
    /^<[^>]*>$/.test(normalized) ||
    /^[*xX._-]+$/.test(normalized) ||
    /^\$\{[^}]+\}$/.test(normalized)
  );
}

function hasRealSecret(content: string): boolean {
  if (/-----BEGIN .*PRIVATE KEY-----/i.test(content)) return true;
  if (/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(content)) return true;
  if (
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@]+:[^\s/@]+@/i.test(
      content,
    )
  )
    return true;
  if (
    /(?:AKIA|ASIA)[0-9A-Z]{16}/.test(content) ||
    /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/.test(content) ||
    /AIza[0-9A-Za-z_-]{20,}/.test(content) ||
    /xox[baprs]-[0-9A-Za-z-]{12,}/.test(content) ||
    /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/.test(content)
  )
    return true;
  const sensitiveKey =
    /(?:^|["']?)(?:token|access[_-]?token|api[_-]?token|api[_-]?key|secret|client[_-]?secret|private[_-]?key|password|passwd|authorization|credential|aws_access_key_id|aws_secret_access_key|github_token|gcp[_-]?key)(?:["']?)\s*[:=]\s*(?:["']?)([^\s,"'}]+)(?:["']?)/gim;
  for (const match of content.matchAll(sensitiveKey))
    if (match[1].length >= 8 && !isPlaceholderSecret(match[1])) return true;
  return false;
}

async function walk(
  root: string,
  current: string,
  config: OkfConfig,
  output: BundleFile[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not allowed: ${entry.name}`);
    if (ignored.has(entry.name)) continue;
    const absolute = resolve(current, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (path === ".github/skills" || path.startsWith(".github/skills/"))
      continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, config, output);
      continue;
    }
    if (
      !entry.isFile() ||
      !path.toLowerCase().endsWith(".md") ||
      matches(path, config.exclude) ||
      (config.include && !matches(path, config.include))
    )
      continue;
    if (
      /^(credentials?|secrets?|private[-_ ]key|id_rsa)\.md$/i.test(entry.name)
    )
      throw new Error(`Private or secret file is not allowed: ${path}`);
    if (
      path.includes("..") ||
      path.startsWith("/") ||
      Buffer.byteLength(path) > LIMITS.maxPathBytes
    )
      throw new Error(`Unsafe Markdown path: ${path}`);
    const bytes = (await stat(absolute)).size;
    if (bytes > LIMITS.maxFileBytes)
      throw new Error(
        `${path} exceeds the ${LIMITS.maxFileBytes} byte file limit`,
      );
    const content = await readFile(absolute, "utf8");
    if (hasRealSecret(content))
      throw new Error(`Possible secret detected in: ${path}`);
    output.push({ path, content, bytes });
    if (output.length > LIMITS.maxFiles)
      throw new Error(`Bundle exceeds the ${LIMITS.maxFiles} file limit`);
  }
}

export function isSafeRelativeMarkdownPath(path: string): boolean {
  const segments = path.split("/");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  return (
    path.length <= 240 &&
    Buffer.byteLength(path, "utf8") <= LIMITS.maxPathBytes &&
    segments.every(
      (segment) => Buffer.byteLength(segment, "utf8") <= LIMITS.maxPathBytes,
    ) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("%") &&
    !segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        reserved.test(part) ||
        /[<>:"|?*]/.test(part) ||
        /[. ]$/.test(part),
    ) &&
    !/%2f|%5c|%2e/i.test(path) &&
    !Array.from(path).some(
      (c) =>
        c === "?" ||
        c === "#" ||
        c.charCodeAt(0) < 32 ||
        c.charCodeAt(0) === 127,
    )
  );
}

const safePath = isSafeRelativeMarkdownPath;

function validateMarkdown(files: BundleFile[], root: string): string[] {
  const errors: string[] = [];
  const paths = new Set(files.map((file) => file.path));
  const directories = files.map((file) => file.path.split("/").slice(0, -1));
  const common: string[] = [];
  const shortest = Math.min(...directories.map((parts) => parts.length));
  for (
    let i = 0;
    i < shortest &&
    directories.every((parts) => parts[i] === directories[0][i]);
    i++
  )
    common.push(directories[0][i]);
  const rootIndex = [...common, "index.md"].join("/");
  for (const file of files) {
    if (!safePath(file.path) || !file.path.endsWith(".md"))
      errors.push(`Unsafe Markdown path: ${file.path}`);
    let document: Record<string, unknown> = {};
    let hasFrontmatter = false;
    const match = file.content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (match) {
      hasFrontmatter = true;
      try {
        const value = parseYaml(match[1]);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        document = value as Record<string, unknown>;
      } catch {
        errors.push(`Invalid YAML frontmatter in ${file.path}`);
      }
    }
    const base = basename(file.path);
    if (
      base === "index.md" &&
      hasFrontmatter &&
      (file.path !== rootIndex ||
        Object.keys(document).length !== 1 ||
        typeof document.okf_version !== "string" ||
        !document.okf_version.trim())
    )
      errors.push(
        "Only the bundle-root index.md may have frontmatter, containing only a string okf_version",
      );
    else if (
      base !== "index.md" &&
      base !== "log.md" &&
      (!hasFrontmatter ||
        typeof document.type !== "string" ||
        !document.type.trim())
    )
      errors.push(
        `Every non-reserved markdown file needs a non-empty YAML type: ${file.path}`,
      );
    if (base === "log.md" && hasFrontmatter)
      errors.push(
        `Reserved log.md files must not have frontmatter: ${file.path}`,
      );
    if (base === "log.md") {
      const invalidHeading = file.content
        .split("\n")
        .find(
          (line) =>
            /^##\s+/.test(line.trim()) &&
            !/^##\s+\d{4}-\d{2}-\d{2}\s*$/.test(line.trim()),
        );
      if (invalidHeading)
        errors.push(
          `log.md date headings must use ## YYYY-MM-DD: ${file.path}`,
        );
    }
  }
  if (!safePath(root) || !root.endsWith(".md") || !paths.has(root))
    errors.push("Root must be an existing safe markdown path");
  return errors;
}

export function validateBundle(bundle: Bundle): string[] {
  const errors = bundle.files.flatMap((file) =>
    file.bytes > LIMITS.maxFileBytes
      ? [`${file.path} exceeds the ${LIMITS.maxFileBytes} byte file limit`]
      : [],
  );
  if (bundle.files.length > LIMITS.maxFiles)
    errors.push(`Bundle exceeds the ${LIMITS.maxFiles} file limit`);
  if (bundle.totalBytes > LIMITS.maxBundleBytes)
    errors.push(`Bundle exceeds the ${LIMITS.maxBundleBytes} byte limit`);
  if (!bundle.root)
    errors.push("A bundle-root README.md or index.md is required");
  else errors.push(...validateMarkdown(bundle.files, bundle.root));
  if (
    bundle.visibility === "password" &&
    (!bundle.password || bundle.password.length < 8)
  )
    errors.push(
      "Password visibility requires a password of at least 8 characters",
    );
  if (bundle.visibility !== "password" && bundle.password)
    errors.push("Password is only valid for password visibility");
  if (!bundle.title?.trim() || bundle.title.length > 200)
    errors.push("Title must be between 1 and 200 characters");
  if (bundle.description && bundle.description.length > 2000)
    errors.push("Description must be at most 2000 characters");
  for (const topic of bundle.topics ?? [])
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(topic))
      errors.push(
        `Topic "${topic}" must be lowercase alphanumeric with dashes (2-32 chars)`,
      );
  if ((bundle.topics?.length ?? 0) > 8)
    errors.push("At most 8 topics are allowed");
  return errors;
}

export async function collectBundle(directory: string): Promise<Bundle> {
  return collectBundleWithOverrides(directory);
}

export async function collectBundleWithOverrides(
  directory: string,
  overrides: BundleOverrides = {},
): Promise<Bundle> {
  const base = resolve(directory);
  const baseStat = await lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink())
    throw new Error("Publishing directory must be a real directory");
  const config = await readConfig(base);
  const effectiveRoot = overrides.root ?? config.root;
  if (effectiveRoot !== undefined) {
    if (
      !safePath(effectiveRoot) ||
      !effectiveRoot.toLowerCase().endsWith(".md")
    )
      throw new Error("Configured root must be a safe relative Markdown path");
    const rootFile = resolve(base, effectiveRoot);
    const rootRelative = relative(base, rootFile);
    if (
      rootRelative === ".." ||
      rootRelative.startsWith(`..${sep}`) ||
      rootRelative.startsWith(sep)
    )
      throw new Error(
        "Configured root must stay inside the publishing directory",
      );
    let rootStat;
    try {
      rootStat = await lstat(rootFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`Configured root does not exist: ${effectiveRoot}`);
      throw error;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isFile())
      throw new Error(
        `Configured root is not a Markdown file: ${effectiveRoot}`,
      );
  }
  const files: BundleFile[] = [];
  await walk(base, base, config, files);
  if (!files.length) throw new Error("No Markdown files found");
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > LIMITS.maxBundleBytes)
    throw new Error(`Bundle exceeds the ${LIMITS.maxBundleBytes} byte limit`);
  const root = effectiveRoot
    ? files.find((file) => file.path === effectiveRoot)?.path
    : files.find(
        (file) => file.path === "README.md" || file.path === "index.md",
      )?.path;
  if (effectiveRoot && !root)
    throw new Error(`Configured root is not included: ${effectiveRoot}`);
  const rootFile = root ? files.find((file) => file.path === root) : undefined;
  const inferredTitle =
    config.title ??
    (rootFile?.content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1]
      ? (() => {
          try {
            const frontmatter = parseYaml(
              rootFile.content.match(
                /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/,
              )?.[1] ?? "",
            ) as Record<string, unknown>;
            return typeof frontmatter.title === "string" &&
              frontmatter.title.trim()
              ? frontmatter.title.trim()
              : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined) ??
    rootFile?.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    root?.replace(/\.md$/i, "").split("/").pop() ??
    "OKF bundle";
  return {
    directory: base,
    title: overrides.title ?? inferredTitle,
    description: overrides.description ?? config.description,
    topics: (overrides.topics ?? config.topics)?.map((t) =>
      t.trim().toLowerCase(),
    ),
    password: overrides.password ?? config.password,
    visibility: overrides.visibility ?? config.visibility ?? "unlisted",
    files,
    totalBytes,
    root,
    readme: root,
  };
}

export async function scaffoldBundle(
  directory: string,
  options: { title?: string; description?: string } = {},
): Promise<string[]> {
  const target = resolve(directory);
  let existing: string[] = [];
  try {
    existing = await readdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing.length)
    throw new Error(
      `Refusing to init into a non-empty directory: ${directory}`,
    );
  const title = options.title?.trim() || "My knowledge bundle";
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "concept";
  const today = new Date().toISOString().slice(0, 10);
  const files: Array<[string, string]> = [
    [
      "index.md",
      `---\nokf_version: "0.2"\n---\n# ${title}\n\n* [${slug}](${slug}.md)\n`,
    ],
    [
      `${slug}.md`,
      `---\ntype: concept\ntitle: ${title}\nstatus: draft\nverified: { by: human:you, at: ${today}T00:00:00Z }\nsources:\n  - { id: notes, resource: https://example.com/source, title: Source notes }\n---\n\n# ${slug}\n\nWrite the first concept here.\n`,
    ],
    [
      "log.md",
      `# Log\n\n## ${today}\n\n- created bundle with npx okfshare@latest init\n`,
    ],
    [
      "okfshare.json",
      `${JSON.stringify({ title, ...(options.description ? { description: options.description } : {}), root: `${slug}.md` }, null, 2)}\n`,
    ],
  ];
  await mkdir(target, { recursive: true });
  for (const [path, content] of files)
    await writeFile(join(target, path), content, "utf8");
  return files.map(([path]) => path);
}
