/** Hooks and small building blocks shared by the popup and options page. */
import { useEffect, useState, type ReactNode } from "react";
import type { WxtStorageItem } from "wxt/utils/storage";
import { MARK, markWaves } from "../lib/mark.ts";

/** Current value of a storage item, kept live across pages. `undefined` while loading. */
export function useStored<T>(item: WxtStorageItem<T, Record<string, unknown>>): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    void item.getValue().then(setValue);
    return item.watch((next) => setValue(next));
  }, [item]);
  return value;
}

/** Wraps an async action with pending and error state for buttons and forms. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (...args: A) => {
    setPending(true);
    setError(undefined);
    try {
      await fn(...args);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error };
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export const hostname = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const wavePaths = markWaves(48).map((points) => `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}`);

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${MARK.size} ${MARK.size}`} aria-hidden="true">
      <rect width={MARK.size} height={MARK.size} rx={MARK.radius} fill="var(--accent)" />
      {wavePaths.map((d) => (
        <path key={d} d={d} fill="none" stroke="var(--accent-contrast)" strokeWidth={MARK.stroke} strokeLinecap="round" />
      ))}
    </svg>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "danger"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export const ErrorText = ({ error }: { error: string | undefined }) => (error ? <p className="error">{error}</p> : null);
