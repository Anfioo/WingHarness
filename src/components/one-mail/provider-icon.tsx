// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import alibabaCloudIcon from "@/assets/one-mail/provider-icons/alibabacloud.svg?raw";
import gmailIcon from "@/assets/one-mail/provider-icons/gmail.svg?raw";
import icloudIcon from "@/assets/one-mail/provider-icons/icloud.svg?raw";
import mailRuIcon from "@/assets/one-mail/provider-icons/maildotru.svg?raw";
import microsoftOutlookIcon from "@/assets/one-mail/provider-icons/microsoft-outlook.png";
import neteaseMailIcon from "@/assets/one-mail/provider-icons/netease-mail.png";
import qqIcon from "@/assets/one-mail/provider-icons/qq.svg?raw";
import sinaWeiboIcon from "@/assets/one-mail/provider-icons/sinaweibo.svg?raw";
import { cn } from "@/lib/utils";
import {
  getProviderLogoMetadata,
  normalizeProviderKey,
  providerKeyForAddress,
} from "@/lib/one-mail/provider-metadata";

/**
 * The bundled provider marks, keyed by normalized provider key.
 *
 * Simple Icons ships monochrome paths, so the brand colour is injected into the
 * SVG before it becomes a data URL. Outlook and NetEase are official favicons
 * and are used as-is.
 */
const PROVIDER_IMAGE_ICONS: Record<string, string | undefined> = {
  gmail: createBrandIconUrl(gmailIcon, "#EA4335"),
  qq: createBrandIconUrl(qqIcon, "#1EBAFC"),
  aliyun: createBrandIconUrl(alibabaCloudIcon, "#FF6A00"),
  aliyunEnterprise: createBrandIconUrl(alibabaCloudIcon, "#FF6A00"),
  icloud: createBrandIconUrl(icloudIcon, "#3693F3"),
  mailru: createBrandIconUrl(mailRuIcon, "#005FF9"),
  sina: createBrandIconUrl(sinaWeiboIcon, "#E6162D"),
  outlook: microsoftOutlookIcon,
  "163": neteaseMailIcon,
};

function createBrandIconUrl(source: string, color: string): string {
  const coloredSource = source.replace("<svg ", `<svg fill="${color}" `);
  return `data:image/svg+xml,${encodeURIComponent(coloredSource)}`;
}

/** The bundled mark for a provider key, or for an address's known domain. */
export function getProviderIconUrl(providerKey?: string, address?: string): string | undefined {
  const key = providerKey ? normalizeProviderKey(providerKey) : providerKeyForAddress(address);
  return key ? PROVIDER_IMAGE_ICONS[key] : undefined;
}

export interface ProviderIconProps {
  providerKey?: string;
  address?: string;
  /** `sm` is the 20px rail mark; `md` is the 24px form mark. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * One provider mark, or its fallback letter.
 *
 * A correspondent's address is used only when no provider key is available, so
 * a Gmail contact in the thread still gets the Gmail mark without a network
 * lookup.
 */
export default function ProviderIcon({
  providerKey,
  address,
  size = "sm",
  className,
}: ProviderIconProps) {
  const image = getProviderIconUrl(providerKey, address);
  const metadata = getProviderLogoMetadata(providerKey, address);

  return (
    <span
      aria-hidden
      className={cn(
        "bg-background ring-border/60 flex shrink-0 items-center justify-center overflow-hidden rounded-md ring-1",
        size === "sm" ? "size-5" : "size-6",
        className
      )}
    >
      {image ? (
        <img
          src={image}
          alt=""
          className={cn("object-contain", size === "sm" ? "size-4" : "size-5")}
        />
      ) : (
        <span
          className={cn(
            "text-muted-foreground font-semibold",
            size === "sm" ? "text-[10px] leading-none" : "text-[11px] leading-none"
          )}
        >
          {metadata.fallback}
        </span>
      )}
    </span>
  );
}
