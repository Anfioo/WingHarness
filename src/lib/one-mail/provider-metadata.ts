// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

/**
 * Provider keys as the account rail groups them.
 *
 * The backend keeps its own key table; this module only maps a stored key onto
 * the normalized key used for grouping, labels and bundled logos. A key that
 * matches nothing keeps its lowercased form, so a custom provider still gets a
 * stable group of its own.
 */
export type NormalizedProviderKey =
  | "gmail"
  | "yahoo"
  | "outlook"
  | "163"
  | "qq"
  | "tencentEnterprise"
  | "aliyun"
  | "aliyunEnterprise"
  | "189"
  | "sohu"
  | "sina"
  | "139"
  | "21cn"
  | "perfect"
  | "icloud"
  | "aol"
  | "yandex"
  | "mailru"
  | "custom"
  | "manual"
  | string;

export interface ProviderLogoMetadata {
  domain: string;
  fallback: string;
}

const PROVIDER_LOGO_METADATA: Record<string, ProviderLogoMetadata> = {
  gmail: { domain: "gmail.com", fallback: "G" },
  yahoo: { domain: "yahoo.com", fallback: "Y" },
  outlook: { domain: "outlook.com", fallback: "O" },
  "163": { domain: "163.com", fallback: "易" },
  qq: { domain: "qq.com", fallback: "Q" },
  tencentEnterprise: { domain: "exmail.qq.com", fallback: "企" },
  aliyun: { domain: "aliyun.com", fallback: "阿" },
  aliyunEnterprise: { domain: "qiye.aliyun.com", fallback: "企" },
  "189": { domain: "189.cn", fallback: "天" },
  sohu: { domain: "sohu.com", fallback: "狐" },
  sina: { domain: "sina.com", fallback: "新" },
  "139": { domain: "139.com", fallback: "移" },
  "21cn": { domain: "21cn.com", fallback: "21" },
  perfect: { domain: "88.com", fallback: "88" },
  icloud: { domain: "icloud.com", fallback: "i" },
  aol: { domain: "aol.com", fallback: "A" },
  yandex: { domain: "yandex.com", fallback: "Y" },
  mailru: { domain: "mail.ru", fallback: "M" },
};

/** The i18n key naming a provider group. */
export const PROVIDER_LABEL_KEYS: Record<string, string> = {
  gmail: "oneMail.providers.gmail",
  yahoo: "oneMail.providers.yahoo",
  outlook: "oneMail.providers.outlook",
  "163": "oneMail.providers.netease",
  qq: "oneMail.providers.qq",
  tencentEnterprise: "oneMail.providers.tencentEnterprise",
  aliyun: "oneMail.providers.aliyun",
  aliyunEnterprise: "oneMail.providers.aliyunEnterprise",
  "189": "oneMail.providers.ct189",
  sohu: "oneMail.providers.sohu",
  sina: "oneMail.providers.sina",
  "139": "oneMail.providers.cm139",
  "21cn": "oneMail.providers.cn21",
  perfect: "oneMail.providers.perfect",
  icloud: "oneMail.providers.icloud",
  aol: "oneMail.providers.aol",
  yandex: "oneMail.providers.yandex",
  mailru: "oneMail.providers.mailru",
  custom: "oneMail.providers.custom",
  manual: "oneMail.providers.custom",
};

export function normalizeProviderKey(providerKey?: string): NormalizedProviderKey {
  if (!providerKey) return "custom";

  const normalized = providerKey.trim().toLowerCase();
  if (!normalized) return "custom";
  if (normalized.includes("gmail") || normalized.includes("google")) return "gmail";
  if (normalized.includes("yahoo")) return "yahoo";
  if (
    normalized.includes("outlook") ||
    normalized.includes("hotmail") ||
    normalized.includes("live.com") ||
    normalized.includes("office365") ||
    normalized.includes("microsoft")
  ) {
    return "outlook";
  }
  if (
    normalized.includes("163") ||
    normalized.includes("126") ||
    normalized.includes("yeah") ||
    normalized.includes("netease")
  ) {
    return "163";
  }
  if (
    normalized.includes("tencent_enterprise") ||
    normalized.includes("tencententerprise") ||
    normalized.includes("exmail")
  ) {
    return "tencentEnterprise";
  }
  if (normalized.includes("qq") || normalized.includes("foxmail")) return "qq";
  if (
    normalized.includes("aliyun_enterprise") ||
    normalized.includes("alibaba") ||
    normalized.includes("qiye.aliyun")
  ) {
    return "aliyunEnterprise";
  }
  if (normalized.includes("aliyun")) return "aliyun";
  if (normalized.includes("189")) return "189";
  if (normalized.includes("sohu")) return "sohu";
  if (normalized.includes("sina")) return "sina";
  if (normalized.includes("139")) return "139";
  if (normalized.includes("21cn")) return "21cn";
  if (
    normalized.includes("perfect") ||
    normalized.includes("88.com") ||
    normalized.includes("111.com") ||
    normalized.includes("email.cn")
  ) {
    return "perfect";
  }
  if (
    normalized.includes("icloud") ||
    normalized.includes("me.com") ||
    normalized.includes("mac.com")
  ) {
    return "icloud";
  }
  if (normalized.includes("aol")) return "aol";
  if (normalized.includes("yandex")) return "yandex";
  if (normalized.includes("mailru") || normalized.includes("mail.ru")) return "mailru";
  if (normalized.includes("custom")) return "custom";
  if (normalized.includes("manual")) return "manual";

  return normalized;
}

export function getProviderLogoMetadata(
  providerKey?: string,
  address?: string
): ProviderLogoMetadata {
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const metadata = PROVIDER_LOGO_METADATA[normalizedProviderKey];
  if (metadata) return metadata;

  const domain = getEmailDomain(address);
  return {
    domain,
    fallback: getFallbackLabel(domain || providerKey || address || "mail"),
  };
}

export function getProviderLabelKey(providerKey?: string): string {
  const normalized = normalizeProviderKey(providerKey);
  return PROVIDER_LABEL_KEYS[normalized] ?? "oneMail.providers.custom";
}

export function getEmailDomain(address?: string): string {
  return address?.split("@")[1]?.trim().toLowerCase() || "";
}

function getFallbackLabel(value: string): string {
  const compact = value.trim();
  if (!compact) return "M";

  const first = compact.replace(/^www\./, "").charAt(0);
  return first ? first.toUpperCase() : "M";
}

/**
 * A bundled logo for a correspondent's address, when the domain is one of the
 * providers this app already ships an icon for. Unknown domains fall back to
 * initials in the avatar component.
 */
export function providerKeyForAddress(address?: string): string | null {
  const domain = getEmailDomain(address);
  if (!domain) return null;
  if (domain === "gmail.com" || domain === "googlemail.com") return "gmail";
  if (domain === "qq.com" || domain === "foxmail.com") return "qq";
  if (domain === "163.com" || domain === "126.com" || domain === "yeah.net") return "163";
  if (domain === "outlook.com" || domain === "hotmail.com" || domain === "live.com") {
    return "outlook";
  }
  if (domain === "icloud.com" || domain === "me.com" || domain === "mac.com") return "icloud";
  if (domain === "sina.com" || domain === "sina.cn") return "sina";
  if (domain === "aliyun.com") return "aliyun";
  if (domain === "mail.ru") return "mailru";
  return null;
}
