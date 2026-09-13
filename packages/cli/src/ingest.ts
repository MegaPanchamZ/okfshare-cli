import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { LIMITS, type BundleLimits } from "./limits.js";
import {
  hasRealSecret,
  isSafeRelativeMarkdownPath,
  validateBundle,
  collectBundleWithOverrides,
  type Bundle,
  type BundleFile,
} from "./bundle.js";

export type IngestCategory = "readme" | "agent-rules" | "adrs" | "docs";

export interface DiscoveredFile {
  category: IngestCategory;
  sourcePath: string; // relative to repo root
  targetPath: string; // safe relative path in bundle
  type: string; // OKF concept type
  title: string;
  bytes: number;
}

export interface IngestOptions {
  output?: string;
  title?: string;
  description?: string;
  topics?: string[];
  dryRun?: boolean;
  yes?: boolean;
  /**
   * Rank discovered files by documentation value before applying the file and
   * byte caps, so a large docs tree is condensed to its high-signal pages
   * instead of the alphabetically first ones.
   */
  condense?: boolean;
  /** Capacity selected for the authenticated workspace. */
  limits?: BundleLimits;
  /** @internal deterministic failure injection for CLI tests */
  fileOps?: { rename?: typeof rename };
}

export interface IngestResult {
  operation: "ingest";
  ok: boolean;
  dryRun?: boolean;
  repoPath: string;
  outputPath: string;
  discovered: DiscoveredFile[];
  bundle: {
    path: string;
    files: number;
    bytes: number;
    digest: string;
  };
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
  warnings: string[];
  next: string[];
}

const ignoredDirNames = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".wrangler",
  ".temp",
  ".tmp",
  ".vscode",
  ".idea",
  "backups",
  "test-results",
  "evaluations",
  "scratch",
]);

const execFileAsync = promisify(execFile);

/** A repo argument is treated as a remote source when it looks like a git URL. */
export const isGitUrl = (value: string): boolean =>
  /^(https?:\/\/|git@|ssh:\/\/)/.test(value) || value.endsWith(".git");

/**
 * Shallow, blob-filtered, sparse clone limited to Markdown and conventional
 * docs directories. Keeps large documentation repos (Next.js, Kubernetes, …)
 * cheap to fetch for condensation.
 */
