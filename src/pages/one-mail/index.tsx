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
import MailStatusBar from "@/components/one-mail/mail-status-bar";
import OutboxPanel from "@/components/one-mail/outbox-panel";
import RawMessageDialog from "@/components/one-mail/raw-message-dialog";
import { useOneMailPage } from "@/hooks/use-one-mail-page";
import { OneMailPageProvider } from "./context";
import "@/components/one-mail/one-mail.css";

/**
 * The mail workspace: the account rail, the person list and the thread, plus
 * the status bar at the foot. The page is full-bleed inside the app shell so
 * the three lanes own the whole content area; the overlays (compose, account
 * form, raw message and outbox) stay inside the page and open no windows.
 */
export default function OneMailPage() {
  const page = useOneMailPage();

  return (
    <OneMailPageProvider value={page}>
      <AppShell>
        <div
          data-workspace="one-mail"
          className="bg-background -m-6 flex h-[calc(100%+3rem)] min-h-0 w-[calc(100%+3rem)] flex-col overflow-hidden"
        >
          {page.error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive shrink-0 border-b px-3 py-1.5 text-xs"
            >
              {page.error}
            </div>
          )}

          <div className="flex min-h-0 min-w-0 flex-1">
            <Group id="one-mail-workspace" className="min-h-0 flex-1">
              <Panel
                id="one-mail-accounts"
                defaultSize={260}
                minSize={220}
                maxSize={420}
                groupResizeBehavior="preserve-pixel-size"
                className="min-w-0 overflow-hidden"
              >
                <AccountRail />
              </Panel>
              <Separator className="bg-border w-px" />
              <Panel
                id="one-mail-conversations"
                defaultSize={304}
                minSize={260}
                maxSize={440}
                groupResizeBehavior="preserve-pixel-size"
                className="min-w-0 overflow-hidden"
              >
                <ConversationList />
              </Panel>
              <Separator className="bg-border w-px" />
              <Panel id="one-mail-thread" minSize={0} className="min-w-0 overflow-hidden">
                <ConversationPane />
              </Panel>
            </Group>
          </div>

          <MailStatusBar />
        </div>

        <ComposerDialog />
        <AccountDialog />
        <RawMessageDialog />
        <OutboxPanel />
      </AppShell>
    </OneMailPageProvider>
  );
}
