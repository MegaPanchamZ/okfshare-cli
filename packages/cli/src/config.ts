import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type Visibility = "public" | "unlisted" | "password";
export type OkfConfig = {
  include?: string[];
  exclude?: string[];
  root?: string;
  title?: string;
  description?: string;
  topics?: string[];
  password?: string;
  visibility?: Visibility;
};

export async function readConfig(directory: string): Promise<OkfConfig> {
  try {
    const raw = await readFile(join(directory, "okfshare.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("okfshare.json must contain an object");
    const value = parsed as Record<string, unknown>;
    for (const key of ["include", "exclude", "topics"] as const)
      if (
        value[key] !== undefined &&
        (!Array.isArray(value[key]) ||
          value[key].some((x) => typeof x !== "string"))
      )
        throw new Error(`${key} must be an array of strings`);
    if (
      value.visibility !== undefined &&
      !["public", "unlisted", "password"].includes(String(value.visibility))
    )
      throw new Error("visibility must be public, unlisted, or password");
    for (const key of ["root", "title", "description", "password"] as const)
      if (value[key] !== undefined && typeof value[key] !== "string")
        throw new Error(`${key} must be a string`);
    if (typeof value.password === "string" && value.password.length > 256)
      throw new Error("password must be at most 256 characters");
    if (value.password !== undefined && value.visibility !== "password")
      throw new Error("password is only valid when visibility is password");
    if (value.visibility === "password" && typeof value.password !== "string")
      throw new Error("password is required when visibility is password");
    return value as OkfConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function configuredRoot(directory: string, config: OkfConfig): string {
  return resolve(directory, config.root ?? ".");
}
