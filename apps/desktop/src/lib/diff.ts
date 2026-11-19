export interface DiffCell {
  readonly line: number | null;
  readonly text: string;
  readonly kind: "context" | "removed" | "added" | "empty";
}

export interface DiffRow {
  readonly left: DiffCell;
  readonly right: DiffCell;
}

export interface DiffFile {
  readonly path: string;
  readonly rows: readonly DiffRow[];
  readonly binary: boolean;
}

const empty: DiffCell = { line: null, text: "", kind: "empty" };

/**
 * Turns a unified diff (git diff output) into side-by-side rows per file. Removed and added
 * runs inside a hunk are paired row by row, so edits line up; hunk gaps become separator rows.
 */
export function toSideBySide(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let rows: DiffRow[] = [];
  let path = "";
  let binary = false;
  let leftLine = 0;
  let rightLine = 0;
  let removed: DiffCell[] = [];
  let added: DiffCell[] = [];

  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) rows.push({ left: removed[i] ?? empty, right: added[i] ?? empty });
    removed = [];
    added = [];
  };
  const finishFile = () => {
    flush();
    if (path !== "") files.push({ path, rows, binary });
    rows = [];
    binary = false;
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      finishFile();
      path = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)?.[2] ?? raw.slice(11);
      continue;
    }
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk !== null) {
      flush();
      if (rows.length > 0)
        rows.push({
          left: { line: null, text: "⋯", kind: "empty" },
          right: { line: null, text: "⋯", kind: "empty" },
        });
      leftLine = Number(hunk[1]);
      rightLine = Number(hunk[2]);
      continue;
    }
    if (
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("\\")
    )
      continue;
    if (raw.startsWith("-"))
      removed.push({ line: leftLine++, text: raw.slice(1), kind: "removed" });
    else if (raw.startsWith("+"))
      added.push({ line: rightLine++, text: raw.slice(1), kind: "added" });
    else if (raw.startsWith(" ")) {
      flush();
      rows.push({
        left: { line: leftLine++, text: raw.slice(1), kind: "context" },
        right: { line: rightLine++, text: raw.slice(1), kind: "context" },
      });
    }
  }
  finishFile();
  return files;
}
