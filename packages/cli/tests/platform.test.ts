import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api.js";
import { parseFlags, validateCommandFlags } from "../src/index.js";

describe("platform API access", () => {
  it("covers graph, refs, and governance routes with encoded identifiers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    });
    await api.graphNeighbors("share/id", { entity: "entity id", depth: 2 });
    await api.createRef("share/id", { refType: "tag", label: "v1" });
    await api.governance("policy/visibility", "PUT", { value: {} });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/api/v1/shares/share%2Fid/graph/neighbors?entity=entity+id&depth=2",
      "https://example.test/api/v1/shares/share%2Fid/refs",
      "https://example.test/api/v1/governance/policy/visibility",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      value: {},
    });
  });

  it("keeps credential and signature inputs in request bodies only", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { token: "one-time" } }), {
        status: 201,
      }),
    );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    });
    await api.attestSubmit("share", "3", {
      claim: { key: "public-key" },
      signature: "signature",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://example.test/api/v1/shares/share/revisions/3/attestations",
    );
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("public-key");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("private");
  });

  it("accepts bounded platform flags and rejects out-of-range values", () => {
    const parsed = parseFlags([
      "graph",
      "neighbors",
      "share",
      "--depth",
      "3",
      "--limit",
      "20",
    ]);
    expect(() => validateCommandFlags("graph", parsed.flags)).not.toThrow();
    expect(() =>
      validateCommandFlags(
        "ops",
        parseFlags(["ops", "slo", "--target-slo", "0.99"]).flags,
      ),
    ).not.toThrow();
    expect(() =>
      validateCommandFlags(
        "graph",
        parseFlags(["graph", "--depth", "4"]).flags,
      ),
    ).toThrow("between");
  });

  it("matches the mounted non-auth Worker routes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    });
    await api.forkCreate("source");
    await api.forkSync("fork");
    await api.revisionIntegrity("share", "2", { full: 1 });
    await api.shareRoles("share");
    await api.shareGrants("share");
    await api.annotations("share", { revision: 2 });
    await api.webhooks(undefined, "GET");
    await api.rulesetAction("workspace", "validate", undefined, { value: {} });
    await api.forkStatus("fork");
    await api.workspaceCapabilities("workspace");
    await api.shareCapabilities("share");
    await api.workspaceSearch("query", { limit: 10, cursor: "next" });
    await api.source("share/id", 3, "docs/read me.md", {
      lineStart: 2,
      lineEnd: 4,
    });
    await api.stars("share", "POST");
    await api.stars();
    await api.redact("share", "reason", "idempotency-key");
    await api.serviceAccountEnable("workspace", "account/id");
    await api.serviceAccountDisable("workspace", "account/id");
    await api.organizationAdministrators("workspace");
    await api.setOrganizationAdministrators("workspace", {
      billingOwnerId: "user",
    });
    await api.proposalList("share/id");
    expect(
      fetcher.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      ["https://example.test/api/v1/shares/source/fork", "POST"],
      ["https://example.test/api/v1/shares/fork/sync", "POST"],
      [
        "https://example.test/api/v1/shares/share/revisions/2/integrity?full=1",
        "GET",
      ],
      ["https://example.test/api/v1/shares/share/roles", "GET"],
      ["https://example.test/api/v1/shares/share/grants", "GET"],
      [
        "https://example.test/api/v1/shares/share/annotations?revision=2",
        "GET",
      ],
      ["https://example.test/api/v1/webhooks", "GET"],
      [
        "https://example.test/api/v1/workspaces/workspace/rulesets/validate",
        "POST",
      ],
      ["https://example.test/api/v1/shares/fork/fork/status", "GET"],
      ["https://example.test/api/workspaces/workspace/capabilities", "GET"],
      ["https://example.test/api/shares/share/capabilities", "GET"],
      [
        "https://example.test/api/v1/workspace/search?q=query&limit=10&cursor=next",
        "GET",
      ],
      [
        "https://example.test/api/v1/shares/share%2Fid/revisions/3/source/docs/read%20me.md?lineStart=2&lineEnd=4",
        "GET",
      ],
      ["https://example.test/api/v1/shares/share/star", "POST"],
      ["https://example.test/api/v1/me/stars", "GET"],
      ["https://example.test/api/v1/shares/share/redact", "POST"],
      [
        "https://example.test/api/workspaces/workspace/service-accounts/account%2Fid/enable",
        "POST",
      ],
      [
        "https://example.test/api/workspaces/workspace/service-accounts/account%2Fid/disable",
        "POST",
      ],
      ["https://example.test/api/workspaces/workspace/administrators", "GET"],
      ["https://example.test/api/workspaces/workspace/administrators", "PATCH"],
      ["https://example.test/api/v1/shares/share%2Fid/proposals", "GET"],
    ]);
    expect(fetcher.mock.calls[16]?.[1]?.body).toBeUndefined();
    expect(JSON.parse(String(fetcher.mock.calls[19]?.[1]?.body))).toEqual({
      billingOwnerId: "user",
    });
  });

  it("uses the Worker target query key for SLO compatibility", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    });
    await api.ops("slo", { target: "0.99", windowHours: 24 });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://example.test/api/ops/slo?target=0.99&windowHours=24",
    );
  });

  it("keeps ref and governance method/body placement exact", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    });
    await api.moveRef("share", "main", {
      targetRevisionId: "revision",
      expectedRevisionId: "old",
    });
    await api.deleteRef("share", "main", "old");
    await api.governance("retention", "GET");
    expect(
      fetcher.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      ["https://example.test/api/v1/shares/share/refs/main", "PUT"],
      [
        "https://example.test/api/v1/shares/share/refs/main?expectedRevisionId=old",
        "DELETE",
      ],
      ["https://example.test/api/v1/governance/retention", "GET"],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      targetRevisionId: "revision",
      expectedRevisionId: "old",
    });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(fetcher.mock.calls[2]?.[1]?.body).toBeUndefined();
  });

  it("preserves fork status fields", async () => {
    const status = {
      data: {
        status: "conflicted",
        currentStatus: "conflicted",
        conflictSummary: { count: 2, paths: ["README.md"] },
      },
    };
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify(status), { status: 200 }),
        ),
    });
    await expect(api.forkStatus("fork")).resolves.toEqual(status);
  });
});
