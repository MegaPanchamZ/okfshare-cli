import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOL_LIST, safeOutput } from "../src/index.js";

const tool = (name: string) => {
  const found = TOOL_LIST.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

describe("platform MCP contract", () => {
  it("publishes closed schemas and stable platform tools", () => {
    const assertClosed = (schema: unknown) => {
      if (!schema || typeof schema !== "object") return;
      const value = schema as Record<string, unknown>;
      if (value.type === "object")
        assert.equal(value.additionalProperties, false);
      if (value.properties && typeof value.properties === "object")
        for (const child of Object.values(value.properties))
          assertClosed(child);
      if (value.items) assertClosed(value.items);
    };
    for (const item of TOOL_LIST) {
      assert.equal(item.inputSchema.type, "object");
      assertClosed(item.inputSchema);
    }
    assert.ok(
      !TOOL_LIST.some((item) => /sso|scim|mfa|session/i.test(item.name)),
    );
    const graphProperties = tool("okfshare_graph").inputSchema
      .properties as Record<string, unknown>;
    assert.ok("action" in graphProperties);
    assert.ok("entityTypes" in graphProperties);
    assert.ok(
      "confirm" in
        (tool("okfshare_service_accounts").inputSchema.properties as Record<
          string,
          unknown
        >),
    );
  });

  it("maps graph and refs arguments to the finalized CLI contract", () => {
    assert.deepEqual(
      tool("okfshare_graph").args({
        action: "neighbors",
        shareId: "share/id",
        entity: "Person/A",
        depth: 2,
      }),
      [
        "graph",
        "neighbors",
        "share/id",
        "--entity",
        "Person/A",
        "--depth",
        "2",
        "--json",
      ],
    );
    assert.deepEqual(
      tool("okfshare_refs").args({
        action: "create",
        shareId: "share",
        refType: "tag",
        label: "v1",
        targetRevisionId: "r3",
        data: { note: "x" },
        confirm: true,
      }),
      [
        "refs",
        "tags",
        "share",
        "create",
        "--data",
        '{"note":"x"}',
        "--label",
        "v1",
        "--target-revision-id",
        "r3",
        "--yes",
        "--json",
      ],
    );
  });

  it("requires and maps explicit confirmation for mutations", () => {
    assert.throws(
      () =>
        tool("okfshare_refs").args({
          action: "delete",
          shareId: "s",
          label: "old",
        }),
      /confirm=true/,
    );
    assert.ok(
      tool("okfshare_refs")
        .args({ action: "delete", shareId: "s", label: "old", confirm: true })
        .includes("--yes"),
    );
    assert.throws(
      () =>
        tool("okfshare_service_accounts").args({
          action: "revoke",
          workspaceId: "w",
          accountId: "a",
          credentialId: "c",
        }),
      /confirm=true/,
    );
  });

  it("rejects and strips secrets without logging them", () => {
    assert.throws(
      () =>
        tool("okfshare_attestations").args({
          action: "submit",
          shareId: "s",
          revision: "3",
          data: { privateKey: "do-not-use" },
        }),
      /Private keys/,
    );
    const output = safeOutput(
      '{"token":"one-time","privateKey":"hidden","nested":{"secret":"hidden"}}',
      true,
    );
    assert.match(output, /"oneTimeCredential":true/);
    assert.match(output, /one-time/);
    assert.doesNotMatch(output, /hidden/);
  });

  it("covers the non-auth lifecycle entry points", () => {
    for (const name of [
      "okfshare_fork",
      "okfshare_status",
      "okfshare_pull",
      "okfshare_bindings",
      "okfshare_siem",
    ])
      assert.ok(tool(name));
    assert.throws(
      () => tool("okfshare_fork").args({ shareId: "s" }),
      /confirm=true/,
    );
    assert.deepEqual(
      tool("okfshare_fork").args({ shareId: "s", confirm: true }),
      ["fork", "create", "s", "--yes", "--json"],
    );
    assert.throws(
      () =>
        tool("okfshare_proposals").args({ action: "reject", proposalId: "p" }),
      /confirm=true/,
    );
  });

  it("maps the remaining CLI platform contracts without inventing routes", () => {
    assert.deepEqual(
      tool("okfshare_fork").args({ action: "status", shareId: "fork" }),
      ["fork", "status", "fork", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_integrity").args({
        shareId: "s",
        revision: "7",
        limit: 20,
        cursor: "next",
      }),
      ["integrity", "s", "7", "--limit", "20", "--cursor", "next", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_share_access").args({
        area: "grants",
        action: "delete",
        shareId: "s",
        resourceId: "g",
        confirm: true,
      }),
      ["share-access", "grants", "s", "delete", "g", "--yes", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_domains").args({
        action: "verify",
        domainId: "d",
        confirm: true,
      }),
      ["domains", "verify", "d", "--yes", "--json"],
    );
    assert.deepEqual(tool("okfshare_webhooks").args({ action: "list" }), [
      "webhooks",
      "list",
      "--json",
    ]);
    assert.deepEqual(
      tool("okfshare_share_access").args({
        area: "roles",
        action: "update",
        shareId: "s",
        role: "editor",
        confirm: true,
      }),
      [
        "share-access",
        "roles",
        "s",
        "update",
        "--role",
        "editor",
        "--yes",
        "--json",
      ],
    );
  });

  it("maps capabilities, administrators, and proposal discovery to CLI argv", () => {
    assert.deepEqual(
      tool("okfshare_capabilities").args({ scope: "share", id: "s" }),
      ["capabilities", "share", "s", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_organization_administrators").args({
        action: "set",
        workspaceId: "w",
        billingOwnerId: "u1",
        securityAdministratorId: "u2",
        confirm: true,
      }),
      [
        "orgs",
        "administrators",
        "set",
        "w",
        "--billing-owner-id",
        "u1",
        "--security-administrator-id",
        "u2",
        "--yes",
        "--json",
      ],
    );
    assert.deepEqual(
      tool("okfshare_proposals").args({ action: "list", shareId: "s" }),
      ["proposals", "list", "s", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_proposals").args({
        action: "merge",
        proposalId: "p",
        confirm: true,
      }),
      ["proposals", "merge", "p", "--yes", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_refs").args({
        action: "move",
        shareId: "s",
        refType: "branch",
        label: "main",
        targetRevisionId: "r4",
        confirm: true,
      }),
      [
        "refs",
        "move",
        "s",
        "main",
        "--ref-type",
        "branch",
        "--target-revision-id",
        "r4",
        "--yes",
        "--json",
      ],
    );
    assert.deepEqual(
      tool("okfshare_service_accounts").args({
        action: "disable",
        workspaceId: "w",
        accountId: "a",
        confirm: true,
      }),
      ["service-accounts", "disable", "w", "a", "--yes", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_ops").args({ action: "slo", targetSlo: 99 }),
      ["ops", "slo", "--target-slo", "99", "--json"],
    );
    assert.deepEqual(
      tool("okfshare_bindings").args({
        action: "create",
        workspaceId: "w",
        data: { roleId: "r", subjectId: "u" },
        confirm: true,
      }),
      [
        "bindings",
        "create",
        "w",
        "--data",
        '{"roleId":"r","subjectId":"u"}',
        "--yes",
        "--json",
      ],
    );
  });

  it("redacts secrets recursively and keeps one-time credential labeling", () => {
    assert.throws(
      () =>
        tool("okfshare_webhooks").args({
          action: "create",
          data: { nested: [{ signingSecret: "never" }] },
          confirm: true,
        }),
      /Private keys, credentials, and signing secrets/,
    );
    const schema = tool("okfshare_domains").inputSchema as Record<
      string,
      unknown
    >;
    assert.equal(schema.additionalProperties, false);
    assert.equal(
      (schema.properties as Record<string, Record<string, unknown>>).data
        .additionalProperties,
      false,
    );
  });
});
