import { useMemo } from "react";
import { encode } from "uqr";

/** `text` as a QR code, drawn as one SVG path with a quiet zone around it. */
export function Qr({ text, size = 168 }: { text: string; size?: number }) {
  const { path, modules } = useMemo(() => {
    const { data } = encode(text, { ecc: "M", border: 2 });
    const path = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("");
    return { path, modules: data.length };
  }, [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${modules} ${modules}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
