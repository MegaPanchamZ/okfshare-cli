import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import constants from "node:constants";
const { O_CREAT, O_TRUNC, O_WRONLY } = constants;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const hasPosixPermissions = typeof process.getuid === "function";

export interface CredentialStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  constructor(path = join(homedir(), ".config", "okfshare", "credentials")) {
    this.path = path;
  }
  async get() {
    try {
      const file = await lstat(this.path);
      if (
        !file.isFile() ||
        (hasPosixPermissions &&
          ((process.getuid && file.uid !== process.getuid()) ||
            (file.mode & 0o077) !== 0))
      )
        throw new Error("Insecure credential file");
      return (await readFile(this.path, "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async set(token: string) {
    const directory = join(this.path, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(directory);
    if (
      !parent.isDirectory() ||
      (hasPosixPermissions &&
        ((process.getuid && parent.uid !== process.getuid()) ||
          (parent.mode & 0o077) !== 0))
    )
      throw new Error("Insecure credential directory");
    try {
      const current = await lstat(this.path);
      if (
        !current.isFile() ||
        (hasPosixPermissions &&
          ((process.getuid && current.uid !== process.getuid()) ||
            (current.mode & 0o077) !== 0))
      )
        throw new Error("Insecure credential file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const file = await open(
      this.path,
      O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW,
      0o600,
    );
    await file.writeFile(`${token}\n`, "utf8");
    await file.chmod(0o600);
    await file.close();
  }
  async delete() {
    await rm(this.path, { force: true });
  }
  async setMetadata(metadata: { expiresAt: number }) {
    await writeProtectedFile(`${this.path}.meta`, JSON.stringify(metadata));
  }
  async getMetadata(): Promise<{ expiresAt?: number } | undefined> {
    try {
      const info = await lstat(`${this.path}.meta`);
      if (!info.isFile() || (hasPosixPermissions && (info.mode & 0o077) !== 0))
        throw new Error("Insecure credential metadata");
      const value: unknown = JSON.parse(
        await readFile(`${this.path}.meta`, "utf8"),
      );
      return value && typeof value === "object"
        ? (value as { expiresAt?: number })
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
async function writeProtectedFile(path: string, content: string) {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(
    path,
    O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW,
    0o600,
  );
  await file.writeFile(`${content}\n`, "utf8");
  await file.chmod(0o600);
  await file.close();
}
export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<CommandResult>;
const defaultRunner: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result ?? { stdout, stderr });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      stdout += value;
    });
    child.stderr.on("data", (value: string) => {
      stderr += value;
    });
    child.stdout.once("error", (error) => finish(error));
    child.stderr.once("error", (error) => finish(error));
    child.stdin.once("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      code === 0
        ? finish(undefined, { stdout, stderr })
        : finish(new Error(`${command} exited with ${code}: ${stderr}`)),
    );
    try {
      child.stdin.end(input);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
export type CredentialBackendStatus = {
  backend: "keychain" | "secret-tool" | "windows" | "file" | "unavailable";
  available: boolean;
  detail?: string;
};
export class OsCredentialStore implements CredentialStore {
  private readonly service = "okfshare";
  private readonly account = safeCredentialAccount(process.env.USER);
  constructor(
    private readonly platform = process.platform,
    private readonly run: CommandRunner = defaultRunner,
  ) {}
  private async secretTool(args: string[], input?: string) {
    try {
      return await this.run("secret-tool", args, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found/i.test(message))
        throw new Error(
          "Linux secret-tool is unavailable; install a Secret Service provider (for example gnome-keyring) or use the protected file fallback",
        );
      if (/locked|denied|dbus|secret service/i.test(message))
        throw new Error(
          "Linux Secret Service is unavailable or locked; unlock the keyring or use the protected file fallback",
        );
      throw error;
    }
  }
  async get() {
    try {
      if (this.platform === "darwin")
        return (
          (
            await this.run("security", [
              "find-generic-password",
              "-s",
              this.service,
              "-a",
              this.account,
              "-w",
            ])
          ).stdout.trim() || undefined
        );
      if (this.platform === "win32")
        return (
          (
            await this.run("powershell.exe", [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              windowsReadScript(this.service, this.account),
            ])
          ).stdout.trim() || undefined
        );
      if (this.platform === "linux")
        return (
          (
            await this.secretTool([
              "lookup",
              "service",
              this.service,
              "account",
              this.account,
            ])
          ).stdout.trim() || undefined
        );
      return undefined;
    } catch (error) {
      if (
        this.platform === "linux" &&
        error instanceof Error &&
        /unavailable|locked/i.test(error.message)
      )
        throw error;
      return undefined;
    }
  }
  async set(token: string) {
    if (!token.trim()) throw new Error("Credential must not be empty");
    if (this.platform === "darwin") {
      await this.run(
        "security",
        ["-i"],
        `add-generic-password -U -s ${securityQuote(this.service)} -a ${securityQuote(this.account)} -X ${Buffer.from(token, "utf8").toString("hex")}\n`,
      );
      return;
    }
    if (this.platform === "linux") {
      await this.secretTool(
        [
          "store",
          "--label",
          "OKFShare credential",
          "service",
          this.service,
          "account",
          this.account,
        ],
        token,
      );
      return;
    }
    if (this.platform === "win32") {
      await this.run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsWriteScript(this.service, this.account),
        ],
        token,
      );
      return;
    }
    throw new Error("Safe OS credential helper unavailable");
  }
  async delete() {
    try {
      if (this.platform === "darwin")
        await this.run("security", [
          "delete-generic-password",
          "-s",
          this.service,
          "-a",
          this.account,
        ]);
      else if (this.platform === "linux")
        await this.secretTool([
          "clear",
          "service",
          this.service,
          "account",
          this.account,
        ]);
      else if (this.platform === "win32")
        await this.run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsDeleteScript(this.service, this.account),
        ]);
    } catch {}
  }
  async status(): Promise<CredentialBackendStatus> {
    if (this.platform === "darwin")
      return {
        backend: "keychain",
        available: await this.commandAvailable("security", ["help"]),
      };
    if (this.platform === "linux")
      return {
        backend: "secret-tool",
        available: await this.commandAvailable("secret-tool", ["--version"]),
        detail: "Secret Service keyring",
      };
    if (this.platform === "win32")
      return {
        backend: "windows",
        available: await this.commandAvailable("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-Command powershell.exe",
        ]),
        detail: "Windows Credential Manager",
      };
    return { backend: "unavailable", available: false };
  }
  private async commandAvailable(command: string, args: string[]) {
    try {
      await this.run(command, args);
      return true;
    } catch {
      return false;
    }
  }
}
const windowsType = `using System; using System.Runtime.InteropServices; public static class C { [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct X { public int Type; public IntPtr TargetName; public IntPtr Comment; public int Persist; public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; public int CredentialBlobSize; public IntPtr CredentialBlob; } [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string t,int type,int f,out IntPtr p); [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref X c,int f); [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern bool CredDelete(string t,int type,int f); [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p); }`;
const windowsReadScript = (service: string, account: string) =>
  `Add-Type -TypeDefinition '${windowsType}'; $p=[IntPtr]::Zero; if([C]::CredRead('${service}:${account}',1,0,[ref]$p)){ $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type]::GetType('C+X')); $b=[byte[]]::new($c.CredentialBlobSize); [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize); [Text.Encoding]::Unicode.GetString($b); [C]::CredFree($p) }`;
