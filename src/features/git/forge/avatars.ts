import { forgeProviderFor, useForge } from "./store";

const pending = new Map<string, Promise<string | null>>();

export function forgeAvatarFor(email: string, sha: string): Promise<string | null> | null {
  const { repoPath, remote, remoteUrl, hasAccount } = useForge.getState();
  if (!repoPath || !remote || !hasAccount) return null;
  const key = `${remoteUrl}|${email.trim().toLowerCase()}`;
  let promise = pending.get(key);
  if (!promise) {
    const provider = forgeProviderFor(repoPath, remote);
    if (!provider) return null;
    promise = provider.authorAvatar({ email, sha }).catch(() => null);
    pending.set(key, promise);
  }
  return promise;
}
