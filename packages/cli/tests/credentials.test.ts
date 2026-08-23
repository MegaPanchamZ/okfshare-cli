import { describe, expect, it } from "vitest";
import { OsCredentialStore } from "../src/credentials.js";

describe("OS credential backends", () => {
  it.each([
    ["darwin", "security"],
    ["linux", "secret-tool"],
    ["win32", "powershell.exe"],
  ])(
    "uses the safe %s command path for lookup, set, and delete",
    async (platform, command) => {
      const calls: Array<{ command: string; args: string[]; input?: string }> =
        [];
      const store = new OsCredentialStore(
        platform,
        async (actual, args, input) => {
          calls.push({ command: actual, args, input });
          return {
            stdout:
              actual === command &&
              args.some(
                (arg) =>
                  arg.includes("lookup") ||
                  arg.includes("find-generic") ||
                  arg.includes("Read"),
              )
                ? "token\n"
                : "",
            stderr: "",
          };
        },
      );
      expect(await store.get()).toBe("token");
      await store.set("secret-value");
      await store.delete();
      expect(calls.every((call) => !call.args.includes("secret-value"))).toBe(
        true,
      );
      expect(
        calls.find(
          (call) => call.command === command && call.input !== undefined,
        )?.input,
      ).toBeDefined();
    },
  );

  it("uses security help rather than security --version for macOS availability", async () => {
    const calls: string[][] = [];
    const store = new OsCredentialStore("darwin", async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") throw new Error("unsupported");
      return { stdout: "security help\n", stderr: "" };
    });
    expect(await store.status()).toMatchObject({
      backend: "keychain",
      available: true,
    });
    expect(calls).toContainEqual(["security", "help"]);
    expect(calls).not.toContainEqual(["security", "--version"]);
  });

  it("writes macOS credentials through interactive hex input without argv secrets", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const store = new OsCredentialStore(
      "darwin",
      async (_command, args, input) => {
        calls.push({ args, input });
        return { stdout: "", stderr: "" };
      },
    );
    await store.set("secret-value");
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.input).toContain("-X 7365637265742d76616c7565");
    expect(calls[0]?.args.join(" ")).not.toContain("secret-value");
  });

  it("treats a successful empty macOS Keychain lookup as missing", async () => {
    const store = new OsCredentialStore("darwin", async (_command, args) => ({
      stdout: args.includes("find-generic-password") ? "\n" : "",
      stderr: "",
    }));
    await expect(store.get()).resolves.toBeUndefined();
  });

  it("does not interpolate a hostile account into macOS interactive commands", async () => {
    const original = process.env.USER;
    process.env.USER = "attacker\ndelete-generic-password -s other";
    const calls: Array<{ args: string[]; input?: string }> = [];
    try {
      const store = new OsCredentialStore(
        "darwin",
        async (_command, args, input) => {
          calls.push({ args, input });
          return { stdout: "", stderr: "" };
        },
      );
      await store.set("secret-value");
      expect(calls[0]?.input).toContain("-a 'default'");
      expect(calls[0]?.input).not.toContain("delete-generic-password");
    } finally {
      if (original === undefined) delete process.env.USER;
      else process.env.USER = original;
    }
  });
});
