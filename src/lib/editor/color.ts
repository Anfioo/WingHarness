/**
 * Colour arithmetic for the shell theme.
 *
 * The app paints with whatever notation a preset uses — `oklch()`, `hsl()`,
 * `color-mix()` — but codelet builds derived colours by string concatenation
 * (`${bg}d9`, `${panel}14`), which only reads an alpha channel onto a hex
 * literal. So a colour has to arrive at a `Theme` as `#rrggbb`, and this is
 * where it gets there.
 */

const canvas = document.createElement("canvas");
canvas.width = 1;
canvas.height = 1;

/** Each value is re-read on every rebuild, and the parse is not free. */
const parsed = new Map<string, string>();

/**
 * `value` as `#rrggbb`, or `#rrggbbaa` when it carries alpha. Empty when the
 * browser cannot make sense of it.
 *
 * The parser is the browser's own: fill one pixel and read the bytes back. That
 * covers every notation the engine can paint without a parser to maintain here,
 * but it does not follow `var()` — resolve a custom property through
 * `getComputedStyle` before handing it over.
 */
export function toHex(value: string): string {
  const cached = parsed.get(value);
  if (cached !== undefined) return cached;
  const hex = measure(value);
  parsed.set(value, hex);
  return hex;
}

function measure(value: string): string {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "";
  context.clearRect(0, 0, 1, 1);
  // Transparent first, not black: a value the engine rejects leaves the previous
  // `fillStyle` standing, so the pixel stays clear and the failure reads as "no
  // colour" instead of passing for a real one.
  context.fillStyle = "transparent";
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  if (a === 0) return "";
  const channel = (n: number) => n.toString(16).padStart(2, "0");
  const rgb = `#${channel(r)}${channel(g)}${channel(b)}`;
  return a === 255 ? rgb : `${rgb}${channel(a)}`;
}

/** `t` of the way from `from` to `to`, per channel in sRGB, always opaque. */
export function mix(from: string, to: string, t: number): string {
  const [fr, fg, fb] = channels(from);
  const [tr, tg, tb] = channels(to);
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  const channel = (n: number) => n.toString(16).padStart(2, "0");
  return `#${channel(lerp(fr, tr))}${channel(lerp(fg, tg))}${channel(lerp(fb, tb))}`;
}

/** The three bytes of a `#rrggbb`; an unreadable input counts as black. */
function channels(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1, 7), 16) || 0;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
