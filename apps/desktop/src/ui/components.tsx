import type { ButtonHTMLAttributes, ReactNode } from "react";
import { toSideBySide } from "../lib/diff.ts";
import { statusLabel, statusTone } from "../lib/format.ts";
import styles from "./components.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "default" | "quiet" | "danger";
};

export function Button({ variant = "default", className, type = "button", ...rest }: ButtonProps) {
  const variantClass = variant === "default" ? "" : styles[variant];
  return (
    <button
      type={type}
      className={[styles.button, variantClass, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export function StatusPill({
  status,
  label,
}: {
  readonly status: string;
  readonly label?: string;
}) {
  return (
    <span className={styles.pill} data-tone={statusTone(status)}>
      {label ?? statusLabel(status)}
    </span>
  );
}

export function Pill({
  tone = "neutral",
  children,
}: {
  readonly tone?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className={styles.pill} data-tone={tone}>
      {children}
    </span>
  );
}

export function Panel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={[styles.panel, className].filter(Boolean).join(" ")}>{children}</section>
  );
}

export function Empty({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as a child
    <label className={styles.field}>
      {label}
      {children}
    </label>
  );
}

export const inputClass: string = styles.input ?? "";

/** Side-by-side diff of a unified patch. */
export function DiffView({ patch }: { readonly patch: string }) {
  const files = toSideBySide(patch);
  if (files.length === 0) return <p>No changes.</p>;
  return (
    <div>
      {files.map((file) => (
        <div key={file.path} className={styles.diff} style={{ marginBottom: 12 }}>
          <div className={styles.diffFile}>{file.path}</div>
          {file.binary ? (
            <p style={{ padding: 12 }}>Binary file changed.</p>
          ) : file.rows.every((r) => r.left.kind === "empty") ||
            file.rows.every((r) => r.right.kind === "empty") ? (
            // A new or deleted file: one column reads better than half an empty table.
            <table className={styles.diffTable}>
              <caption className="visually-hidden">
                {file.rows.every((r) => r.left.kind === "empty") ? "New file" : "Deleted file"}{" "}
                {file.path}
              </caption>
              <colgroup>
                <col style={{ width: 44 }} />
                <col />
              </colgroup>
              <tbody>
                {file.rows.map((row, i) => {
                  const cell = row.left.kind === "empty" ? row.right : row.left;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides position
                    <tr key={i}>
                      <td className={styles.num}>{cell.line ?? ""}</td>
                      <td data-kind={cell.kind}>{cell.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className={styles.diffTable}>
              <caption className="visually-hidden">
                Changes to {file.path}: before on the left, after on the right
              </caption>
              <tbody>
                {file.rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides position
                  <tr key={i}>
                    <td className={styles.num}>{row.left.line ?? ""}</td>
                    <td data-kind={row.left.kind}>{row.left.text}</td>
                    <td className={`${styles.num} ${styles.split}`}>{row.right.line ?? ""}</td>
                    <td data-kind={row.right.kind}>{row.right.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