export async function cloneDocsRepo(url: string, dest: string): Promise<void> {
  await execFileAsync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      "--quiet",
      url,
      dest,
    ],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
  await execFileAsync(
    "git",
    [
      "-C",
      dest,
      "sparse-checkout",
      "set",
      "--no-cone",
      "/*.md",
      "/docs/**",
      "/doc/**",
      "/documentation/**",
      "/guides/**",
      "/guide/**",
      "/content/**",
      "/website/docs/**",
      "/pages/**/*.md",
    ],
    { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
}

// Path-based documentation value used to condense large docs trees. This is a
// heuristic, not a quality judgement: it favours canonical entry points and
// penalises changelogs, licences, translations, and examples.
const HIGH_VALUE_DOC =
  /(getting[_-]?started|quick[_-]?start|introduction|overview|concepts?|why-|architecture|routing|rendering|data[_-]?fetching|caching|api|configuration|config|install|deployment|deploy|security|authentication|authorization|testing|middleware|server|tutorial|guide)/i;
const LOW_VALUE_DOC =
  /(changelog|changes|release[-_]?notes?|license|licence|code[_-]?of[_-]?conduct|contributing|sponsor|support|roadmap|credits|authors|translat|i18n|\/blog\/|examples?|showcase|playground|migration|upgrade[-_]?guide)/i;

export function docValueScore(sourcePath: string): number {
  const lower = sourcePath.toLowerCase();
  const base = basename(lower);
  let score = 0;
  if (/^index\.md$/.test(base)) score += 50;
  if (HIGH_VALUE_DOC.test(lower)) score += 25;
  if (LOW_VALUE_DOC.test(lower)) score -= 60;
  score -= (lower.split("/").length - 1) * 2; // prefer shallow paths
  score -= Math.min(25, Math.floor(base.length / 8)); // prefer concise names
  return score;
}

function computeDigest(files: { path: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const hasher = createHash("sha256");
  for (const file of sorted) {
    hasher.update(file.path);
    hasher.update("\0");
    hasher.update(file.content);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

async function assertNoSymlinkInPath(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(
          `Refusing an ingest path containing a symlink: ${path}`,
        );
      if (!info.isDirectory() && current !== resolve(path))
        throw new Error(
          `Ingest destination parent is not a directory: ${path}`,
        );
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}

function extractTitle(content: string, fallback: string): string {
  const stripped = content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  const headingMatch = stripped.match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1].trim()) {
    return headingMatch[1].trim();
  }
  return fallback;
}

function sanitizeSafePath(candidate: string): string {
  let cleaned = candidate.split(sep).join("/");
  // replace leading dots in path segments (e.g. .cursor/rules -> cursor/rules)
  cleaned = cleaned.replace(/(^|\/)\.+([a-zA-Z0-9_-])/g, "$1$2");
  // ensure .md extension
  if (!cleaned.toLowerCase().endsWith(".md")) {
    cleaned = `${cleaned.replace(/\.[^/.]+$/, "")}.md`;
  }
  // replace unsafe characters
  cleaned = cleaned.replace(/[^a-zA-Z0-9/._-]/g, "-").replace(/-+/g, "-");
  return cleaned;
}

function categorizePath(
  relPath: string,
): { category: IngestCategory; type: string; priority: number } | null {
  const normalized = relPath.split(sep).join("/");
  const lower = normalized.toLowerCase();
  const base = basename(lower);

  // 1. README
  if (base === "readme.md" || base === "readme") {
    const isRoot = !normalized.includes("/");
    return { category: "readme", type: "readme", priority: isRoot ? 1 : 4 };
  }

  // 2. ADRs (Architecture Decision Records)
  if (
    /(?:^|\/)(?:adrs?|decisions?)\/[^/]+\.md$/i.test(normalized) ||
    /(?:^|\/)docs?\/(?:adrs?|decisions?|arch)\/[^/]+\.md$/i.test(normalized) ||
    /^(?:adr|decision)-[0-9]+.*\.md$/i.test(base)
  ) {
    return { category: "adrs", type: "adr", priority: 3 };
  }

  // 3. Agent rules & instructions
  if (
    base === ".cursorrules" ||
    base === "cursorrules" ||
    base === ".windsurfrules" ||
    base === "claude.md" ||
    base === "agents.md" ||
    base === "contributing.md" ||
    base === "prompt.md" ||
    base === "system_prompt.md" ||
    lower.startsWith(".cursor/rules/") ||
    lower.startsWith(".claude/") ||
    lower.startsWith(".github/copilot-instructions") ||
    lower.startsWith(".github/instructions/") ||
    lower.startsWith(".agents/") ||
    lower.startsWith(".gemini/rules/") ||
    lower.startsWith(".codex/") ||
    base.includes("agent") ||
    base.includes("rule") ||
    base.includes("copilot")
  ) {
    return { category: "agent-rules", type: "agent-rules", priority: 2 };
  }

  // 4. Docs
  if (
    lower.startsWith("docs/") ||
    lower.startsWith("doc/") ||
    lower.startsWith("documentation/") ||
    lower.startsWith("wiki/") ||
    lower.startsWith("guides/") ||
    lower.startsWith("guide/") ||
    lower.startsWith("specs/") ||
    /^(?:architecture|design|security|security_plan|development|spec|api|styleguide|product-contract|cli-contract)\.md$/i.test(
      base,
    )
  ) {
    return { category: "docs", type: "doc", priority: 4 };
  }

  // Any other Markdown/MDX file in repo
  if (
    MARKDOWN_SOURCE.test(lower) &&
    !lower.endsWith("index.md") &&
    !lower.endsWith("log.md")
  ) {
    return { category: "docs", type: "doc", priority: 5 };
  }

  return null;
}

// Source documentation can be .md, .mdx, or .markdown; targets are normalised
// to .md because the OKF bundle format only accepts Markdown paths.
const MARKDOWN_SOURCE = /\.(md|mdx|markdown)$/i;
const stripMarkdownExt = (name: string) =>
  name.replace(/\.(md|mdx|markdown)$/i, "");

function isSafeSourcePath(path: string): boolean {
  const segments = path.split("/");
  return (
    Buffer.byteLength(path, "utf8") <= LIMITS.maxPathBytes &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        Array.from(part).some((char) => {
          const code = char.charCodeAt(0);
          return code < 32 || code === 127;
        }),
    )
  );
}

interface RawDiscovered {
  category: IngestCategory;
  type: string;
  priority: number;
  sourcePath: string;
  absolutePath: string;
  size: number;
}

async function scanRepo(
  repoRoot: string,
  currentDir: string,
  outAbsolute: string,
  discovered: RawDiscovered[],
  warnings: string[],
  limits: BundleLimits,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const relativeEntry = relative(repoRoot, resolve(currentDir, entry.name))
      .split(sep)
      .join("/");
    if (ignoredDirNames.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      warnings.push(`Skipped symlink candidate: ${relativeEntry}`);
      continue; // never follow repository symlinks
    }

    const absolute = resolve(currentDir, entry.name);
    if (
      absolute === outAbsolute ||
      absolute.startsWith(`${outAbsolute}${sep}`)
    ) {
      // skip destination directory if inside repo
      continue;
    }

    if (entry.isDirectory()) {
      await scanRepo(
        repoRoot,
        absolute,
        outAbsolute,
        discovered,
        warnings,
        limits,
      );
      continue;
    }

    if (!entry.isFile()) continue;

    const relPath = relativeEntry;
    const match = categorizePath(relPath);
    if (!match) continue;
    if (!isSafeSourcePath(relPath)) {
      warnings.push(`Skipped ${relPath}: unsafe or oversized canonical path`);
      continue;
    }

    const stats = await stat(absolute);
    if (stats.size > limits.maxFileBytes) {
      warnings.push(
        `Skipped ${relPath}: exceeds the ${limits.maxFileBytes} byte file limit`,
      );
      continue;
    }

    discovered.push({
      category: match.category,
      type: match.type,
      priority: match.priority,
      sourcePath: relPath,
      absolutePath: absolute,
      size: stats.size,
    });
  }
}

