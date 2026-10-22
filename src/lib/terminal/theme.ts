import type { ITheme } from "@xterm/xterm";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const FALLBACK_DARK: ITheme = {
  background: "#0d1220",
  foreground: "#e2e6ef",
  cursor: "#d97706",
};

const FALLBACK_LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#1a2233",
  cursor: "#d97706",
};

const HSL_TRIPLET = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/;
const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i;
const HEX = /^#([0-9a-f]{6})$/i;

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const hue = (((h % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((hue % 2) - 1));
  let raw: [number, number, number];
  if (hue < 1) raw = [chroma, second, 0];
  else if (hue < 2) raw = [second, chroma, 0];
  else if (hue < 3) raw = [0, chroma, second];
  else if (hue < 4) raw = [0, second, chroma];
  else if (hue < 5) raw = [second, 0, chroma];
  else raw = [chroma, 0, second];
  const offset = light - chroma / 2;
  return {
    r: Math.min(1, Math.max(0, raw[0] + offset)),
    g: Math.min(1, Math.max(0, raw[1] + offset)),
    b: Math.min(1, Math.max(0, raw[2] + offset)),
  };
}

function rgbToHsl(rgb: Rgb): Hsl {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: light * 100 };
  const sat = delta / (1 - Math.abs(2 * light - 1));
  let hue: number;
  if (max === rgb.r) hue = ((rgb.g - rgb.b) / delta) % 6;
  else if (max === rgb.g) hue = (rgb.b - rgb.r) / delta + 2;
  else hue = (rgb.r - rgb.g) / delta + 4;
  return { h: hue * 60, s: sat * 100, l: light * 100 };
}

function oklchToRgb(light: number, chroma: number, hue: number): Rgb {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (light + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (light - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (light - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (value: number) =>
    value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return {
    r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function parseColor(raw: string): Rgb | null {
  const hsl = raw.match(HSL_TRIPLET);
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  const oklch = raw.match(OKLCH);
  if (oklch) {
    const light = oklch[2] ? Number(oklch[1]) / 100 : Number(oklch[1]);
    return oklchToRgb(light, Number(oklch[3]), Number(oklch[4]));
  }
  const hex = raw.match(HEX);
  if (hex) {
    return {
      r: parseInt(hex[1].slice(0, 2), 16) / 255,
      g: parseInt(hex[1].slice(2, 4), 16) / 255,
      b: parseInt(hex[1].slice(4, 6), 16) / 255,
    };
  }
  return null;
}

function channel(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function toHex(rgb: Rgb, alpha?: number): string {
  const base = `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
  if (alpha === undefined) return base;
  const r = Math.round(Math.min(1, Math.max(0, rgb.r)) * 255);
  const g = Math.round(Math.min(1, Math.max(0, rgb.g)) * 255);
  const b = Math.round(Math.min(1, Math.max(0, rgb.b)) * 255);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

function shiftLightness(rgb: Rgb, amount: number): Rgb {
  const hsl = rgbToHsl(rgb);
  return hslToRgb(hsl.h, hsl.s, Math.min(96, Math.max(4, hsl.l + amount)));
}

export function terminalThemeFromTokens(): ITheme {
  if (typeof document === "undefined") return FALLBACK_DARK;
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const style = getComputedStyle(root);
  const token = (name: string) => {
    const raw = style.getPropertyValue(name).trim();
    return raw ? parseColor(raw) : null;
  };

  const surface = token("--card");
  const foreground = token("--foreground");
  if (!surface || !foreground) return dark ? FALLBACK_DARK : FALLBACK_LIGHT;

  const primary = token("--primary") ?? { r: 0.85, g: 0.55, b: 0.1 };
  const muted = token("--muted-foreground") ?? foreground;
  const faint = token("--faint-foreground") ?? muted;
  const raised = token("--accent") ?? surface;
  const danger = token("--destructive") ?? { r: 0.85, g: 0.2, b: 0.2 };
  const success = token("--success") ?? { r: 0.1, g: 0.65, b: 0.3 };
  const info = token("--info") ?? { r: 0.1, g: 0.55, b: 0.85 };
  const yellow = token("--graph-6") ?? { r: 0.95, g: 0.7, b: 0.1 };
  const magenta = token("--graph-7") ?? { r: 0.7, g: 0.3, b: 0.85 };
  const cyan = token("--graph-5") ?? { r: 0.2, g: 0.75, b: 0.7 };
  const brightStep = dark ? 10 : -8;

  return {
    background: toHex(surface),
    foreground: toHex(foreground),
    cursor: toHex(primary),
    cursorAccent: toHex(surface),
    selectionBackground: toHex(primary, 0.3),
    selectionInactiveBackground: toHex(primary, 0.18),
    black: toHex(dark ? raised : foreground),
    brightBlack: toHex(faint),
    red: toHex(danger),
    brightRed: toHex(shiftLightness(danger, brightStep)),
    green: toHex(success),
    brightGreen: toHex(shiftLightness(success, brightStep)),
    yellow: toHex(yellow),
    brightYellow: toHex(shiftLightness(yellow, brightStep)),
    blue: toHex(info),
    brightBlue: toHex(shiftLightness(info, brightStep)),
    magenta: toHex(magenta),
    brightMagenta: toHex(shiftLightness(magenta, brightStep)),
    cyan: toHex(cyan),
    brightCyan: toHex(shiftLightness(cyan, brightStep)),
    white: toHex(dark ? muted : raised),
    brightWhite: toHex(dark ? foreground : surface),
  };
}
