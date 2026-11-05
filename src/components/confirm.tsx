import { useRef } from "react";
import { create } from "zustand";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  description: string;
  path?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

interface ConfirmState {
  request: (ConfirmOptions & { resolve: (value: boolean) => void }) | null;
  ask: (options: ConfirmOptions) => Promise<boolean>;
  settle: (value: boolean) => void;
}

let confirmReturnFocus: HTMLElement | null = null;

const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  ask: (options) =>
    new Promise<boolean>((resolve) => {
      if (!get().request) {
        const active = document.activeElement;
        confirmReturnFocus = active instanceof HTMLElement ? active : null;
      }
      get().request?.resolve(false);
      set({ request: { ...options, resolve } });
    }),
  settle: (value) => {
    get().request?.resolve(value);
    set({ request: null });
    const target = confirmReturnFocus;
    confirmReturnFocus = null;
    if (target && document.contains(target)) {
      requestAnimationFrame(() => target.focus());
    }
  },
}));

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(options);
}

function PathBlock({ path }: { path: string }) {
  const segments = path.split("/");
  const name = segments.pop() ?? path;
  return (
    <p className="border-border bg-muted mt-1 max-h-32 overflow-y-auto rounded-md border px-2 py-1.5 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
      {segments.map((segment, index) => (
        <span key={index} className="text-muted-foreground">
          {segment}/<wbr />
        </span>
      ))}
      <span className="text-foreground">{name}</span>
    </p>
  );
}

export function ConfirmHost() {
  const { request, settle } = useConfirmStore();
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && settle(false)}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          confirmRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {request?.destructive && <AlertTriangle className="text-destructive size-4 shrink-0" />}
            {request?.title}
          </DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
          {request?.path && <PathBlock path={request.path} />}
        </DialogHeader>
        <DialogFooter className="flex-wrap">
          <Button variant="ghost" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={request?.destructive ? "destructive" : "default"}
            className="max-w-full min-w-0"
            onClick={() => settle(true)}
          >
            <span className="min-w-0 truncate">{request?.confirmLabel ?? "Confirm"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
