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
export type ApiRecord = Record<string, unknown>;
export type ForkStatus = {
  shareId: string;
  upstreamShareId: string;
  pinnedRevision: number | null;
  baseRevision: number;
  upstreamRevision: number;
  localRevision: number;
  aheadBy: number;
  behindBy: number;
  ahead: boolean;
  behind: boolean;
  diverged: boolean;
  status: string;
  currentStatus: string;
  lastAttemptAt: number | null;
  syncedAt: number | null;
  conflictSummary: unknown;
};
export type Query = Record<
  string,
  string | number | boolean | string[] | undefined | null
>;
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
  private query(params: Query = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== null)
        search.set(key, Array.isArray(value) ? value.join(",") : String(value));
    return search.toString();
  }
  private platform<T = ApiRecord>(
    path: string,
    method = "GET",
    body?: unknown,
    query?: Query,
  ) {
    const suffix = this.query(query);
    return this.call<T>(path + (suffix ? `?${suffix}` : ""), {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  graphSnapshot(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/graph`,
      "GET",
      undefined,
      query,
    );
  }
  graphNeighbors(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/graph/neighbors`,
      "GET",
      undefined,
      query,
    );
  }
  graphPath(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/graph/shortest-path`,
      "GET",
      undefined,
      query,
    );
  }
  graphDiff(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/graph/diff`,
      "GET",
      undefined,
      query,
    );
  }
  graphProvenance(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/graph/provenance`,
      "GET",
      undefined,
      query,
    );
  }
  graphRelated(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/graph/related`,
      "GET",
      undefined,
      query,
    );
  }
  /** The Worker exposes fork creation and synchronization as separate POSTs. */
  forkCreate(id: string, payload: unknown = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/fork`,
      "POST",
      payload,
    );
  }
  forkSync(id: string) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/sync`,
      "POST",
      {},
    );
  }
  forkStatus(id: string) {
    return this.platform<{ data: ForkStatus }>(
      `/api/v1/shares/${encodeURIComponent(id)}/fork/status`,
    );
  }
  workspaceCapabilities(workspaceId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities`,
    );
  }
  shareCapabilities(id: string) {
    return this.platform(`/api/shares/${encodeURIComponent(id)}/capabilities`);
  }
  workspaceSearch(query: string, params: Query = {}) {
    return this.platform("/api/v1/workspace/search", "GET", undefined, {
      q: query,
      ...params,
    });
  }
  source(
    id: string,
    revision: string | number,
    path: string,
    query: Query = {},
  ) {
    const safePath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return this.call<string>(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(revision))}/source/${safePath}${this.query(query) ? `?${this.query(query)}` : ""}`,
      { method: "GET" },
    );
  }
  stars(id?: string, method = "GET") {
    return this.platform(
      id ? `/api/v1/shares/${encodeURIComponent(id)}/star` : "/api/v1/me/stars",
      method,
    );
  }
  redact(id: string, reason: string, idempotencyKey: string, dryRun = false) {
    return this.call<Record<string, unknown>>(
      `/api/v1/shares/${encodeURIComponent(id)}/redact${dryRun ? "?dryRun=1" : ""}`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify({ reason }),
      },
    );
  }
  workspaceGraphSearch(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/workspaces/${encodeURIComponent(id)}/graph/search`,
      "GET",
      undefined,
      query,
    );
  }
  blame(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/blame`,
      "GET",
      undefined,
      query,
    );
  }
  semanticBlame(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/blame/semantic`,
      "GET",
      undefined,
      query,
    );
  }
  revisionIntegrity(id: string, revision?: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions${revision ? `/${encodeURIComponent(revision)}` : ""}/integrity`,
      "GET",
      undefined,
      query,
    );
  }
  attestSubmit(id: string, revision: string, payload: unknown) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/attestations`,
      "POST",
      payload,
    );
  }
  attestList(id: string, revision: string) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/attestations`,
    );
  }
  attestVerify(id: string, revision: string, attestationId?: string) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/attestations${attestationId ? `/${encodeURIComponent(attestationId)}/verify` : "/verify"}`,
      "POST",
      {},
    );
  }
  refs(id: string) {
    return this.platform(`/api/v1/shares/${encodeURIComponent(id)}/refs`);
  }
  ref(id: string, label: string, resolve = false) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/refs/${encodeURIComponent(label)}`,
      "GET",
      undefined,
      resolve ? { resolve: 1 } : {},
    );
  }
  resolveRef(id: string, spec = "current") {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/refs/resolve`,
      "GET",
      undefined,
      { spec },
    );
  }
  createRef(id: string, payload: unknown) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/refs`,
      "POST",
      payload,
    );
  }
  moveRef(id: string, label: string, payload: unknown) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/refs/${encodeURIComponent(label)}`,
      "PUT",
      payload,
    );
  }
  deleteRef(id: string, label: string, expectedRevisionId?: string) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/refs/${encodeURIComponent(label)}`,
      "DELETE",
      undefined,
      expectedRevisionId === undefined ? {} : { expectedRevisionId },
    );
  }
  proposalDetail(id: string) {
    return this.platform(`/api/v1/proposals/${encodeURIComponent(id)}`);
  }
  proposalAction(id: string, action: "reopen" | "merge" | "reject") {
    return this.platform(
      `/api/v1/proposals/${encodeURIComponent(id)}/${action}`,
      "POST",
      {},
    );
  }
  proposalReviewer(id: string, payload: unknown, remove = false) {
    return this.platform(
      `/api/v1/proposals/${encodeURIComponent(id)}/reviewers`,
      remove ? "DELETE" : "POST",
      payload,
    );
  }
  proposalReview(id: string, payload: unknown) {
    return this.platform(
      `/api/v1/proposals/${encodeURIComponent(id)}/reviews`,
      "POST",
      payload,
    );
  }
  proposalComment(id: string, payload: unknown) {
    return this.platform(
      `/api/v1/proposals/${encodeURIComponent(id)}/comments`,
      "POST",
      payload,
    );
  }
  proposalCheck(id: string, payload: unknown) {
    return this.platform(
      `/api/v1/proposals/${encodeURIComponent(id)}/checks`,
      "POST",
      payload,
    );
  }
  annotations(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/annotations`,
      "GET",
      undefined,
      query,
    );
  }
  annotationCreate(id: string, payload: unknown) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/annotations`,
      "POST",
      payload,
    );
  }
  annotationResolve(id: string) {
    return this.platform(
      `/api/v1/annotations/${encodeURIComponent(id)}/resolve`,
      "POST",
      {},
    );
  }
  shareRoles(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/roles`,
      "GET",
      undefined,
      query,
    );
  }
  shareRoleMutation(
    id: string,
    method: string,
    payload?: unknown,
    query: Query = {},
  ) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/roles`,
      method,
      payload,
      query,
    );
  }
  shareGrants(id: string, query: Query = {}) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/grants`,
      "GET",
      undefined,
      query,
    );
  }
  shareGrantCreate(id: string, payload: unknown) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/grants`,
      "POST",
      payload,
    );
  }
  shareGrantDelete(id: string, grantId: string) {
    return this.platform(
      `/api/v1/shares/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`,
      "DELETE",
    );
  }
  roles(workspaceId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/roles`,
    );
  }
  role(workspaceId: string, roleId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/roles/${encodeURIComponent(roleId)}`,
    );
  }
  roleMutation(
    workspaceId: string,
    roleId: string | undefined,
    method: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/roles${roleId ? `/${encodeURIComponent(roleId)}` : ""}`,
      method,
      payload,
    );
  }
  bindings(workspaceId: string, query: Query = {}) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/role-bindings`,
      "GET",
      undefined,
      query,
    );
  }
  bindingMutation(
    workspaceId: string,
    bindingId: string | undefined,
    method: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/role-bindings${bindingId ? `/${encodeURIComponent(bindingId)}` : ""}`,
      method,
      payload,
    );
  }
  organizations() {
    return this.platform("/api/workspaces");
  }
  organization(id: string) {
    return this.platform(`/api/workspaces/${encodeURIComponent(id)}`);
  }
  organizationMutation(
    id: string | undefined,
    method: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces${id ? `/${encodeURIComponent(id)}` : ""}`,
      method,
      payload,
    );
  }
  transferOwnership(id: string, userId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(id)}/transfer`,
      "POST",
      { userId },
    );
  }
  teams(workspaceId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/teams`,
    );
  }
  teamMutation(
    workspaceId: string,
    teamId: string | undefined,
    method: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/teams${teamId ? `/${encodeURIComponent(teamId)}` : ""}`,
      method,
      payload,
    );
  }
  teamMembers(
    workspaceId: string,
    teamId: string,
    memberId?: string,
    method = "GET",
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}/members${memberId ? `/${encodeURIComponent(memberId)}` : ""}`,
      method,
      payload,
    );
  }
  organizationAdministrators(workspaceId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/administrators`,
    );
  }
  setOrganizationAdministrators(workspaceId: string, payload: unknown) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/administrators`,
      "PATCH",
      payload,
    );
  }
  serviceAccounts(workspaceId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/service-accounts`,
    );
  }
  serviceAccountMutation(
    workspaceId: string,
    accountId: string | undefined,
    method: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/service-accounts${accountId ? `/${encodeURIComponent(accountId)}` : ""}`,
      method,
      payload,
    );
  }
  serviceAccountEnable(workspaceId: string, accountId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/service-accounts/${encodeURIComponent(accountId)}/enable`,
      "POST",
    );
  }
  serviceAccountDisable(workspaceId: string, accountId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/service-accounts/${encodeURIComponent(accountId)}/disable`,
      "POST",
    );
  }
  credentials(workspaceId: string, accountId: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/service-accounts/${encodeURIComponent(accountId)}/credentials`,
    );
  }
  credentialMutation(
    workspaceId: string,
    accountId: string,
    credentialId: string | undefined,
    method: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/service-accounts/${encodeURIComponent(accountId)}/credentials${credentialId ? `/${encodeURIComponent(credentialId)}` : ""}`,
      method,
      payload,
    );
  }
  audit(query: Query = {}) {
    return this.platform("/api/audit", "GET", undefined, query);
  }
  auditVerify() {
    // The Worker verifies the hash chain as part of GET /api/audit and returns
    // it in the `integrity` member; there is deliberately no invented verify
    // endpoint.
    return this.audit({ limit: 1 });
  }
  auditExport(format: "csv" | "ndjson", query: Query = {}) {
    return this.platform(
      `/api/audit/export.${format}`,
      "GET",
      undefined,
      query,
    );
  }
  siem(workspaceId: string, id?: string) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/siem-webhooks${id ? `/${encodeURIComponent(id)}` : ""}`,
    );
  }
  siemMutation(
    workspaceId: string,
    id: string | undefined,
    method: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/siem-webhooks${id ? `/${encodeURIComponent(id)}` : ""}`,
      method,
      payload,
    );
  }
  webhooks(id?: string, method = "GET", payload?: unknown) {
    return this.platform(
      `/api/v1/webhooks${id ? `/${encodeURIComponent(id)}` : ""}`,
      method,
      payload,
    );
  }
  rulesets(
    workspaceId: string,
    id?: string,
    method = "GET",
    payload?: unknown,
  ) {
    return this.platform(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/rulesets${id ? `/${encodeURIComponent(id)}` : ""}`,
      method,
      payload,
    );
  }
  rulesetAction(
    workspaceId: string,
    action: "evaluate" | "validate",
    id?: string,
    payload?: unknown,
  ) {
    return this.platform(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/rulesets${id ? `/${encodeURIComponent(id)}` : ""}/${action}`,
      "POST",
      payload,
    );
  }
  admin(path = "access", method = "GET", payload?: unknown) {
    return this.platform(`/api/admin/${path}`, method, payload);
  }
  governance(path: string, method = "GET", payload?: unknown) {
    return this.platform(`/api/v1/governance/${path}`, method, payload);
  }
  portability(
    target: "workspace" | "share" | "account",
    shareId?: string,
    query: Query = {},
  ) {
    return this.platform(
      `/api/v1/export/${target}${shareId ? `/${encodeURIComponent(shareId)}` : ""}`,
      "GET",
      undefined,
      query,
    );
  }
  retention(apply = false, payload?: unknown) {
    return this.platform(
      apply ? "/api/retention/apply" : "/api/retention",
      apply ? "POST" : "GET",
      payload,
    );
  }
  billing() {
    return this.platform("/api/billing");
  }
  ops(kind: "status" | "dependencies" | "slo", query: Query = {}) {
    return this.platform(`/api/ops/${kind}`, "GET", undefined, query);
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
  updateMetadata(id: string, payload: unknown) {
    return this.call<Record<string, unknown>>(
      `/api/v1/shares/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(payload) },
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
      { method: "GET" },
    );
  }
  proposalList(shareId: string) {
    return this.proposals(shareId);
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
