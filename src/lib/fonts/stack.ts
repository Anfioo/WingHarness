export const INTERFACE_FONT_DEFAULT = "Inter";
export const CODE_FONT_DEFAULT = "JetBrains Mono";

export function cleanFontFamily(family: string): string {
  return family.replace(/^["']|["']$/g, "").trim();
}

export function interfaceFontStack(family?: string | null): string {
  const name = family ? cleanFontFamily(family) : INTERFACE_FONT_DEFAULT;
  return `"${name}", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
}

export function monoFontStack(family?: string | null): string {
  const name = family ? cleanFontFamily(family) : CODE_FONT_DEFAULT;
  return `"${name}", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
}

export function applyFonts(input: {
  interfaceFontFamily: string | null;
  codeFontFamily: string | null;
}): void {
  const root = document.documentElement;
  root.style.setProperty("--font-sans", interfaceFontStack(input.interfaceFontFamily));
  root.style.setProperty("--font-mono", monoFontStack(input.codeFontFamily));
}
