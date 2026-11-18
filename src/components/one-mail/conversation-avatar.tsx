// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import type { ConversationParticipant } from "@/commands";
import { avatarTone, initialsFor } from "@/lib/one-mail/avatar";
import { cn } from "@/lib/utils";
import { getProviderIconUrl } from "./provider-icon";

export interface ConversationAvatarProps {
  /** The address that decides the mark, or a stable conversation key. */
  seed: string;
  /** More than one member renders a small group grid instead of one mark. */
  members?: ConversationParticipant[];
  outgoing?: boolean;
  compact?: boolean;
}

/**
 * One correspondent's avatar: a bundled provider mark when the domain is known,
 * otherwise the initials on a stable tint. Outgoing messages use the warmer
 * bubble tint so the reader can tell the two sides apart at a glance.
 */
export default function ConversationAvatar({
  seed,
  members,
  outgoing = false,
  compact = false,
}: ConversationAvatarProps) {
  const imageUrl = getProviderIconUrl(undefined, seed);
  const fallback =
    members && members.length > 1 ? (
      <GroupAvatar members={members} />
    ) : (
      <span
        className={cn(
          "flex size-full items-center justify-center rounded text-[13px] font-semibold",
          avatarTone(seed || "unknown")
        )}
      >
        {initialsFor(null, seed)}
      </span>
    );

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded",
        compact ? "size-9" : "size-10",
        outgoing ? "bg-sky-500/15" : "bg-muted",
        !imageUrl && !members?.length && "bg-transparent"
      )}
    >
      {imageUrl ? (
        <span className="flex size-full items-center justify-center rounded bg-white p-1.5 ring-1 ring-black/5 dark:bg-white/90">
          <img src={imageUrl} alt="" className="size-full object-contain" />
        </span>
      ) : (
        fallback
      )}
    </span>
  );
}

/** A 2×2 grid of the first four participants' marks. */
function GroupAvatar({ members }: { members: ConversationParticipant[] }) {
  const visible = members.slice(0, 4);
  return (
    <span className="bg-muted flex size-full flex-col items-center justify-center gap-[2px] overflow-hidden rounded p-[3px]">
      {[0, 2].map((start) => {
        const row = visible.slice(start, start + 2);
        if (row.length === 0) return null;
        return (
          <span key={start} className="flex justify-center gap-[2px]">
            {row.map((member) => {
              const image = getProviderIconUrl(undefined, member.email);
              return (
                <span
                  key={member.email}
                  className="flex size-[13px] shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-white"
                >
                  {image ? (
                    <img src={image} alt="" className="size-[11px] object-contain" />
                  ) : (
                    <span
                      className={cn(
                        "flex size-full items-center justify-center text-[7px] font-semibold",
                        avatarTone(member.email || "unknown")
                      )}
                    >
                      {initialsFor(member.name, member.email)}
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        );
      })}
    </span>
  );
}
