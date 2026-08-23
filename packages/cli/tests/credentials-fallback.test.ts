import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileCredentialStore,
  OsCredentialStore,
  SecureCredentialStore,
} from "../src/credentials.js";

describe("credential fallback", () => {
  it("uses the protected file when Secret Service is locked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okfshare-credentials-"));
    const file = new FileCredentialStore(join(directory, "credentials"));
    await file.set("fallback-token");
    const locked = new OsCredentialStore("linux", async () => {
      throw new Error("secret service is locked");
    });
    expect(await new SecureCredentialStore(file.path, locked).get()).toBe(
      "fallback-token",
    );
  });

  it("rejects failed round trips and does not write metadata", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "okfshare-credentials-roundtrip-"),
    );
    const file = new FileCredentialStore(join(directory, "credentials"));
    const backend = {
      get: async () => "",
      set: async () => undefined,
      delete: async () => undefined,
      status: async () => ({ backend: "file" as const, available: true }),
    };
    const store = new SecureCredentialStore(file.path, backend);
    await expect(store.setCredential("token", 123)).rejects.toThrow(
      "verification",
    );
    await expect(file.getMetadata()).resolves.toBeUndefined();
  });
  it("clears stale expiry metadata when a replacement has no expiry", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "okfshare-credentials-metadata-"),
    );
    const path = join(directory, "credentials");
    const backend = {
      value: undefined as string | undefined,
      get: async function () {
        return this.value;
      },
      set: async function (token: string) {
        this.value = token;
      },
      delete: async function () {
        this.value = undefined;
      },
      status: async () => ({ backend: "file" as const, available: true }),
    };
    const store = new SecureCredentialStore(path, backend);
    await store.setCredential("first-token", Date.now() - 1);
    await store.setCredential("replacement-token");
    await expect(readFile(`${path}.meta`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.runIf(process.platform === "linux")(
    "falls back when secret-tool exits before consuming stdin",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "okfshare-credentials-epipe-"),
      );
      const helper = join(directory, "secret-tool");
      await writeFile(helper, "#!/bin/sh\nexit 1\n");
      await chmod(helper, 0o700);
      const originalPath = process.env.PATH;
      process.env.PATH = `${directory}:${originalPath ?? ""}`;
      try {
        const store = new SecureCredentialStore(join(directory, "credentials"));
        await store.set("fallback-token");
        expect(await readFile(join(directory, "credentials"), "utf8")).toBe(
          "fallback-token\n",
        );
        expect((await stat(join(directory, "credentials"))).mode & 0o077).toBe(
          0,
        );
      } finally {
        process.env.PATH = originalPath;
      }
    },
  );
});
