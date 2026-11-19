// Removes personal data from recorded fixtures before they are committed.
// Usage: node scrub.mjs file.jsonl [...]
import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";

const user = userInfo().username;
const SCRUB_KEYS = {
  email: "user@example.com",
  userId: "user-redacted",
  accountId: null,
  workspaceName: null,
  serverName: "host.local",
  installationId: "00000000-0000-0000-0000-000000000000",
};

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k in SCRUB_KEYS && v !== null ? SCRUB_KEYS[k] : scrub(v),
      ]),
    );
  }
  if (typeof value === "string")
    return value.replaceAll(`/Users/${user}`, "/Users/user").replaceAll(user, "user");
  return value;
}

for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  writeFileSync(file, `${lines.map((l) => JSON.stringify(scrub(JSON.parse(l)))).join("\n")}\n`);
}
