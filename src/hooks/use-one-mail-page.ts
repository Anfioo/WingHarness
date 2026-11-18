// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { toast } from "sonner";
import {
  oneMailAccountsList,
  oneMailComposeForwardDraft,
  oneMailComposePickAttachments,
  oneMailComposeReplyDraft,
  oneMailComposeRetry,
  oneMailComposeSaveDraft,
  oneMailComposeSend,
  oneMailConversationMessages,
  oneMailConversationsList,
  oneMailErrorCode,
  oneMailFoldersList,
  oneMailMessageBodyLoad,
  oneMailMessageSetRead,
  oneMailMessageSetStarred,
  oneMailOutboxDelete,
  oneMailOutboxGet,
  oneMailOutboxList,
  oneMailSettingsGet,
  oneMailSyncCancel,
  oneMailSyncStart,
  oneMailSyncStatus,
  type AccountSummary,
  type ComposeKind,
  type ConversationSummary,
  type ConversationThread,
  type Draft,
  type DraftInput,
  type MailFolder,
  type MessageBodyLoad,
  type MessageSummary,
  type NewMailPayload,
  type OneMailSettings,
  type OutboxItem,
  type PickedAttachment,
  type OneMailSyncStatus,
  type SendInput,
  type SendResult,
  type SyncProgressPayload,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { oneMailErrorKey } from "@/lib/one-mail/error-key";
import { usePageActive } from "@/lib/page-active";

/**
 * The one-mail IPC event names. Every subscriber imports these instead of
 * spelling the string again.
 */
export const ONE_MAIL_SYNC_PROGRESS_EVENT = "one-mail:sync-progress";
export const ONE_MAIL_NEW_MAIL_EVENT = "one-mail:new-mail";
export const ONE_MAIL_MAILBOX_CHANGED_EVENT = "one-mail:mailbox-changed";
export const ONE_MAIL_ACCOUNTS_CHANGED_EVENT = "one-mail:accounts-changed";
export const ONE_MAIL_OUTBOX_CHANGED_EVENT = "one-mail:outbox-changed";
export const ONE_MAIL_SETTINGS_CHANGED_EVENT = "one-mail:settings-changed";

export type OneMailFilters = {
  unreadOnly: boolean;
  starredOnly: boolean;
  range: "all" | "today" | "yesterday" | "last7days";
};

export type OneMailPageState = {
  loading: boolean;
  error: string | null;
  settings: OneMailSettings | null;
  accounts: AccountSummary[];
  folders: MailFolder[];
  selectedAccountId: number | null;
  selectAccount: (accountId: number | null) => void;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  hasMoreConversations: boolean;
  loadMoreConversations: () => void;
  reloadConversations: () => void;
  filters: OneMailFilters;
  setFilters: (filters: OneMailFilters) => void;
  keyword: string;
  setKeyword: (keyword: string) => void;
  selectedConversationKey: string | null;
  openConversation: (summary: ConversationSummary) => void;
  closeConversation: () => void;
  thread: ConversationThread | null;
  threadLoading: boolean;
  threadError: string | null;
  bodyState: Record<number, MessageBodyLoad | "loading">;
  loadBody: (messageId: number) => void;
  markRead: (messageId: number, read: boolean) => Promise<void>;
  toggleStar: (message: MessageSummary) => Promise<void>;
  syncStatus: OneMailSyncStatus | null;
  syncing: boolean;
  syncProgress: SyncProgressPayload | null;
  syncNow: (accountId?: number) => Promise<void>;
  cancelSync: () => Promise<void>;
  composer: {
    open: boolean;
    draft: Draft | null;
    mode: ComposeKind;
    openNew: () => void;
    openReply: (message: MessageSummary, all: boolean) => Promise<void>;
    openForward: (message: MessageSummary) => Promise<void>;
    openDraft: (item: OutboxItem) => Promise<void>;
    close: () => void;
    saveDraft: (input: DraftInput) => Promise<void>;
    send: (input: SendInput) => Promise<SendResult>;
    pickAttachments: () => Promise<PickedAttachment[]>;
  };
  outbox: OutboxItem[];
  outboxOpen: boolean;
  setOutboxOpen: (open: boolean) => void;
  reloadOutbox: () => Promise<void>;
  retryOutbox: (outboxId: number) => Promise<void>;
  deleteOutbox: (outboxId: number) => Promise<void>;
  accountDialog: {
    open: boolean;
    editing: AccountSummary | null;
    openAdd: () => void;
    openEdit: (account: AccountSummary) => void;
    close: () => void;
  };
  rawMessageId: number | null;
  openRawMessage: (messageId: number) => void;
  closeRawMessage: () => void;
  reloadAccounts: () => Promise<void>;
};

const CONVERSATION_PAGE_SIZE = 50;
const KEYWORD_DEBOUNCE_MS = 300;

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

/** The received-at bounds a range chip means. */
function rangeBounds(range: OneMailFilters["range"]): {
  from: string | null;
  before: string | null;
} {
  if (range === "today") return { from: startOfToday().toISOString(), before: null };
  if (range === "yesterday") {
    const today = startOfToday();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    return { from: yesterday.toISOString(), before: today.toISOString() };
  }
  if (range === "last7days") {
    return {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      before: null,
    };
  }
  return { from: null, before: null };
}

/** Replace one message summary inside the loaded thread. */
function patchThread(
  thread: ConversationThread | null,
  summary: MessageSummary
): ConversationThread | null {
  if (!thread) return thread;
  return {
    ...thread,
    groups: thread.groups.map((group) => ({
      ...group,
      messages: group.messages.map((message) =>
        message.messageId === summary.messageId ? summary : message
      ),
    })),
  };
}

/**
 * The one-mail page's state: accounts, the conversation list, the open thread,
 * body loading, sync and the page overlays.
 *
 * Data flows only through the wrappers in `@/commands`; the backend events are
 * only subscribed here, so the F tracks consume this hook and never invoke or
 * listen on their own.
 */
export function useOneMailPage(): OneMailPageState {
  const { t } = useAppTranslation();
  const pageActive = usePageActive();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<OneMailSettings | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [filters, setFilters] = useState<OneMailFilters>({
    unreadOnly: false,
    starredOnly: false,
    range: "all",
  });
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [selectedConversationKey, setSelectedConversationKey] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [bodyState, setBodyState] = useState<Record<number, MessageBodyLoad | "loading">>({});
  const [syncStatus, setSyncStatus] = useState<OneMailSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgressPayload | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<Draft | null>(null);
  const [composerMode, setComposerMode] = useState<ComposeKind>("new");
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AccountSummary | null>(null);
  const [rawMessageId, setRawMessageId] = useState<number | null>(null);

  // The event handlers and the sync timer outlive a render, so they read the
  // latest values through refs instead of a stale closure.
  const settingsRef = useRef<OneMailSettings | null>(null);
  const accountsRef = useRef<AccountSummary[]>([]);
  const pageActiveRef = useRef(pageActive);
  const conversationRequest = useRef(0);
  const requestedBodies = useRef<Set<number>>(new Set());

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    pageActiveRef.current = pageActive;
  }, [pageActive]);

  const describeError = useCallback(
    (failure: unknown) => t(oneMailErrorKey(oneMailErrorCode(failure))),
    [t]
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword]);

  const reloadAccounts = useCallback(async () => {
    try {
      setAccounts(await oneMailAccountsList());
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [describeError]);

  const reloadOutbox = useCallback(async () => {
    try {
      setOutbox(await oneMailOutboxList());
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [describeError]);

  const reloadFolders = useCallback(async () => {
    if (selectedAccountId === null) {
      setFolders([]);
      return;
    }
    try {
      setFolders(await oneMailFoldersList(selectedAccountId));
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [selectedAccountId, describeError]);

  useEffect(() => {
    void reloadFolders();
  }, [reloadFolders]);

  const loadConversations = useCallback(
    async (offset: number) => {
      const request = ++conversationRequest.current;
      const bounds = rangeBounds(filters.range);
      if (offset === 0) {
        setConversationsLoading(true);
        setConversationsError(null);
      }
      try {
        const page = await oneMailConversationsList({
          accountId: selectedAccountId,
          keyword: debouncedKeyword.length > 0 ? debouncedKeyword : null,
          unreadOnly: filters.unreadOnly,
          starredOnly: filters.starredOnly,
          receivedFrom: bounds.from,
          receivedBefore: bounds.before,
          limit: CONVERSATION_PAGE_SIZE,
          offset,
        });
        if (request !== conversationRequest.current) return;
        setConversations((current) => (offset === 0 ? page.items : [...current, ...page.items]));
        setHasMoreConversations(page.hasMore);
      } catch (failure) {
        if (request === conversationRequest.current) {
          setConversationsError(describeError(failure));
        }
      } finally {
        if (request === conversationRequest.current) setConversationsLoading(false);
      }
    },
    [selectedAccountId, filters, debouncedKeyword, describeError]
  );

  useEffect(() => {
    void loadConversations(0);
  }, [loadConversations]);

  const loadMoreConversations = useCallback(() => {
    if (!hasMoreConversations || conversationsLoading) return;
    void loadConversations(conversations.length);
  }, [hasMoreConversations, conversationsLoading, conversations.length, loadConversations]);

  const reloadConversations = useCallback(() => {
    void loadConversations(0);
  }, [loadConversations]);

  const selectAccount = useCallback((accountId: number | null) => {
    setSelectedAccountId(accountId);
    setSelectedConversationKey(null);
    setThread(null);
    setThreadError(null);
    setBodyState({});
    requestedBodies.current.clear();
  }, []);

  const setFiltersAndReload = useCallback((next: OneMailFilters) => {
    setFilters(next);
  }, []);

  const loadThread = useCallback(
    async (accountId: number, conversationKey: string) => {
      setThreadLoading(true);
      setThreadError(null);
      setBodyState({});
      requestedBodies.current.clear();
      try {
        setThread(await oneMailConversationMessages({ accountId, conversationKey }));
      } catch (failure) {
        setThreadError(describeError(failure));
      } finally {
        setThreadLoading(false);
      }
    },
    [describeError]
  );

  const openConversation = useCallback(
    (summary: ConversationSummary) => {
      setSelectedConversationKey(summary.conversationKey);
      void loadThread(summary.accountId, summary.conversationKey);
    },
    [loadThread]
  );

  const closeConversation = useCallback(() => {
    setSelectedConversationKey(null);
    setThread(null);
    setThreadError(null);
    setThreadLoading(false);
    setBodyState({});
    requestedBodies.current.clear();
  }, []);

  const loadBody = useCallback(
    (messageId: number) => {
      if (requestedBodies.current.has(messageId)) return;
      requestedBodies.current.add(messageId);
      setBodyState((current) => ({ ...current, [messageId]: "loading" }));
      oneMailMessageBodyLoad(messageId)
        .then((result) => {
          setBodyState((current) => ({ ...current, [messageId]: result }));
          setThread((current) => {
            if (!current) return current;
            return {
              ...current,
              groups: current.groups.map((group) => ({
                ...group,
                messages: group.messages.map((message) =>
                  message.messageId === messageId
                    ? {
                        ...message,
                        isRead: result.error === null ? true : message.isRead,
                        bodyStatus: result.error === null ? "ready" : "error",
                        bodyError: result.error,
                      }
                    : message
                ),
              })),
            };
          });
        })
        .catch((failure: unknown) => {
          setBodyState((current) => ({
            ...current,
            [messageId]: { body: null, error: describeError(failure) },
          }));
        });
    },
    [describeError]
  );

  const markRead = useCallback(
    async (messageId: number, read: boolean) => {
      try {
        const updated = await oneMailMessageSetRead(messageId, read);
        setThread((current) => patchThread(current, updated));
        setConversations((current) =>
          current.map((conversation) =>
            conversation.lastMessage.messageId === updated.messageId
              ? { ...conversation, lastMessage: updated }
              : conversation
          )
        );
      } catch (failure) {
        toast.error(describeError(failure));
      }
    },
    [describeError]
  );

  const toggleStar = useCallback(
    async (message: MessageSummary) => {
      try {
        const updated = await oneMailMessageSetStarred(message.messageId, !message.isStarred);
        setThread((current) => patchThread(current, updated));
        setConversations((current) =>
          current.map((conversation) =>
            conversation.lastMessage.messageId === updated.messageId
              ? {
                  ...conversation,
                  lastMessage: updated,
                  isStarred: updated.isStarred,
                }
              : conversation
          )
        );
      } catch (failure) {
        toast.error(describeError(failure));
      }
    },
    [describeError]
  );

  const syncNow = useCallback(
    async (accountId?: number) => {
      setSyncing(true);
      try {
        // A mailbox that has never synced runs a full window scan. Only a
        // refresh announces new mail, so this also keeps the first scan from
        // notifying once per message.
        const targets = accountsRef.current.filter((account) => {
          if (accountId !== undefined) return account.accountId === accountId;
          if (selectedAccountId !== null) return account.accountId === selectedAccountId;
          return true;
        });
        const mode = targets.some((account) => account.lastSyncAt === null) ? "full" : "refresh";
        const report = await oneMailSyncStart({
          accountId: accountId ?? selectedAccountId,
          mode,
        });
        if (!report.ok && report.error) setError(report.error);
        await Promise.all([
          reloadAccounts(),
          reloadFolders(),
          reloadOutbox(),
          loadConversations(0),
          oneMailSyncStatus()
            .then((value) => setSyncStatus(value))
            .catch(() => undefined),
        ]);
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setSyncing(false);
      }
    },
    [
      selectedAccountId,
      reloadAccounts,
      reloadFolders,
      reloadOutbox,
      loadConversations,
      describeError,
    ]
  );

  const cancelSync = useCallback(async () => {
    try {
      await oneMailSyncCancel();
    } catch (failure) {
      toast.error(describeError(failure));
    } finally {
      setSyncing(false);
    }
  }, [describeError]);

  const openNewComposer = useCallback(() => {
    setComposerDraft(null);
    setComposerMode("new");
    setComposerOpen(true);
  }, []);

  const openReplyComposer = useCallback(
    async (message: MessageSummary, all: boolean) => {
      try {
        const draft = await oneMailComposeReplyDraft(
          message.messageId,
          all ? "reply_all" : "reply"
        );
        setComposerDraft(draft);
        setComposerMode(draft.composeKind);
        setComposerOpen(true);
      } catch (failure) {
        toast.error(describeError(failure));
      }
    },
    [describeError]
  );

  const openForwardComposer = useCallback(
    async (message: MessageSummary) => {
      try {
        const draft = await oneMailComposeForwardDraft(message.messageId);
        setComposerDraft(draft);
        setComposerMode(draft.composeKind);
        setComposerOpen(true);
      } catch (failure) {
        toast.error(describeError(failure));
      }
    },
    [describeError]
  );

  const openDraftComposer = useCallback(
    async (item: OutboxItem) => {
      try {
        const draft = await oneMailOutboxGet(item.outboxId);
        setComposerDraft(draft);
        setComposerMode(draft.composeKind);
        setComposerOpen(true);
      } catch (failure) {
        toast.error(describeError(failure));
      }
    },
    [describeError]
  );

  const closeComposer = useCallback(() => setComposerOpen(false), []);

  const saveComposerDraft = useCallback(
    async (input: DraftInput) => {
      const saved = await oneMailComposeSaveDraft(input);
      setComposerDraft(saved);
      setComposerOpen(false);
      await reloadOutbox();
    },
    [reloadOutbox]
  );

  const sendComposer = useCallback(
    async (input: SendInput) => {
      const result = await oneMailComposeSend(input);
      setComposerOpen(false);
      setComposerDraft(null);
      await Promise.all([reloadOutbox(), loadConversations(0)]);
      return result;
    },
    [reloadOutbox, loadConversations]
  );

  const pickComposerAttachments = useCallback(() => oneMailComposePickAttachments(), []);

  const retryOutbox = useCallback(
    async (outboxId: number) => {
      try {
        await oneMailComposeRetry(outboxId);
        await reloadOutbox();
      } catch (failure) {
        toast.error(describeError(failure));
      }
    },
    [reloadOutbox, describeError]
  );

  const deleteOutbox = useCallback(
    async (outboxId: number) => {
      try {
        await oneMailOutboxDelete(outboxId);
        await reloadOutbox();
      } catch (failure) {
        toast.error(describeError(failure));
      }
    },
    [reloadOutbox, describeError]
  );

  const openAccountAdd = useCallback(() => {
    setEditingAccount(null);
    setAccountDialogOpen(true);
  }, []);

  const openAccountEdit = useCallback((account: AccountSummary) => {
    setEditingAccount(account);
    setAccountDialogOpen(true);
  }, []);

  const closeAccountDialog = useCallback(() => {
    setAccountDialogOpen(false);
    setEditingAccount(null);
  }, []);

  const openRawMessage = useCallback((messageId: number) => setRawMessageId(messageId), []);
  const closeRawMessage = useCallback(() => setRawMessageId(null), []);

  // The first load: settings, accounts, outbox and the last sync status. Each
  // call is independent, so one failing lane does not hide the others.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      oneMailSettingsGet()
        .then((value) => {
          if (!cancelled) {
            setSettings(value);
            settingsRef.current = value;
          }
        })
        .catch((failure: unknown) => {
          if (!cancelled) setError(describeError(failure));
        }),
      reloadAccounts(),
      reloadOutbox(),
      oneMailSyncStatus()
        .then((value) => {
          if (!cancelled) setSyncStatus(value);
        })
        .catch(() => undefined),
    ]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [describeError, reloadAccounts, reloadOutbox]);

  // While the page is on screen, sync on activation and then once per
  // configured interval. Hiding the page clears the timer but never cancels a
  // sync already running.
  useEffect(() => {
    const minutes = settings?.refreshIntervalMinutes ?? 0;
    if (!pageActive || accounts.length === 0 || minutes <= 0) return;
    void syncNow();
    const timer = setInterval(() => void syncNow(), minutes * 60_000);
    return () => clearInterval(timer);
  }, [pageActive, accounts.length, settings?.refreshIntervalMinutes, syncNow]);

  const notifyNewMail = useCallback(
    async (payload: NewMailPayload) => {
      if (!pageActiveRef.current || !settingsRef.current?.notifyOnNewMail) return;
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (!granted) return;
        sendNotification({
          title: t("oneMail.notifications.newMailTitle"),
          body: t("oneMail.notifications.newMailBody", {
            account: payload.accountLabel,
            count: payload.messages.length,
          }),
        });
      } catch (failure) {
        // A refused permission is not an error the page should show.
        console.warn("Could not show the new-mail notification:", failure);
      }
    },
    [t]
  );

  // The backend event surface. The F tracks never listen for these themselves.
  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const register = (pending: Promise<UnlistenFn>) => {
      pending
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch((failure: unknown) => console.warn("Could not subscribe to a mail event:", failure));
    };

    register(
      listen<SyncProgressPayload>(ONE_MAIL_SYNC_PROGRESS_EVENT, (event) => {
        setSyncProgress(event.payload);
        if (event.payload.stage === "done" || event.payload.stage === "error") {
          setSyncing(false);
          void oneMailSyncStatus()
            .then((value) => setSyncStatus(value))
            .catch(() => undefined);
        }
      })
    );
    register(
      listen<NewMailPayload>(ONE_MAIL_NEW_MAIL_EVENT, (event) => {
        void notifyNewMail(event.payload);
        void reloadAccounts();
        void loadConversations(0);
      })
    );
    register(
      listen(ONE_MAIL_MAILBOX_CHANGED_EVENT, () => {
        void loadConversations(0);
      })
    );
    register(
      listen(ONE_MAIL_ACCOUNTS_CHANGED_EVENT, () => {
        void reloadAccounts();
        void reloadFolders();
      })
    );
    register(
      listen(ONE_MAIL_OUTBOX_CHANGED_EVENT, () => {
        void reloadOutbox();
      })
    );
    register(
      listen<OneMailSettings>(ONE_MAIL_SETTINGS_CHANGED_EVENT, (event) => {
        setSettings(event.payload);
        settingsRef.current = event.payload;
      })
    );

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [notifyNewMail, reloadAccounts, reloadFolders, reloadOutbox, loadConversations]);

  return {
    loading,
    error,
    settings,
    accounts,
    folders,
    selectedAccountId,
    selectAccount,
    conversations,
    conversationsLoading,
    conversationsError,
    hasMoreConversations,
    loadMoreConversations,
    reloadConversations,
    filters,
    setFilters: setFiltersAndReload,
    keyword,
    setKeyword,
    selectedConversationKey,
    openConversation,
    closeConversation,
    thread,
    threadLoading,
    threadError,
    bodyState,
    loadBody,
    markRead,
    toggleStar,
    syncStatus,
    syncing,
    syncProgress,
    syncNow,
    cancelSync,
    composer: {
      open: composerOpen,
      draft: composerDraft,
      mode: composerMode,
      openNew: openNewComposer,
      openReply: openReplyComposer,
      openForward: openForwardComposer,
      openDraft: openDraftComposer,
      close: closeComposer,
      saveDraft: saveComposerDraft,
      send: sendComposer,
      pickAttachments: pickComposerAttachments,
    },
    outbox,
    outboxOpen,
    setOutboxOpen,
    reloadOutbox,
    retryOutbox,
    deleteOutbox,
    accountDialog: {
      open: accountDialogOpen,
      editing: editingAccount,
      openAdd: openAccountAdd,
      openEdit: openAccountEdit,
      close: closeAccountDialog,
    },
    rawMessageId,
    openRawMessage,
    closeRawMessage,
    reloadAccounts,
  };
}
