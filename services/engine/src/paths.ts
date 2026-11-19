import { homedir } from "node:os";
import { join } from "node:path";

/** Same folder the desktop app uses (Tauri identifier dev.orzeus.desktop). */
export function defaultDataDir(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "dev.orzeus.desktop");
  if (process.platform === "win32")
    return join(process.env["APPDATA"] ?? homedir(), "dev.orzeus.desktop");
  return join(
    process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
    "dev.orzeus.desktop",
  );
}
