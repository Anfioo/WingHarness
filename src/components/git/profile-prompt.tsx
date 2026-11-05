import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIdentity, type IdentityProfile } from "@/features/git/identity/store";

interface ProfilePromptRequest {
  repoName: string;
  resolve: (profile: IdentityProfile | null) => void;
}

interface ProfilePromptState {
  request: ProfilePromptRequest | null;
  ask: (repoName: string) => Promise<IdentityProfile | null>;
  settle: (profile: IdentityProfile | null) => void;
}

const useProfilePromptStore = create<ProfilePromptState>((set, get) => ({
  request: null,
  ask: (repoName) =>
    new Promise<IdentityProfile | null>((resolve) => {
      get().request?.resolve(null);
      set({ request: { repoName, resolve } });
    }),
  settle: (profile) => {
    get().request?.resolve(profile);
    set({ request: null });
  },
}));

export function pickProfile(repoName: string): Promise<IdentityProfile | null> {
  return useProfilePromptStore.getState().ask(repoName);
}

export function ProfilePromptHost() {
  const { t } = useAppTranslation();
  const request = useProfilePromptStore((state) => state.request);
  const settle = useProfilePromptStore((state) => state.settle);
  const profiles = useIdentity((state) => state.profiles);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (request) firstRef.current?.focus();
  }, [request]);

  const repoName = request?.repoName ?? "";

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && settle(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("gitRepo.remote.profile.title", { repo: repoName })}</DialogTitle>
          <DialogDescription>{t("gitRepo.remote.profile.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {profiles.map((profile, index) => (
            <Button
              key={profile.id}
              ref={index === 0 ? firstRef : undefined}
              variant="ghost"
              className="h-auto justify-start px-3 py-2 text-left"
              onClick={() => settle(profile)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{profile.label}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {profile.name} &lt;{profile.email}&gt;
                </span>
              </span>
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(null)}>
            {t("gitRepo.remote.profile.notNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
