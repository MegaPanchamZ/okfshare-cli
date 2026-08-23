import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  envelope,
  isEntryPoint,
  parseBoundedInteger,
  parseFlags,
  parsePositiveInteger,
  parseRevision,
  resultEnvelope,
  validateCommandFlags,
  commandHelp,
  classifyCliError,
  EXIT_CODES,
  isNpxExecutable,
  login,
  didYouMean,
  levenshtein,
} from "../src/index.js";
import { ApiError } from "../src/api.js";

describe("CLI parsing", () => {
  it("does not consume positional arguments after boolean flags", () => {
    expect(
      parseFlags(["pull", "share", "destination", "--yes", "--json"])
        .positional,
    ).toEqual(["pull", "share", "destination"]);
    expect(
      parseFlags(["search", "share", "query", "--unknown", "next"]).positional,
    ).toEqual(["search", "share", "query", "next"]);
  });
  it("validates revisions and numeric options", () => {
    expect(parseRevision("current")).toBe("current");
    expect(parseRevision("3")).toBe("3");
    expect(() => parseRevision("0")).toThrow();
    expect(parsePositiveInteger("5", "limit")).toBe(5);
    expect(() => parsePositiveInteger("nope", "limit")).toThrow("limit");
    expect(parseBoundedInteger("1", "limit", 1, 100)).toBe(1);
    expect(parseBoundedInteger("16000", "max-tokens", 500, 16000)).toBe(16000);
    expect(() => parseBoundedInteger("0", "limit", 1, 100)).toThrow();
    expect(() => parseBoundedInteger("101", "limit", 1, 100)).toThrow(
      "between",
    );
    expect(() => parseBoundedInteger("499", "max-tokens", 500, 16000)).toThrow(
      "between",
    );
  });
  it("does not let invalid boolean assignments confirm a pull", () => {
    expect(parseFlags(["pull", "id", "dest", "--yes=false"]).flags.yes).toBe(
      false,
    );
    expect(parseFlags(["pull", "id", "dest", "--yes=true"]).flags.yes).toBe(
      true,
    );
    expect(() => parseFlags(["pull", "id", "dest", "--yes=no"])).toThrow(
      "Boolean flag",
    );
  });
  it("normalizes --dry-run to the internal flag used by validation and execution", () => {
    const parsed = parseFlags(["setup", "--dry-run", "--json"]);
    expect(parsed.flags).toMatchObject({ dryRun: true, json: true });
    expect(parsed.flags["dry-run"]).toBeUndefined();
    expect(() => validateCommandFlags("setup", parsed.flags)).not.toThrow();
    expect(parseFlags([]).flags).toEqual({ json: false, dryRun: false });
  });
  it("accumulates repeated --topic and validates them", () => {
    const parsed = parseFlags([
      "publish",
      ".",
      "--topic",
      "ai",
      "--topic=design",
      "--json",
    ]);
    expect(parsed.flags.topic).toEqual(["ai", "design"]);
    expect(() => validateCommandFlags("publish", parsed.flags)).not.toThrow();
  });
  it("supports --quiet and repeated --fields for list", () => {
    expect(parseFlags(["list", "--quiet", "--json"]).flags.quiet).toBe(true);
    const fields = parseFlags(["list", "--fields", "id", "--fields", "slug"]);
    expect(fields.flags.fields).toEqual(["id", "slug"]);
    expect(() => validateCommandFlags("list", fields.flags)).not.toThrow();
  });
  it("suggests close commands via did-you-mean", () => {
    expect(levenshtein("pullsh", "publish")).toBeGreaterThan(0);
    expect(didYouMean("pulbish")).toBe("\nDid you mean: publish?");
    expect(didYouMean("publish")).toBe("");
  });
  it("uses the established JSON envelope", () => {
    expect(envelope("search", { search: { data: [] } })).toEqual({
      ok: true,
      operation: "search",
      search: { data: [] },

      next: [],
    });
  });
  it("creates a compact result envelope and rejects command-specific flags", () => {
    expect(resultEnvelope("doctor")).toMatchObject({
      operation: "doctor",
      ok: true,
      errors: [],
      warnings: [],
      next: [],
    });
    expect(resultEnvelope("doctor")).not.toHaveProperty("schemaVersion");
    expect(resultEnvelope("doctor")).not.toHaveProperty("cliVersion");
    expect(() =>
      validateCommandFlags("pull", {
        json: false,
        dryRun: false,
        title: "nope",
      }),
    ).toThrow("Unknown flag");
  });
  it("documents a dedicated npx command form for every command", () => {
    for (const [command, help] of Object.entries(commandHelp)) {
      expect(help, command).toContain(`npx okfshare@latest ${command}`);
    }
  });
  it("accepts the diff command contract", () => {
    const parsed = parseFlags(["diff", "share", "2", "3", "--json"]);
    expect(parsed.positional).toEqual(["diff", "share", "2", "3"]);
    expect(() => validateCommandFlags("diff", parsed.flags)).not.toThrow();
    expect(commandHelp.diff).toContain("diff SHARE_ID FROM TO");
  });
  it("keeps validation, safety, and partial outcomes stable", () => {
    expect(EXIT_CODES.validation).toBe(7);
    expect(EXIT_CODES.safety).toBe(8);
    expect(EXIT_CODES.partial).toBe(9);
    expect(
      classifyCliError(new Error("Possible secret detected in: README.md")),
    ).toEqual({ code: "SAFETY_VIOLATION", exitCode: 8 });
    expect(classifyCliError(new Error("Invalid YAML frontmatter"))).toEqual({
      code: "VALIDATION_FAILED",
      exitCode: 7,
    });
  });
  it("recognizes an npm-style symlink as the CLI entry point", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okfshare-entry-"));
    const target = join(directory, "index.js");
    const bin = join(directory, "okfshare");
    await writeFile(target, "#!/usr/bin/env node\n");
    await symlink(target, bin);
    expect(isEntryPoint(bin, target)).toBe(true);
    expect(isEntryPoint(undefined, target)).toBe(false);
  });
  it("probes Windows npx through the command shell", () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; shell?: boolean };
    }> = [];
    expect(
      isNpxExecutable("win32", (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      }),
    ).toBe(true);
    expect(calls).toEqual([
      {
        command: "npx.cmd",
        args: ["--version"],
        options: { stdio: "ignore", shell: true },
      },
    ]);
  });
});

