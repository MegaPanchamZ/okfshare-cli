import { describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  decodeBundleResponse,
  decodeContextResponse,
  decodeDiffResponse,
  decodeSearchResponse,
  MAX_RESPONSE_BYTES,
  decodePairingExchangeResponse,
  decodeWhoamiResponse,
} from "../src/api.js";
import { redactSecrets } from "../src/credentials.js";

describe("ApiClient", () => {
  const bundle = {
    data: {
      share: {
        id: "share/id",
        slug: "slug",
        title: "Title",
        description: "Description",
        visibility: "public",
        status: "active",
      },
      revision: {
        id: "revision",
        number: 2,
        immutable: true,
        sizeBytes: 999,
        fileCount: 1,
        createdAt: "now",
      },
      bundle: {
        title: "Title",
        description: "Description",
        root: "README.md",
        okfVersion: null,
        files: [{ path: "README.md", content: "---\ntype: Note\n---\n# Root" }],
        concepts: [],
        reserved: {},
        types: [],
        trustSummary: {},
        graph: {},
      },
    },
  };
  it("redacts passwords and tokens from CLI errors", () => {
    const message = redactSecrets("password=super-secret token=api-token", [
      "super-secret",
      "api-token",
    ]);
    expect(message).toBe("password=[REDACTED] token=[REDACTED]");
  });
  const validCredential = `okf_cli_${"a".repeat(64)}`;
  it.each([
    [{ credential: validCredential }, validCredential],
    [{ data: { credential: validCredential } }, validCredential],
  ])("validates pairing exchange response shapes", (response, credential) => {
    expect(decodePairingExchangeResponse(response)).toMatchObject({
      credential,
    });
  });
  it.each([
    undefined,
    null,
    {},
    { credential: "" },
    { credential: ` ${validCredential} ` },
    { credential: "not-a-cli-credential" },
    { credential: 42 },
    { data: { credential: " " } },
  ])(
    "rejects invalid pairing exchange response without exposing it",
    (response) => {
      expect(() => decodePairingExchangeResponse(response)).toThrow(
        "valid credential",
      );
    },
  );
  it("requires a workspace identity before authentication is considered valid", () => {
    expect(
      decodeWhoamiResponse({ workspace: { id: "workspace-id" }, usage: {} }),
    ).toMatchObject({ workspace: { id: "workspace-id" } });
    for (const response of [
      undefined,
      {},
      { workspace: {} },
      { workspace: { id: "" } },
    ])
      expect(() => decodeWhoamiResponse(response)).toThrow("invalid identity");
  });
  it("adds bearer and idempotency headers without exposing the token in payloads", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "bundle-1" }), { status: 200 }),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      token: "secret-token",
      fetch: request,
    });
    await api.publish(
      { files: [{ path: "README.md", content: "hello" }] },
      "key-1",
    );
    const init = request.mock.calls[0]?.[1];
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://example.test/api/v1/shares",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer secret-token",
    );
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("key-1");
    expect(String(init?.body)).not.toContain("secret-token");
  });

  it("uses the CLI auth start, poll, and one-time exchange endpoints", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device",
            userCode: "ABCD",
            verificationUri: "https://okfshare.app/cli/approve",
            interval: 7,
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "approved", interval: 9 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ credential: validCredential }), {
          status: 201,
        }),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: request,
    });
    expect(await api.pairingStart()).toMatchObject({ deviceCode: "device" });
    expect(await api.pairingStatus("device")).toEqual({
      status: "approved",
      interval: 9,
    });
    expect(await api.pairingExchange("device")).toEqual({
      credential: validCredential,
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/api/cli/auth/start",
      "https://example.test/api/cli/auth/poll",
      "https://example.test/api/cli/auth/exchange",
    ]);
    expect(String(request.mock.calls[2]?.[1]?.body)).not.toContain("secret");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).scopes).toEqual(
      ["workspace:read", "workspace:write"],
    );
  });

  it("sends the backend bundle root and not the legacy readme field", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 201 }));
    await new ApiClient({
      baseUrl: "https://example.test",
      fetch: request,
    }).publish(
      { root: "README.md", files: [], title: "x", visibility: "public" },
      "key",
    );
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.root).toBe("README.md");
    expect(body.readme).toBeUndefined();
  });

  it("paginates shares until the backend returns no cursor", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "one" }], nextCursor: "next" }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "two" }], nextCursor: null }),
        ),
      );
    const result = await new ApiClient({
      baseUrl: "https://example.test",
      fetch: request,
    }).list();
    expect(result.data).toEqual([{ id: "one" }, { id: "two" }]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/api/shares",
      "https://example.test/api/shares?cursor=next",
    ]);
  });

  it("URL-encodes retrieval identifiers, queries, and revision options", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(bundle)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              share: { id: "id", slug: "slug" },
              revision: { id: "r", number: 1 },
              query: "a b",
              total: 0,
              results: [],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              share: { id: "id", slug: "slug" },
              revision: { id: "r", number: 1 },
              query: "a b",
              budget: 500,
              estimate: "chars/4",
              usedTokens: 0,
              chunks: [],
              truncated: false,
            },
          }),
        ),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: request,
    });
    await api.bundle("id/with space", "current");
    await api.search("id/with space", "a/b c", 3, 7);
    await api.context("id/with space", "a/b c", "current", 500);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/api/v1/shares/id%2Fwith%20space/bundle?revision=current",
      "https://example.test/api/v1/shares/id%2Fwith%20space/search?q=a%2Fb+c&revision=3&limit=7",
      "https://example.test/api/v1/shares/id%2Fwith%20space/context?q=a%2Fb+c&revision=current&budget=500",
    ]);
  });
  it("calls and validates the revision diff contract", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          contractVersion: 1,
          data: {
            share: { id: "id", slug: "slug" },
            from: { id: "a", number: 1, contentDigest: "a" },
            to: { id: "b", number: 2, contentDigest: "b" },
            files: { added: ["new.md"], removed: [], changed: [] },
            metadata: {},
          },
        }),
      ),
    );
    const result = await new ApiClient({
      baseUrl: "https://example.test",
      fetch: request,
    }).diff("id/1", 1, 2);
    expect(result.data.files.added).toEqual(["new.md"]);
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://example.test/api/v1/shares/id%2F1/revisions/1/diff/2",
    );
    expect(() => decodeDiffResponse({ contractVersion: 2, data: {} })).toThrow(
      "contract",
    );
  });
  it("sends rollback expected revision as If-Match", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    await new ApiClient({
      baseUrl: "https://example.test",
      fetch: request,
    }).rollback("id", "2", "key", "3");
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get("if-match"),
    ).toBe("3");
  });

  it("strictly decodes the frozen retrieval response shapes", () => {
    expect(decodeBundleResponse(bundle).data.bundle.files).toHaveLength(1);
    expect(() =>
      decodeBundleResponse({
        data: {
          ...bundle.data,
          bundle: { ...bundle.data.bundle, files: [{ path: "README.md" }] },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeBundleResponse({
        data: {
          ...bundle.data,
          revision: { ...bundle.data.revision, sizeBytes: -1 },
        },
      }),
    ).toThrow();
    expect(
      decodeSearchResponse({
        data: {
          share: { id: "i", slug: "s" },
          revision: { id: "r", number: 1 },
          query: "q",
          total: 0,
          results: [],
        },
      }),
    ).toBeTruthy();
    expect(
      decodeContextResponse({
        data: {
          share: { id: "i", slug: "s" },
          revision: { id: "r", number: 1 },
          query: "q",
          budget: 500,
          estimate: "chars/4",
          usedTokens: 0,
          chunks: [],
          truncated: false,
        },
      }),
    ).toBeTruthy();
    expect(() =>
      decodeSearchResponse({
        data: {
          share: { id: "i", slug: "s" },
          revision: { id: "r", number: 0 },
          query: "q",
          total: 0,
          results: [],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeSearchResponse({
        data: {
          share: { id: "i", slug: "s" },
          revision: { id: "r", number: 1 },
          query: "q",
          total: 0,
          results: [
            {
              path: "../escape.md",
              startLine: 1,
              endLine: 1,
              snippet: "x",
              score: 1,
              matchCount: 1,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("bounds response bodies using declared and streamed sizes", async () => {
    const tooLarge = "x".repeat(MAX_RESPONSE_BYTES + 1);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
        }),
      )
      .mockResolvedValueOnce(
        new Response(tooLarge, { headers: { "content-length": "1" } }),
      );
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: request,
    });
    await expect(api.call("/declared")).rejects.toThrow(
      "exceeds the CLI limit",
    );
    await expect(api.call("/misreported")).rejects.toThrow(
      "exceeds the CLI limit",
    );
  });
});
