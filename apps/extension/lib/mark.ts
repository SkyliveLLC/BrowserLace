/**
 * The BrowserLace mark: two sine waves crossing like a lace, in a 32x32 box. Shared by the
 * in-page logo and the PNG icon generator so they stay identical.
 */
export const MARK = { size: 32, radius: 8, stroke: 2.6, from: 6.5, to: 25.5, amplitude: 4.5, eyes: 3 };

/** Points along both waves, `steps` per wave. */
export function markWaves(steps = 96): [number, number][][] {
  const { from, to, amplitude, eyes, size } = MARK;
  return [1, -1].map((sign) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const x = from + ((to - from) * i) / steps;
      return [x, size / 2 + sign * amplitude * Math.sin((Math.PI * eyes * (x - from)) / (to - from))];
    }),
  );
}