describe("login pairing seam", () => {
  const pairingToken = `okf_cli_${"b".repeat(64)}`;
  const flags = { json: true, dryRun: false };
  const pairing = {
    deviceCode: "device-code",
    userCode: "user-code",
    verificationUri: "https://example.test/approve",
    expiresIn: 1,
    interval: 0,
  };
  function fakeStore(initial?: string) {
    let value = initial;
    const calls = { set: 0, delete: 0, get: 0 };
    return {
      calls,
      store: {
        get: async () => {
          calls.get++;
          return value;
        },
        set: async (token: string) => {
          calls.set++;
          value = token;
        },
        setCredential: async (token: string) => {
          calls.set++;
          value = token;
        },
        delete: async () => {
          calls.delete++;
          value = undefined;
        },
      },
    };
  }
  function fakeApi(
    exchange: unknown,
    whoami: () => Promise<unknown> = async () => ({
      workspace: { id: "workspace-id" },
    }),
  ) {
    const calls = { start: 0, poll: 0, exchange: 0, whoami: 0 };
    let token: string | undefined;
    return {
      calls,
      api: {
        setToken: (value: string | undefined) => {
          token = value;
        },
        whoami: async () => {
          calls.whoami++;
          return whoami();
        },
        pairingStart: async () => {
          calls.start++;
          return pairing;
        },
        pairingStatus: async () => {
          calls.poll++;
          return { status: "approved" as const };
        },
        pairingExchange: async () => {
          calls.exchange++;
          return exchange;
        },
      },
      token: () => token,
    };
  }

  it.each([
    {},
    { credential: " " },
    { credential: 9 },
    { credential: "wrong-format" },
  ])(
    "rejects malformed exchange before storage or success",
    async (exchange) => {
      const store = fakeStore();
      const api = fakeApi(exchange);
      await expect(login(flags, api.api, store.store)).rejects.toThrow(
        "valid credential",
      );
      expect(store.calls.set).toBe(0);
      expect(store.calls.delete).toBe(0);
      expect(api.calls.whoami).toBe(0);
    },
  );

  it("deletes state when credential round-trip storage fails", async () => {
    const store = fakeStore();
    store.store.setCredential = async () => {
      store.calls.set++;
      throw new Error("storage failed");
    };
    const api = fakeApi({ credential: pairingToken });
    await expect(login(flags, api.api, store.store)).rejects.toThrow(
      "storage failed",
    );
    expect(store.calls.delete).toBe(1);
    expect(api.calls.whoami).toBe(0);
  });

  it("deletes state when the stored credential does not round-trip exactly", async () => {
    const store = fakeStore();
    store.store.setCredential = async () => {
      store.calls.set++;
    };
    const api = fakeApi({ credential: pairingToken });
    await expect(login(flags, api.api, store.store)).rejects.toThrow(
      "storage verification failed",
    );
    expect(store.calls.delete).toBe(1);
    expect(api.calls.whoami).toBe(0);
  });

  it("deletes a newly stored credential when post-store authentication rejects", async () => {
    const store = fakeStore();
    const api = fakeApi({ credential: pairingToken }, async () => {
      throw new ApiError(401, "verification failed");
    });
    await expect(login(flags, api.api, store.store)).rejects.toThrow(
      "no credential was retained",
    );
    expect(store.calls.delete).toBe(1);
    expect(api.calls.whoami).toBe(1);
  });

  it("preserves a newly stored credential when post-store verification is transient", async () => {
    const store = fakeStore();
    const api = fakeApi({ credential: pairingToken }, async () => {
      throw new ApiError(503, "verification unavailable");
    });
    await expect(login(flags, api.api, store.store)).rejects.toThrow(
      "verification unavailable",
    );
    expect(store.calls.delete).toBe(0);
    expect(api.calls.whoami).toBe(1);
  });

  it("returns approved only after a valid workspace identity", async () => {
    const store = fakeStore();
    const api = fakeApi({ credential: pairingToken });
    await expect(login(flags, api.api, store.store)).resolves.toMatchObject({
      status: "approved",
    });
    expect(api.calls.whoami).toBe(1);
    expect(store.calls.delete).toBe(0);
  });

  it("verifies a valid environment token without pairing or storage", async () => {
    const original = process.env.OKFSHARE_TOKEN;
    process.env.OKFSHARE_TOKEN = "environment-token";
    try {
      const store = fakeStore("stored-token");
      const api = fakeApi(undefined);
      const result = await login(flags, api.api, store.store);
      expect(result.status).toBe("already_authenticated");
      expect(api.calls.start).toBe(0);
      expect(store.calls.set).toBe(0);
      expect(store.calls.delete).toBe(0);
      expect(api.token()).toBe("environment-token");
    } finally {
      if (original === undefined) delete process.env.OKFSHARE_TOKEN;
      else process.env.OKFSHARE_TOKEN = original;
    }
  });

  it("requires confirmation before sending a stored token to another origin", async () => {
    const store = fakeStore("stored-token");
    const api = fakeApi(undefined);
    await expect(
      login(flags, api.api, store.store, "https://untrusted.example"),
    ).rejects.toThrow("Pass --yes");
    expect(api.token()).toBeUndefined();
    expect(api.calls.whoami).toBe(0);
    expect(api.calls.start).toBe(0);
  });

  it("rejects an environment token without pairing or deleting stored state", async () => {
    const original = process.env.OKFSHARE_TOKEN;
    process.env.OKFSHARE_TOKEN = "rejected-environment-token";
    try {
      const store = fakeStore("stored-token");
      const api = fakeApi(undefined, async () => {
        throw new ApiError(401, "unauthorized");
      });
      await expect(login(flags, api.api, store.store)).rejects.toThrow(
        "OKFSHARE_TOKEN was rejected",
      );
      expect(api.calls.start).toBe(0);
      expect(store.calls.delete).toBe(0);
    } finally {
      if (original === undefined) delete process.env.OKFSHARE_TOKEN;
      else process.env.OKFSHARE_TOKEN = original;
    }
  });

  it.each([500, 503])(
    "preserves stored state on transient whoami failure (%s)",
    async (status) => {
      const store = fakeStore("stored-token");
      const api = fakeApi(undefined, async () => {
        throw new ApiError(status, "temporary failure");
      });
      await expect(login(flags, api.api, store.store)).rejects.toThrow(
        "temporary failure",
      );
      expect(store.calls.delete).toBe(0);
      expect(api.calls.start).toBe(0);
    },
  );
});