export async function discoverAndDraft(
  repoDir: string,
  outputDir: string,
  options: IngestOptions = {},
): Promise<{
  discovered: DiscoveredFile[];
  files: BundleFile[];
  warnings: string[];
  title: string;
  description: string;
  topics: string[];
}> {
  const repoRoot = resolve(repoDir);
  const outAbsolute = resolve(outputDir);
  const limits = options.limits ?? LIMITS;
  let repoStat;
  try {
    repoStat = await lstat(repoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Repository path must be a real directory: ${repoDir}`);
    }
    throw error;
  }
  if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
    throw new Error(`Repository path must be a real directory: ${repoDir}`);
  }

  const rawList: RawDiscovered[] = [];
  const warnings: string[] = [];
  await scanRepo(repoRoot, repoRoot, outAbsolute, rawList, warnings, limits);

  // Sort by priority (README > Agent Rules > ADRs > Docs). When condensing,
  // rank by documentation value within each priority band, then by path.
  rawList.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (options.condense) {
      const value = docValueScore(b.sourcePath) - docValueScore(a.sourcePath);
      if (value !== 0) return value;
    }
    return a.sourcePath < b.sourcePath
      ? -1
      : a.sourcePath > b.sourcePath
        ? 1
        : 0;
  });

  const discovered: DiscoveredFile[] = [];
  const draftFiles: BundleFile[] = [];
  const usedTargetPaths = new Set<string>();

  // Reserve one slot for the generated bundle-root index.
  const maxConceptFiles = limits.maxFiles - 1;

  // Derive repo title fallback from directory name
  const repoName = basename(repoRoot) || "Project";
  let inferredTitle = options.title;
  const inferredDescription =
    options.description ??
    `Open Knowledge Format bundle ingested from ${repoName}`;

  for (const raw of rawList) {
    if (discovered.length >= maxConceptFiles) {
      warnings.push(
        `File limit of ${limits.maxFiles} reached; skipping additional files like ${raw.sourcePath}`,
      );
      break;
    }

    const content = await readFile(raw.absolutePath, "utf8");

    // Secret safety check
    if (hasRealSecret(content)) {
      warnings.push(
        `Possible secret detected in ${raw.sourcePath}; omitted from draft bundle`,
      );
      continue;
    }

    // Determine target path
    let targetRel = "";
    if (
      raw.category === "readme" &&
      (!raw.sourcePath.includes("/") ||
        raw.sourcePath.toLowerCase() === "readme.md")
    ) {
      targetRel = "readme.md";
    } else if (
      raw.category === "agent-rules" &&
      (!raw.sourcePath.includes("/") || raw.sourcePath.startsWith("."))
    ) {
      const baseClean = basename(raw.sourcePath)
        .replace(/^\.+/, "")
        .replace(/\.[^.]+$/, "");
      targetRel = `rules/${baseClean || "agent-rules"}.md`;
    } else if (raw.category === "adrs") {
      const baseClean = basename(raw.sourcePath);
      targetRel = `adrs/${baseClean}`;
    } else {
      targetRel = raw.sourcePath;
    }

    targetRel = sanitizeSafePath(targetRel);
    if (!isSafeRelativeMarkdownPath(targetRel)) {
      const cleanBase = basename(targetRel).replace(/[^a-zA-Z0-9._-]/g, "");
      targetRel = `docs/${cleanBase || "doc.md"}`;
    }

    // `index.md` and `log.md` are reserved by the OKF bundle format at every
    // depth, and only the bundle-root index may carry frontmatter. Rename
    // nested ones so their content is still ingested as ordinary concepts.
    {
      const targetDir = dirname(targetRel);
      const lowerBase = basename(targetRel).toLowerCase();
      if (targetDir !== "." && lowerBase === "index.md")
        targetRel = join(targetDir, "overview.md");
      else if (targetDir !== "." && lowerBase === "log.md")
        targetRel = join(targetDir, "history.md");
    }

    // Avoid collision
    if (
      usedTargetPaths.has(targetRel) ||
      targetRel === "index.md" ||
      targetRel === "log.md"
    ) {
      const parsedExt = targetRel.endsWith(".md") ? ".md" : "";
      const baseNoExt = targetRel.replace(/\.md$/, "");
      let counter = 1;
      while (
        usedTargetPaths.has(`${baseNoExt}-${counter}${parsedExt}`) ||
        `${baseNoExt}-${counter}${parsedExt}` === "index.md" ||
        `${baseNoExt}-${counter}${parsedExt}` === "log.md"
      ) {
        counter++;
      }
      targetRel = `${baseNoExt}-${counter}${parsedExt}`;
    }
    if (!isSafeRelativeMarkdownPath(targetRel)) {
      warnings.push(
        `Skipped ${raw.sourcePath}: generated target path is unsafe or exceeds the canonical path limit`,
      );
      continue;
    }
    usedTargetPaths.add(targetRel);

    // Extract title & format frontmatter
    let fileTitle = extractTitle(
      content,
      stripMarkdownExt(basename(raw.sourcePath)),
    );
    if (raw.category === "readme" && !inferredTitle) {
      inferredTitle = fileTitle;
    }

    // Parse existing frontmatter only to decide whether a type is needed. The
    // original YAML and body are otherwise copied without reserialization.
    const fmmatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (content.trimStart().startsWith("---") && !fmmatch) {
      warnings.push(
        `Skipped ${raw.sourcePath}: malformed YAML frontmatter (add a closing --- delimiter)`,
      );
      continue;
    }
    if (fmmatch) {
      try {
        const parsed = parseYaml(fmmatch[1]);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("frontmatter must be a mapping");
        const existing = parsed as Record<string, unknown>;
        if (
          Object.prototype.hasOwnProperty.call(existing, "type") &&
          (typeof existing.type !== "string" || !existing.type.trim())
        ) {
          warnings.push(
            `Skipped ${raw.sourcePath}: frontmatter type must be a non-empty string`,
          );
          continue;
        }
        if (typeof existing.title === "string" && existing.title.trim())
          fileTitle = existing.title.trim();
        if (typeof existing.type === "string" && existing.type.trim()) {
          draftFiles.push({
            path: targetRel,
            content,
            bytes: Buffer.byteLength(content, "utf8"),
          });
          discovered.push({
            category: raw.category,
            sourcePath: raw.sourcePath,
            targetPath: targetRel,
            type: existing.type.trim(),
            title: fileTitle,
            bytes: Buffer.byteLength(content, "utf8"),
          });
          continue;
        }
        const closingStart =
          (fmmatch.index ?? 0) + fmmatch[0].lastIndexOf("\n---");
        if (closingStart < 0) throw new Error("missing closing delimiter");
        const insertion = `${content[closingStart - 1] === "\n" ? "" : "\n"}type: ${raw.type}`;
        const formattedContent = `${content.slice(0, closingStart)}${insertion}${content.slice(closingStart)}`;
        const byteLength = Buffer.byteLength(formattedContent, "utf8");
        if (byteLength > limits.maxFileBytes) {
          warnings.push(
            `${raw.sourcePath} (${byteLength} bytes) exceeds file size limit; omitted`,
          );
          continue;
        }
        draftFiles.push({
          path: targetRel,
          content: formattedContent,
          bytes: byteLength,
        });
        discovered.push({
          category: raw.category,
          sourcePath: raw.sourcePath,
          targetPath: targetRel,
          type: raw.type,
          title: fileTitle,
          bytes: byteLength,
        });
        continue;
      } catch {
        warnings.push(
          `Skipped ${raw.sourcePath}: malformed YAML frontmatter (fix YAML before ingesting)`,
        );
        continue;
      }
    }

    const formattedContent = `---\ntype: ${raw.type}\n---\n${content}`;
    const byteLength = Buffer.byteLength(formattedContent, "utf8");

    if (byteLength > limits.maxFileBytes) {
      warnings.push(
        `${raw.sourcePath} (${byteLength} bytes) exceeds file size limit; omitted`,
      );
      continue;
    }

    draftFiles.push({
      path: targetRel,
      content: formattedContent,
      bytes: byteLength,
    });

    discovered.push({
      category: raw.category,
      sourcePath: raw.sourcePath,
      targetPath: targetRel,
      type: raw.type,
      title: fileTitle,
      bytes: byteLength,
    });
  }

  const finalTitle =
    inferredTitle || options.title || `${repoName} Knowledge Base`;

  // Trim the deterministically least-important tail until index plus files
  // fits the aggregate canonical limit. Removing entries also shrinks index.
  let indexContent = buildIndexMarkdown(
    finalTitle,
    inferredDescription,
    repoName,
    discovered,
  );
  while (
    Buffer.byteLength(indexContent, "utf8") +
      draftFiles.reduce((sum, file) => sum + file.bytes, 0) >
      limits.maxBundleBytes &&
    discovered.length > 0
  ) {
    const removed = discovered.pop()!;
    const removedIndex = draftFiles.findIndex(
      (file) => file.path === removed.targetPath,
    );
    if (removedIndex >= 0) draftFiles.splice(removedIndex, 1);
    warnings.push(
      `Skipped ${removed.sourcePath}: aggregate bundle limit would be exceeded`,
    );
    indexContent = buildIndexMarkdown(
      finalTitle,
      inferredDescription,
      repoName,
      discovered,
    );
  }
  const indexBytes = Buffer.byteLength(indexContent, "utf8");
  draftFiles.unshift({
    path: "index.md",
    content: indexContent,
    bytes: indexBytes,
  });

  // Default topics
  const topics =
    options.topics && options.topics.length > 0
      ? options.topics.map((t) => t.trim().toLowerCase())
      : ["repository", "documentation"];

  return {
    discovered,
    files: draftFiles,
    warnings,
    title: finalTitle,
    description: inferredDescription,
    topics,
  };
}

function buildIndexMarkdown(
  title: string,
  description: string,
  repoName: string,
  items: DiscoveredFile[],
): string {
  const groups: Record<IngestCategory, DiscoveredFile[]> = {
    readme: [],
    "agent-rules": [],
    adrs: [],
    docs: [],
  };

  for (const item of items) {
    groups[item.category].push(item);
  }

  const lines: string[] = [
    "---",
    'okf_version: "0.2"',
    "---",
    `# ${title}`,
    "",
    description || `Open Knowledge Format bundle ingested from ${repoName}.`,
    "",
    "## Contents",
  ];

  if (groups.readme.length > 0) {
    lines.push("", "### Overview");
    for (const item of groups.readme) {
      lines.push(`* [${item.title}](${item.targetPath})`);
    }
  }

  if (groups["agent-rules"].length > 0) {
    lines.push("", "### Agent Rules & Guidelines");
    for (const item of groups["agent-rules"]) {
      lines.push(`* [${item.title}](${item.targetPath})`);
    }
  }

  if (groups.adrs.length > 0) {
    lines.push("", "### Architecture Decisions");
    for (const item of groups.adrs) {
      lines.push(`* [${item.title}](${item.targetPath})`);
    }
  }

  if (groups.docs.length > 0) {
    lines.push("", "### Documentation");
    for (const item of groups.docs) {
      lines.push(`* [${item.title}](${item.targetPath})`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export async function ingestRepository(
  repoDir: string,
  outputDir: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  let tempClone: string | null = null;
  let sourceDir = repoDir;
  if (isGitUrl(repoDir)) {
    tempClone = await mkdtemp(join(tmpdir(), "okfshare-ingest-repo-"));
    const cloneDir = join(tempClone, "repo");
    await cloneDocsRepo(repoDir, cloneDir);
    sourceDir = cloneDir;
  }
  try {
    const repoResolved = resolve(sourceDir);
    const outResolved = resolve(outputDir);

    // Ingestion is deliberately create-only. Apart from protecting user data,
    // this also prevents an output directory that happens to be inside the
    // repository from being mistaken for source material on a later run.
    if (
      outResolved === repoResolved ||
      outResolved.startsWith(`${repoResolved}${sep}`)
    ) {
      // An output nested in the repository is useful, so only the repository
      // itself is unsafe. Nested destinations are skipped by scanRepo.
      if (outResolved === repoResolved)
        throw new Error(
          "Refusing to use the repository as the ingest destination",
        );
    }
    await assertNoSymlinkInPath(outResolved);
    try {
      const destinationStat = await lstat(outResolved);
      throw new Error(
        destinationStat.isSymbolicLink()
          ? `Refusing to use a symlink as ingest destination: ${outputDir}`
          : `Refusing to overwrite existing ingest destination: ${outputDir}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const { discovered, files, warnings, title, description, topics } =
      await discoverAndDraft(repoResolved, outResolved, options);

    if (discovered.length === 0)
      warnings.push("No relevant Markdown knowledge files were discovered");

    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
    const digest = computeDigest(files);

    const bundleObj: Bundle = {
      directory: outResolved,
      title,
      description,
      topics,
      visibility: "unlisted",
      files,
      totalBytes,
      root: "index.md",
      readme: "index.md",
    };

    const validationErrors = validateBundle(
      bundleObj,
      options.limits ?? LIMITS,
    );
    const isValid = validationErrors.length === 0;

    if (!isValid && !options.dryRun) {
      throw new Error(
        `Generated OKF draft failed validation: ${validationErrors.join("; ")}`,
      );
    }

    if (!options.dryRun) {
      await mkdir(dirname(outResolved), { recursive: true });
      const stagingDir = await mkdtemp(
        join(dirname(outResolved), ".okfshare-ingest-"),
      );
      let destinationCreated = false;
      let committed = false;
      try {
        for (const file of files) {
          const filePath = join(stagingDir, file.path);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, file.content, "utf8");
        }
        const configPayload = { title, description, root: "index.md", topics };
        await writeFile(
          join(stagingDir, "okfshare.json"),
          `${JSON.stringify(configPayload, null, 2)}\n`,
          "utf8",
        );
        const collected = await collectBundleWithOverrides(stagingDir);
        const collectedErrors = validateBundle(collected);
        if (collectedErrors.length > 0)
          throw new Error(
            `On-disk OKF draft failed validation: ${collectedErrors.join("; ")}`,
          );
        // Reserve the final path with mkdir (which never replaces an existing
        // directory), then move only staged files into our owned directory.
        // This makes cleanup safe even if a file move fails.
        try {
          await mkdir(outResolved);
          destinationCreated = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new Error(
              `Refusing to overwrite existing ingest destination: ${outputDir}`,
            );
          throw error;
        }
        const move = options.fileOps?.rename ?? rename;
        for (const file of [
          ...files.map((file) => file.path),
          "okfshare.json",
        ]) {
          const destinationFile = join(outResolved, file);
          await mkdir(dirname(destinationFile), { recursive: true });
          await move(join(stagingDir, file), destinationFile);
        }
        committed = true;
      } finally {
        if (!committed && destinationCreated)
          await rm(outResolved, { recursive: true, force: true });
        // This path is always ours; never clean an existing user destination.
        await rm(stagingDir, { recursive: true, force: true });
      }
    }

    const next = [
      `npx okfshare@latest publish ${outputDir} --yes`,
      `npx okfshare@latest bind <SHARE_ID> ${outputDir}`,
      `npx okfshare@latest context <SHARE_ID> "How does this project work?"`,
      `npx okfshare@latest search <SHARE_ID> "architecture"`,
    ];

    return {
      operation: "ingest",
      ok: isValid,
      dryRun: options.dryRun,
      repoPath: repoDir,
      outputPath: outputDir,
      discovered,
      bundle: {
        path: outputDir,
        files: files.length,
        bytes: totalBytes,
        digest,
      },
      validation: {
        valid: isValid,
        errors: validationErrors,
        warnings: [],
      },
      warnings,
      next,
    };
  } finally {
    if (tempClone) await rm(tempClone, { recursive: true, force: true });
  }
}