const windowsWriteScript = (service: string, account: string) =>
  `Add-Type -TypeDefinition '${windowsType}'; $token=[Console]::In.ReadToEnd(); $target=[Runtime.InteropServices.Marshal]::StringToHGlobalUni('${service}:${account}'); $user=[Runtime.InteropServices.Marshal]::StringToHGlobalUni('${account}'); $bytes=[Text.Encoding]::Unicode.GetBytes($token); $blob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length); [Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length); $c=New-Object C+X; $c.Type=1; $c.TargetName=$target; $c.UserName=$user; $c.CredentialBlob=$blob; $c.CredentialBlobSize=$bytes.Length; $c.Persist=2; if(-not [C]::CredWrite([ref]$c,0)){ exit 1 }; [Runtime.InteropServices.Marshal]::FreeHGlobal($target); [Runtime.InteropServices.Marshal]::FreeHGlobal($user); [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)`;
const windowsDeleteScript = (service: string, account: string) =>
  `Add-Type -TypeDefinition '${windowsType}'; [C]::CredDelete('${service}:${account}',1,0) | Out-Null`;
export class SecureCredentialStore implements CredentialStore {
  private readonly keychain: OsCredentialStore;
  private readonly file: FileCredentialStore;
  constructor(path?: string, keychain = new OsCredentialStore()) {
    this.keychain = keychain;
    this.file = new FileCredentialStore(path);
  }
  async get() {
    try {
      return (await this.keychain.get()) ?? (await this.file.get());
    } catch (error) {
      const fallback = await this.file.get();
      if (fallback) return fallback;
      throw error;
    }
  }
  async set(token: string) {
    try {
      await this.keychain.set(token);
      await this.file.delete();
    } catch {
      await this.file.set(token);
    }
  }
  async setCredential(token: string, expiresAt?: number) {
    if (!token.trim()) throw new Error("Credential must not be empty");
    if (
      expiresAt !== undefined &&
      (!Number.isFinite(expiresAt) || expiresAt <= 0)
    )
      throw new Error("Invalid credential expiry");
    await this.set(token);
    const roundTrip = await this.get();
    if (roundTrip !== token || !roundTrip?.trim()) {
      await this.delete();
      throw new Error("Credential storage verification failed");
    }
    try {
      if (expiresAt !== undefined) await this.file.setMetadata({ expiresAt });
      else await rm(`${this.file.path}.meta`, { force: true });
    } catch (error) {
      await this.delete();
      throw error;
    }
  }
  async delete() {
    await this.keychain.delete();
    await this.file.delete();
    await rm(`${this.file.path}.meta`, { force: true });
  }
  async status(): Promise<
    CredentialBackendStatus & { configured: boolean; expiresAt?: number }
  > {
    const os = await this.keychain.status();
    const metadata = await this.file.getMetadata();
    const configured = Boolean(
      process.env.OKFSHARE_TOKEN?.trim() ||
      (await this.keychain.get().catch(() => undefined)) ||
      (await this.file.get().catch(() => undefined)),
    );
    return {
      ...os,
      configured:
        configured || Boolean(await this.file.get().catch(() => undefined)),
      expiresAt: metadata?.expiresAt,
    };
  }
}
export async function tokenFrom(
  store: CredentialStore,
): Promise<string | undefined> {
  const environment = process.env.OKFSHARE_TOKEN?.trim();
  if (environment) return environment;
  const status =
    "status" in store && typeof store.status === "function"
      ? await (store.status as () => Promise<{ expiresAt?: number }>)().catch(
          () => undefined,
        )
      : undefined;
  if (status?.expiresAt !== undefined && status.expiresAt <= Date.now())
    return undefined;
  return await store.get();
}
export function redactSecrets(value: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}
function securityQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeCredentialAccount(value: string | undefined): string {
  return value && /^[A-Za-z0-9._@-]{1,128}$/.test(value) ? value : "default";
}
