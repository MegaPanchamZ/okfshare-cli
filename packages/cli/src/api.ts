import { isSafeRelativeMarkdownPath } from "./bundle.js";

export type ApiOptions = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
};
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export class ApiClient {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly userAgent: string;
  constructor(options: ApiOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.OKFSHARE_API_URL ??
      "https://okfshare.app"
    ).replace(/\/$/, "");
    this.request = options.fetch ?? fetch;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;
    this.userAgent = options.userAgent ?? "okfshare-cli";
  }
  private token?: string;
  setToken(token: string | undefined) {
    this.token = token;
  }
  async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    headers.set("user-agent", this.userAgent);
    let response: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.request(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          signal: init.signal ?? controller.signal,
        });
        clearTimeout(timer);
        if (
          !(response.status === 429 || response.status >= 500) ||
          attempt === this.retries
        )
          break;
        const retryAfter = Number(response.headers.get("retry-after"));
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Number.isFinite(retryAfter)
              ? retryAfter * 1000
              : 100 * 2 ** attempt,
          ),
        );
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (attempt === this.retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    if (!response) throw lastError ?? new Error("Request failed");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
      throw new ApiError(
        response.status,
        "Response body exceeds the CLI limit",
      );
    let text: string;
    if (!response.body) {
      text = "";
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ApiError(
              response.status,
              "Response body exceeds the CLI limit",
            );
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      text = new TextDecoder().decode(Buffer.concat(chunks));
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const errorBody =
        typeof body === "object" && body && "error" in body
          ? (body as { error: { message?: unknown } }).error
          : body;
      const message =
        typeof errorBody === "object" && errorBody && "message" in errorBody
          ? String(errorBody.message)
          : `Request failed (${response.status})`;
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ApiError(
        response.status,
        message,
        body,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }
    return body as T;
  }
  pairingStart() {
    return this.call<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresIn?: number;
      interval?: number;
    }>("/api/cli/auth/start", {
      method: "POST",
      body: JSON.stringify({
        machineLabel: "okfshare CLI",
        scopes: ["workspace:read", "workspace:write"],
      }),
    });
  }
  pairingStatus(deviceCode: string) {
    return this.call<{
      status: "pending" | "approved";
      interval?: number;
      expiresAt?: number;
    }>("/api/cli/auth/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    });
  }
  pairingExchange(deviceCode: string) {
    return this.call<unknown>("/api/cli/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    }).then(decodePairingExchangeResponse);
  }
  whoami() {
    return this.call<unknown>("/api/workspace").then(decodeWhoamiResponse);
  }
  health() {
    return this.call<{ ok: boolean; db?: string }>("/health");
  }
  publish(payload: unknown, idempotencyKey: string) {
    return this.call<Record<string, unknown>>("/api/v1/shares", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
  }
  async list(topic?: string) {
    const data: unknown[] = [];
    let cursor: string | undefined;
    const params = new URLSearchParams();
    if (topic) params.set("topic", topic);
    do {
      const suffix = params.toString();
      const page = await this.call<{
        data: unknown[];
        nextCursor?: string | null;
      }>(
        "/api/shares" +
          (suffix ? `?${suffix}` : "") +
          (cursor
            ? `${suffix ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`
            : ""),
      );
      data.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { data, nextCursor: null };
  }
  open(id: string) {
    return this.call<Record<string, unknown>>(
      `/api/shares/${encodeURIComponent(id)}`,
    );
  }
  update(id: string, payload: unknown, key: string, expectedRevision?: string) {
    const headers: Record<string, string> = { "idempotency-key": key };
    if (expectedRevision) headers["if-match"] = expectedRevision;
    return this.call<Record<string, unknown>>(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
  }
  patch(
    id: string,
    payload: unknown,
    key: string,
    baseRevision: string | number,
  ) {
    return this.call<Record<string, unknown>>(
      `/api/v1/shares/${encodeURIComponent(id)}/patches`,
      {
        method: "POST",
        headers: { "idempotency-key": key },
        body: JSON.stringify({
          ...(payload as Record<string, unknown>),
          mode: "patch",
          baseRevision,
        }),
      },
    );
  }
  propose(shareId: string, payload: unknown) {
    return this.call<Record<string, unknown>>(
      `/api/v1/shares/${encodeURIComponent(shareId)}/proposals`,
      { method: "POST", headers: {}, body: JSON.stringify(payload) },
    );
  }
  proposals(shareId: string) {
    return this.call<{ data: unknown[] }>(
      `/api/v1/shares/${encodeURIComponent(shareId)}/proposals`,
    );
  }
  mergeProposal(proposalId: string) {
    return this.call<Record<string, unknown>>(
      `/api/v1/proposals/${encodeURIComponent(proposalId)}/merge`,
      { method: "POST", headers: {}, body: "{}" },
    );
  }
  rejectProposal(proposalId: string) {
    return this.call<Record<string, unknown>>(
      `/api/v1/proposals/${encodeURIComponent(proposalId)}/reject`,
      { method: "POST", headers: {}, body: "{}" },
    );
  }
  fork(id: string) {
    return this.call<Record<string, unknown>>(
      `/api/v1/shares/${encodeURIComponent(id)}/fork`,
      {
        method: "POST",
        headers: {},
        body: "{}",
      },
    );
  }
  explore(topic?: string, limit?: number) {
    const params = new URLSearchParams();
    if (topic) params.set("topic", topic);
    if (limit) params.set("limit", String(limit));
    const suffix = params.toString();
    return this.call<{ data: unknown[] }>(
      "/api/v1/explore" + (suffix ? `?${suffix}` : ""),
    );
  }
  revisions(id: string) {
    return this.call<{ data: unknown[] }>(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions`,
    );
  }
  diff(id: string, from: string | number, to: string | number) {
    return this.call<unknown>(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(from))}/diff/${encodeURIComponent(String(to))}`,
    ).then(decodeDiffResponse);
  }
  bundle(id: string, revision: string | number = "current") {
    return this.call<unknown>(
      `/api/v1/shares/${encodeURIComponent(id)}/bundle?revision=${encodeURIComponent(String(revision))}`,
    ).then(decodeBundleResponse);
  }
  search(
    id: string,
    query: string,
    revision: string | number = "current",
    limit?: number,
    mode?: string,
  ) {
    const params = new URLSearchParams({
      q: query,
      revision: String(revision),
    });
    if (limit !== undefined) params.set("limit", String(limit));
    if (mode !== undefined) params.set("mode", mode);
    return this.call<unknown>(
      `/api/v1/shares/${encodeURIComponent(id)}/search?${params}`,
    ).then(decodeSearchResponse);
  }
  context(
    id: string,
    query: string,
    revision: string | number = "current",
    budget?: number,
  ) {
    const params = new URLSearchParams({
      q: query,
      revision: String(revision),
    });
    if (budget !== undefined) params.set("budget", String(budget));
    return this.call<unknown>(
      `/api/v1/shares/${encodeURIComponent(id)}/context?${params}`,
    ).then(decodeContextResponse);
  }
  rollback(
    id: string,
    revision: string,
    key: string,
    expectedRevision?: string,
  ) {
    const headers: Record<string, string> = { "idempotency-key": key };
    if (expectedRevision) headers["if-match"] = expectedRevision;
    return this.call<Record<string, unknown>>(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/rollback`,
      { method: "POST", headers },
    );
  }
}

export function decodePairingExchangeResponse(value: unknown): {
  credential: string;
  expiresAt?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pairing exchange did not return a valid credential");
  const response = value as Record<string, unknown>;
  const data =
    "credential" in response
      ? response
      : response.data &&
          typeof response.data === "object" &&
          !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : (() => {
            throw new Error(
              "Pairing exchange did not return a valid credential",
            );
          })();
  const credential = data.credential;
  if (
    typeof credential !== "string" ||
    !credential.trim() ||
    credential !== credential.trim() ||
    !/^okf_cli_[0-9a-f]{32,}$/i.test(credential)
  )
    throw new Error("Pairing exchange did not return a valid credential");
  const expiresAt = data.expiresAt;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= 0)
  )
    throw new Error("Pairing exchange returned an invalid expiry");
  return { credential, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

export type WhoamiResponse = {
  workspace: Record<string, unknown> & { id: string };
  user?: unknown;
  [key: string]: unknown;
};

export function decodeWhoamiResponse(value: unknown): WhoamiResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Authentication verification returned an invalid identity");
  const response = value as Record<string, unknown>;
  if (
    !response.workspace ||
    typeof response.workspace !== "object" ||
    Array.isArray(response.workspace) ||
    typeof (response.workspace as Record<string, unknown>).id !== "string" ||
    !(response.workspace as Record<string, unknown>).id
  )
    throw new Error("Authentication verification returned an invalid identity");
  return response as WhoamiResponse;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
function stringField(
  value: Record<string, unknown>,
  key: string,
  name: string,
): string {
  if (typeof value[key] !== "string") throw new Error(`Invalid ${name}.${key}`);
  return value[key] as string;
}
function numberField(
  value: Record<string, unknown>,
  key: string,
  name: string,
): number {
  if (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    throw new Error(`Invalid ${name}.${key}`);
  return value[key] as number;
}
function safeIntegerField(
  value: Record<string, unknown>,
  key: string,
  name: string,
  minimum: number,
): number {
  const result = numberField(value, key, name);
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new Error(`Invalid ${name}.${key}`);
  return result;
}
function booleanField(
  value: Record<string, unknown>,
  key: string,
  name: string,
): boolean {
  if (typeof value[key] !== "boolean")
    throw new Error(`Invalid ${name}.${key}`);
  return value[key] as boolean;
}
function arrayField(
  value: Record<string, unknown>,
  key: string,
  name: string,
): unknown[] {
  if (!Array.isArray(value[key])) throw new Error(`Invalid ${name}.${key}`);
  return value[key] as unknown[];
}
function pathField(
  value: Record<string, unknown>,
  key: string,
  name: string,
): string {
  const path = stringField(value, key, name);
  if (!isSafeRelativeMarkdownPath(path) || !path.toLowerCase().endsWith(".md"))
    throw new Error(`Invalid ${name}.${key}`);
  return path;
}
function share(value: unknown, full: boolean): Record<string, unknown> {
  const result = object(value, "share");
  stringField(result, "id", "share");
  stringField(result, "slug", "share");
  if (full) {
    for (const key of ["title", "description", "visibility", "status"])
      stringField(result, key, "share");
  }
  return result;
}
function revision(value: unknown, full: boolean): Record<string, unknown> {
  const result = object(value, "revision");
  stringField(result, "id", "revision");
  safeIntegerField(result, "number", "revision", 1);
  if (full) {
    if (result.immutable !== true)
      throw new Error("Invalid revision.immutable");
    safeIntegerField(result, "sizeBytes", "revision", 0);
    safeIntegerField(result, "fileCount", "revision", 0);
    stringField(result, "createdAt", "revision");
  }
  return result;
}
export function decodeBundleResponse(value: unknown) {
  const data = object(object(value, "response").data, "data");
  share(data.share, true);
  revision(data.revision, true);
  const bundle = object(data.bundle, "bundle");
  for (const key of ["title", "description"])
    stringField(bundle, key, "bundle");
  pathField(bundle, "root", "bundle");
  if (!(typeof bundle.okfVersion === "string" || bundle.okfVersion === null))
    throw new Error("Invalid bundle.okfVersion");
  arrayField(bundle, "files", "bundle");
  const paths = new Set<string>();
  for (const file of bundle.files as unknown[]) {
    const f = object(file, "file");
    const path = pathField(f, "path", "file");
    if (paths.has(path)) throw new Error(`Duplicate file path: ${path}`);
    paths.add(path);
    stringField(f, "content", "file");
  }
  for (const key of ["concepts", "reserved", "types", "trustSummary", "graph"])
    if (!(key in bundle)) throw new Error(`Invalid bundle.${key}`);
  return {
    data: { ...data, share: data.share, revision: data.revision, bundle },
  };
}
export function decodeSearchResponse(value: unknown) {
  const data = object(object(value, "response").data, "data");
  share(data.share, false);
  revision(data.revision, false);
  stringField(data, "query", "data");
  numberField(data, "total", "data");
  for (const item of arrayField(data, "results", "data")) {
    const r = object(item, "result");
    pathField(r, "path", "result");
    numberField(r, "startLine", "result");
    numberField(r, "endLine", "result");
    stringField(r, "snippet", "result");
    numberField(r, "score", "result");
    numberField(r, "matchCount", "result");
  }
  return { data };
}
export function decodeContextResponse(value: unknown) {
  const data = object(object(value, "response").data, "data");
  share(data.share, false);
  revision(data.revision, false);
  stringField(data, "query", "data");
  numberField(data, "budget", "data");
  stringField(data, "estimate", "data");
  numberField(data, "usedTokens", "data");
  booleanField(data, "truncated", "data");
  for (const item of arrayField(data, "chunks", "data")) {
    const c = object(item, "chunk");
    pathField(c, "path", "chunk");
    numberField(c, "startLine", "chunk");
    numberField(c, "endLine", "chunk");
    stringField(c, "content", "chunk");
    numberField(c, "estimatedTokens", "chunk");
    numberField(c, "score", "chunk");
  }
  return { data };
}

export function decodeDiffResponse(value: unknown) {
  const response = object(value, "response");
  if (response.contractVersion !== 1)
    throw new Error("Unsupported diff contract version");
  const data = object(response.data, "data");
  const shareValue = object(data.share, "share");
  stringField(shareValue, "id", "share");
  stringField(shareValue, "slug", "share");
  for (const key of ["from", "to"] as const) {
    const revisionValue = object(data[key], key);
    stringField(revisionValue, "id", key);
    safeIntegerField(revisionValue, "number", key, 1);
    stringField(revisionValue, "contentDigest", key);
  }
  const files = object(data.files, "files");
  for (const key of ["added", "removed", "changed"]) {
    for (const path of arrayField(files, key, "files"))
      if (
        typeof path !== "string" ||
        !isSafeRelativeMarkdownPath(path) ||
        !path.endsWith(".md")
      )
        throw new Error(`Invalid files.${key}`);
  }
  return { data };
}
