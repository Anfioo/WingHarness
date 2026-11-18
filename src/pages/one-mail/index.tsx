// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Group, Panel, Separator } from "react-resizable-panels";
import { AppShell } from "@/components/app-shell";
import AccountDialog from "@/components/one-mail/account-dialog";
import AccountRail from "@/components/one-mail/account-rail";
import ComposerDialog from "@/components/one-mail/composer-dialog";
import ConversationList from "@/components/one-mail/conversation-list";
import ConversationPane from "@/components/one-mail/conversation-pane";
import OutboxPanel from "@/components/one-mail/outbox-panel";
import RawMessageDialog from "@/components/one-mail/raw-message-dialog";
import SyncBadge from "@/components/one-mail/sync-badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useOneMailPage } from "@/hooks/use-one-mail-page";
import { OneMailPageProvider } from "./context";

/**
 * The one-mail page shell: the header and the three resizable lanes around the
 * page hook. The overlays (compose, account form, raw message, outbox) stay
 * inside the page; no window is opened.
 */
export default function OneMailPage() {
  const { t } = useAppTranslation();
  const page = useOneMailPage();

  return (
    <OneMailPageProvider value={page}>
      <AppShell>
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
          <header className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">{t("oneMail.title")}</h1>
              <p className="text-muted-foreground text-sm">{t("oneMail.subtitle")}</p>
            </div>
            <SyncBadge />
          </header>

          {page.error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
            >
              {page.error}
            </div>
          )}

          <div className="flex min-h-0 min-w-0 flex-1">
            <Group id="one-mail-workspace" className="min-h-0 flex-1">
              <Panel
                id="one-mail-accounts"
                defaultSize="18"
                minSize="12"
                className="min-w-0 overflow-hidden"
              >
                <AccountRail />
              </Panel>
              <Separator className="bg-border w-px" />
              <Panel
                id="one-mail-conversations"
                defaultSize="30"
                minSize="18"
                className="min-w-0 overflow-hidden"
              >
                <ConversationList />
              </Panel>
              <Separator className="bg-border w-px" />
              <Panel id="one-mail-thread" minSize="0" className="min-w-0 overflow-hidden">
                <ConversationPane />
              </Panel>
            </Group>
          </div>

          <ComposerDialog />
          <AccountDialog />
          <RawMessageDialog />
          <OutboxPanel />
        </div>
      </AppShell>
    </OneMailPageProvider>
  );
}
