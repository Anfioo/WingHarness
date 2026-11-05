import { configGet, configSet } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { pickProfile } from "@/components/git/profile-prompt";
import { useIdentity, type IdentityProfile } from "./store";

export function serializeAccountBindings(accounts: Record<string, string> | undefined): string {
  return Object.entries(accounts ?? {})
    .map(([host, username]) => `${host}=${username}`)
    .join(",");
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function applyProfileToRepo(
  repoPath: string,
  profile: IdentityProfile,
  opts?: { preserveIdentity?: boolean }
): Promise<void> {
  if (!opts?.preserveIdentity) {
    await configSet("user.name", profile.name, false, repoPath);
    await configSet("user.email", profile.email, false, repoPath);
  }
  await configSet("git.profile", profile.id, false, repoPath);
  await configSet("git.accounts", serializeAccountBindings(profile.accounts), false, repoPath);
  const repoState = useRepo.getState();
  if (repoState.repo?.path === repoPath) repoState.setProfileId(profile.id);
}

export async function ensureRepoProfile(repoPath: string): Promise<IdentityProfile | null> {
  const { profiles } = useIdentity.getState();
  if (profiles.length === 0) return null;
  const repoState = useRepo.getState();
  const assignedId =
    (repoState.repo?.path === repoPath ? repoState.profileId : null) ??
    ((await configGet("git.profile", repoPath)) as string | null);
  if (assignedId) {
    const assigned = profiles.find((profile) => profile.id === assignedId);
    if (assigned) return assigned;
  }
  if (profiles.length === 1) {
    const [repoEmail, globalEmail] = await Promise.all([
      configGet("user.email", repoPath),
      configGet("user.email"),
    ]);
    const manualIdentity = repoEmail !== null && repoEmail !== globalEmail;
    await applyProfileToRepo(repoPath, profiles[0], { preserveIdentity: manualIdentity });
    return profiles[0];
  }
  const chosen = await pickProfile(basename(repoPath));
  if (chosen) await applyProfileToRepo(repoPath, chosen);
  return chosen;
}
