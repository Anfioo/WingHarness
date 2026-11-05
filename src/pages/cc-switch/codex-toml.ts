/// 极简 TOML 行编辑器：只处理本表单用到的「顶层 key」与「[section] 内 key」。
/// 不追求完整 TOML 语义，但对标准 config.toml（含注释、空行）足够，且对写入的
/// 值做转义，避免远端模型名里的引号破坏/注入配置。

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/\r?\n/);
}

/// 返回 section 的行区间 `[start, end)`：section 为 `null` 表示顶层（第一个
/// section 头之前）。找不到 section 时返回 `null`。
function region(lines: string[], section: string | null): { start: number; end: number } | null {
  if (section === null) {
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (SECTION_RE.test(lines[i])) {
        end = i;
        break;
      }
    }
    return { start: 0, end };
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_RE);
    if (m && m[1].trim() === section) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (SECTION_RE.test(lines[j])) {
          end = j;
          break;
        }
      }
      return { start: i + 1, end };
    }
  }
  return null;
}

function escapeBasic(s: string): string {
  // 先按字符码剥掉控制字符（避免 no-control-regex），再转义引号/反斜杠。
  const cleaned = Array.from(s)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  return cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function keyPattern(key: string): RegExp {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${esc}\\s*=`);
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

/// 读取 `section` 内 `key` 的值（section 为 null 表示顶层）；不存在返回 ""。
export function getTomlValue(text: string, section: string | null, key: string): string {
  const lines = splitLines(text);
  const r = region(lines, section);
  if (!r) return "";
  const re = keyPattern(key);
  for (let i = r.start; i < r.end; i++) {
    if (re.test(lines[i])) {
      const eq = lines[i].indexOf("=");
      return unquote(lines[i].slice(eq + 1));
    }
  }
  return "";
}

/// 写入/删除 `section` 内 `key`：值非空写入，空则删除该键；section 不存在时按需新建。
export function setTomlValue(
  text: string,
  section: string | null,
  key: string,
  value: string
): string {
  const lines = splitLines(text);
  const r = region(lines, section);
  const re = keyPattern(key);
  const v = value.trim();

  if (r) {
    for (let i = r.start; i < r.end; i++) {
      if (re.test(lines[i])) {
        if (!v) lines.splice(i, 1);
        else lines[i] = `${key} = "${escapeBasic(v)}"`;
        return lines.join("\n");
      }
    }
    if (v) {
      // 顶层插在第一个 section 之前；section 内插在头行之后。
      const insertAt = section === null ? r.end : r.start;
      lines.splice(insertAt, 0, `${key} = "${escapeBasic(v)}"`);
    }
    return lines.join("\n");
  }

  // section 不存在：仅非空值时新建。
  if (!v) return lines.join("\n");
  if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push(`[${section}]`, `${key} = "${escapeBasic(v)}"`);
  return lines.join("\n");
}
