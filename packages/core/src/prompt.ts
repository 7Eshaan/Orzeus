import type { CheckSpec, ContextPacket, ContextRef } from "@orzeus/schema";

function describeRef(ref: ContextRef): string {
  switch (ref.kind) {
    case "file_range":
      return `${ref.path} lines ${ref.startLine}-${ref.endLine}: ${ref.why}`;
    case "symbol":
      return `${ref.symbolKind} ${ref.symbol} in ${ref.path}: ${ref.why}`;
    case "mcp_resource":
      return `${ref.uri} (MCP server ${ref.server}): ${ref.why}`;
    case "memory":
      return `memory ${ref.memoryId}: ${ref.why}`;
  }
}

const section = (title: string, lines: readonly string[]): string =>
  lines.length === 0 ? "" : `## ${title}\n${lines.map((l) => `- ${l}`).join("\n")}\n\n`;

/**
 * Renders a Context Packet into the worker prompt. Deterministic (same packet, same text), so
 * provider prompt caches hit and the trace can reproduce exactly what the worker saw.
 */
export function renderPacketPrompt(
  packet: ContextPacket,
  checks: readonly CheckSpec[],
  writeScope: readonly string[],
): string {
  const checkLines = checks.map((c) =>
    c.kind === "command" ? `${c.label}: \`${c.argv.join(" ")}\`` : c.label,
  );
  return (
    `# Task\n${packet.objective}\n\n` +
    section(
      "Acceptance criteria",
      packet.acceptance.map((a) => a.statement),
    ) +
    section("Out of scope", packet.nonGoals) +
    section(
      "Files you may change",
      writeScope.length === 0 ? ["none: this task is read-only"] : writeScope,
    ) +
    section("Relevant context", packet.context.map(describeRef)) +
    section(
      "Constraints",
      packet.constraints.map((c) => c.text),
    ) +
    section(
      "Results from earlier tasks",
      packet.upstream.map((u) => `${u.nodeId}: ${u.summary}`),
    ) +
    section(
      "Guidance from the reviewer on earlier attempts",
      packet.steering.map((s) => `attempt ${s.attempt}: ${s.note}`),
    ) +
    section("Orzeus will verify your work with", checkLines) +
    "When you are done, stop and summarize what you changed in one to three sentences.\n"
  );
}
