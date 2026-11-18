// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, Mail, Plus, SlidersHorizontal, X } from "lucide-react";
import {
  oneMailComposeReplyDraft,
  oneMailComposeSend,
  oneMailErrorCode,
  type AccountSummary,
  type ConversationThread,
  type MailAddress,
  type MessageSummary,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { oneMailErrorKey } from "@/lib/one-mail/error-key";
import { markdownToEmail } from "@/lib/one-mail/mail-markdown";
import { useOneMailPageContext } from "@/pages/one-mail/context";

const EMAIL_PATTERN = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;

export interface ReplyComposerProps {
  conversation: ConversationThread;
  latestMessage: MessageSummary | null;
  /** `null` means a new topic rather than a reply. */
  replyTarget: MessageSummary | null;
  onReplyTargetChange: (message: MessageSummary | null) => void;
  focusToken: number;
  accounts: AccountSummary[];
  onSent: () => void;
  onOpenOutbox: () => void;
}

interface EditableAddresses {
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  invalid: boolean;
}

/**
 * The reply box at the foot of the thread.
 *
 * A reply is prepared from the message entity alone; the backend draft is
 * created only when the message is actually sent, so browsing a thread does not
 * leave a trail of drafts in the outbox. "New topic" reuses the same box with an
 * empty subject and the conversation's participants as the first recipients.
 */
export default function ReplyComposer({
  conversation,
  latestMessage,
  replyTarget,
  onReplyTargetChange,
  focusToken,
  accounts,
  onSent,
  onOpenOutbox,
}: ReplyComposerProps) {
  const { t } = useAppTranslation();
  const page = useOneMailPageContext();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [newTopic, setNewTopic] = useState(false);
  const [replyAll, setReplyAll] = useState(conversation.participants.length > 1);
  const [accountId, setAccountId] = useState<number>(
    replyTarget?.accountId ?? conversation.accountId
  );
  const [edited, setEdited] = useState<EditableAddresses>({
    to: [],
    cc: [],
    subject: "",
    invalid: false,
  });
  const textarea = useRef<HTMLTextAreaElement>(null);

  const target = newTopic ? null : (replyTarget ?? latestMessage);
  const senderAccount = accounts.find((account) => account.accountId === accountId);

  const derived = useMemo(
    () => buildRecipients({ target, conversation, replyAll, accountId, accounts }),
    [target, conversation, replyAll, accountId, accounts]
  );
  const derivedRef = useRef(derived);
  derivedRef.current = derived;
  // Recomputing the visible recipients on every account refresh would wipe an
  // edit in progress, so the reset key names only the inputs the user changed.
  const recipientKey = [
    accountId,
    replyAll ? "all" : "one",
    target?.messageId ?? "new",
    newTopic ? "topic" : "reply",
    conversation.conversationKey,
  ].join("|");

  // Switching the target or kind recomputes the visible recipients. The edit
  // dialog always starts from this fresh set.
  useEffect(() => {
    setEdited((current) => ({
      to: derivedRef.current.to,
      cc: derivedRef.current.cc,
      subject: newTopic ? current.subject : derivedRef.current.subject,
      invalid: false,
    }));
  }, [recipientKey, newTopic]);

  useEffect(() => {
    if (!replyTarget) return;
    setAccountId(replyTarget.accountId);
    setNewTopic(false);
  }, [replyTarget]);

  useEffect(() => {
    if (focusToken > 0) textarea.current?.focus();
  }, [focusToken]);

  const subject = newTopic ? edited.subject : derived.subject;
  const recipients = edited.to;
  const canSend =
    !sending &&
    body.trim().length > 0 &&
    recipients.length > 0 &&
    !edited.invalid &&
    (!newTopic || subject.trim().length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setNotice(null);
    const parts = markdownToEmail(body);
    try {
      let result;
      if (target) {
        const draft = await oneMailComposeReplyDraft(
          target.messageId,
          replyAll ? "reply_all" : "reply"
        );
        result = await oneMailComposeSend({
          ...draft,
          to: recipients,
          cc: edited.cc,
          subject: derived.subject,
          bodyText: parts.text,
          bodyHtml: parts.html,
          attachments: [],
        });
      } else {
        result = await oneMailComposeSend({
          outboxId: null,
          accountId,
          composeKind: "new",
          relatedMessageId: null,
          to: recipients,
          cc: edited.cc,
          bcc: [],
          subject: subject.trim(),
          bodyText: parts.text,
          bodyHtml: parts.html,
          attachments: [],
          inReplyTo: null,
          referencesHeader: null,
        });
      }

      if (result.status === "failed") {
        setError(t("oneMail.reply.sendFailed"));
        page.logActivity({
          tone: "danger",
          account: senderAccount?.accountLabel ?? "",
          actionKey: "oneMail.activity.sendFailed",
        });
        return;
      }
      setBody("");
      setNotice(result.warning ?? t("oneMail.reply.sent"));
      page.logActivity({
        tone: "success",
        account: senderAccount?.accountLabel ?? "",
        actionKey: "oneMail.activity.sent",
      });
      setNewTopic(false);
      onReplyTargetChange(null);
      onSent();
    } catch (failure) {
      setError(t(oneMailErrorKey(oneMailErrorCode(failure))));
      page.logActivity({
        tone: "danger",
        account: senderAccount?.accountLabel ?? "",
        actionKey: "oneMail.activity.sendFailed",
      });
    } finally {
      setSending(false);
    }
  };

  const startNewTopic = () => {
    setNewTopic(true);
    setError(null);
    setNotice(null);
    onReplyTargetChange(null);
    setEdited({
      to: conversation.participants.map((participant) => ({
        name: participant.name,
        email: participant.email,
      })),
      cc: [],
      subject: "",
      invalid: false,
    });
    setOptionsOpen(true);
  };

  return (
    <>
      <div className="conversation-composer mx-3 mb-3 shrink-0 rounded-2xl border px-3 py-2 md:mx-4">
        <Textarea
          ref={textarea}
          value={body}
          disabled={sending}
          onChange={(event) => setBody(event.target.value)}
          rows={2}
          className="max-h-40 min-h-14 resize-none rounded-none border-0 bg-transparent px-0 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
          placeholder={t("oneMail.reply.placeholder")}
          aria-label={t("oneMail.reply.placeholder")}
        />

        {target && !newTopic && (
          <div
            role="group"
            aria-label={t("oneMail.reply.quotedMessage")}
            className="text-muted-foreground mb-2 flex w-fit max-w-full items-center gap-2 text-xs"
          >
            <div className="border-muted-foreground/35 max-w-xl min-w-0 flex-1 border-l-2 pl-2.5">
              <p className="truncate leading-5" title={target.subject ?? undefined}>
                {target.subject || t("oneMail.thread.noSubject")}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="bg-muted text-muted-foreground size-5 shrink-0 rounded-full"
              disabled={sending}
              aria-label={t("oneMail.reply.clearQuote")}
              onClick={() => {
                onReplyTargetChange(null);
                setNewTopic(true);
                setEdited((current) => ({ ...current, subject: "" }));
                textarea.current?.focus();
              }}
            >
              <X className="size-3" />
            </Button>
          </div>
        )}

        <div className="mt-1 flex min-h-8 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1 text-xs">
            <Button
              className="text-muted-foreground h-7 px-1.5 text-xs"
              size="sm"
              variant="ghost"
              disabled={sending}
              onClick={() => {
                setOptionsOpen(true);
                setError(null);
                setNotice(null);
              }}
              aria-haspopup="dialog"
            >
              <SlidersHorizontal className="size-3.5" />
              {t("oneMail.reply.sendOptions")}
            </Button>
            {!newTopic && (
              <Button
                className="text-muted-foreground h-7 px-1.5 text-xs"
                size="sm"
                variant="ghost"
                disabled={sending}
                onClick={startNewTopic}
                aria-haspopup="dialog"
              >
                <Plus className="size-3.5" />
                {t("oneMail.reply.newTopic")}
              </Button>
            )}
            {newTopic && (
              <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
                {t("oneMail.reply.newTopicBadge")}
              </Badge>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-end gap-2">
            <Badge
              variant="outline"
              className="border-border/60 bg-muted/30 text-muted-foreground max-w-[min(42vw,18rem)] min-w-0 shrink"
              title={`${t("oneMail.reply.from")}: ${
                senderAccount?.email ?? t("oneMail.reply.noSendingAccount")
              }`}
            >
              <Mail aria-hidden />
              <span className="min-w-0 truncate">
                {senderAccount?.email ?? t("oneMail.reply.noSendingAccount")}
              </span>
            </Badge>
            {body.trim() && (
              <Button
                className="conversation-send size-8 shrink-0 rounded-full"
                size="icon"
                disabled={!canSend}
                onClick={() => void send()}
                title={sending ? t("oneMail.reply.sending") : t("oneMail.reply.send")}
                aria-label={sending ? t("oneMail.reply.sending") : t("oneMail.reply.send")}
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>

        {(error || notice) && (
          <div className="mt-2 text-xs break-words">
            {error && (
              <p role="alert" className="text-destructive">
                {error}
                <button className="ml-2 underline" onClick={onOpenOutbox}>
                  {t("oneMail.reply.viewOutbox")}
                </button>
              </p>
            )}
            {notice && (
              <p role="status" className="text-muted-foreground">
                {notice}
              </p>
            )}
          </div>
        )}
      </div>

      <ReplyOptionsDialog
        key={optionsOpen ? "open" : "closed"}
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        accounts={accounts}
        accountId={accountId}
        onAccountChange={setAccountId}
        replyTarget={target}
        replyAll={replyAll}
        onReplyAllChange={setReplyAll}
        edited={{ ...edited, subject }}
        onEditedChange={(next) => {
          setEdited(next);
          if (next.invalid) setOptionsOpen(true);
        }}
      />
    </>
  );
}

function ReplyOptionsDialog({
  open,
  onOpenChange,
  accounts,
  accountId,
  onAccountChange,
  replyTarget,
  replyAll,
  onReplyAllChange,
  edited,
  onEditedChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountSummary[];
  accountId: number;
  onAccountChange: (accountId: number) => void;
  replyTarget: MessageSummary | null;
  replyAll: boolean;
  onReplyAllChange: (value: boolean) => void;
  edited: EditableAddresses;
  onEditedChange: (next: EditableAddresses) => void;
}) {
  const { t } = useAppTranslation();
  const [toRaw, setToRaw] = useState(() => formatAddresses(edited.to));
  const [ccRaw, setCcRaw] = useState(() => formatAddresses(edited.cc));
  const [subject, setSubject] = useState(() => edited.subject);

  const commit = () => {
    const to = parseAddresses(toRaw);
    const cc = parseAddresses(ccRaw);
    onEditedChange({
      to,
      cc,
      subject,
      invalid: to.invalid || cc.invalid,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("oneMail.reply.optionsTitle")}</DialogTitle>
          <DialogDescription>{t("oneMail.reply.optionsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="one-mail-reply-account">{t("oneMail.reply.from")}</Label>
            <Select
              value={String(accountId)}
              onValueChange={(value) => onAccountChange(Number(value))}
              disabled={replyTarget !== null}
            >
              <SelectTrigger id="one-mail-reply-account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.accountId} value={String(account.accountId)}>
                    {account.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {replyTarget && (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="one-mail-reply-all">{t("oneMail.reply.replyAll")}</Label>
              <Switch
                id="one-mail-reply-all"
                checked={replyAll}
                onCheckedChange={onReplyAllChange}
              />
            </div>
          )}

          <AddressField
            id="one-mail-reply-to"
            label={t("oneMail.compose.to")}
            value={toRaw}
            onChange={(value) => {
              setToRaw(value);
              const to = parseAddresses(value);
              onEditedChange({
                ...edited,
                to,
                invalid: to.invalid || parseAddresses(ccRaw).invalid,
              });
            }}
          />
          <AddressField
            id="one-mail-reply-cc"
            label={t("oneMail.compose.cc")}
            value={ccRaw}
            onChange={(value) => {
              setCcRaw(value);
              const cc = parseAddresses(value);
              onEditedChange({
                ...edited,
                cc,
                invalid: parseAddresses(toRaw).invalid || cc.invalid,
              });
            }}
          />
          {!replyTarget && (
            <div className="space-y-1.5">
              <Label htmlFor="one-mail-reply-subject">{t("oneMail.compose.subject")}</Label>
              <Input
                id="one-mail-reply-subject"
                value={subject}
                onChange={(event) => {
                  setSubject(event.target.value);
                  onEditedChange({ ...edited, subject: event.target.value });
                }}
              />
            </div>
          )}
          {edited.invalid && (
            <p role="alert" className="text-destructive text-xs">
              {t("oneMail.compose.invalidAddress")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              commit();
              onOpenChange(false);
            }}
          >
            {t("oneMail.reply.optionsDone")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddressField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function formatAddresses(addresses: MailAddress[]): string {
  return addresses
    .map((address) => (address.name ? `${address.name} <${address.email}>` : address.email))
    .join(", ");
}

function parseAddresses(raw: string): MailAddress[] & { invalid: boolean } {
  const list: MailAddress[] = [];
  let invalid = false;
  for (const token of raw.split(/[,;]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const named = /^(.*)<([^<>]+)>$/.exec(trimmed);
    const email = (named ? named[2] : trimmed).trim();
    const name = named && named[1].trim() ? named[1].trim() : null;
    if (!EMAIL_PATTERN.test(email)) {
      invalid = true;
      continue;
    }
    list.push({ name, email });
  }
  return Object.assign(list, { invalid });
}

function buildRecipients({
  target,
  conversation,
  replyAll,
  accountId,
  accounts,
}: {
  target: MessageSummary | null;
  conversation: ConversationThread;
  replyAll: boolean;
  accountId: number;
  accounts: AccountSummary[];
}): { to: MailAddress[]; cc: MailAddress[]; subject: string } {
  const own = accounts.find((account) => account.accountId === accountId)?.email.toLowerCase();
  if (!target) {
    return {
      to: conversation.participants.map((participant) => ({
        name: participant.name,
        email: participant.email,
      })),
      cc: [],
      subject: "",
    };
  }

  const outgoing = Boolean(own && target.fromEmail && target.fromEmail.toLowerCase() === own);
  const from = (
    target.fromEmail ? [{ name: target.fromName, email: target.fromEmail }] : []
  ).filter((address): address is MailAddress => Boolean(address.email));
  const to = dedupe(
    (outgoing ? target.to : replyAll ? [...from, ...target.to] : from).filter(
      (address) => address.email.toLowerCase() !== own
    )
  );
  const cc = replyAll
    ? dedupe(target.cc.filter((address) => address.email.toLowerCase() !== own))
    : [];

  return { to, cc, subject: replySubject(target.subject) };
}

function replySubject(subject: string | null): string {
  const value = (subject ?? "").trim();
  if (!value) return "";
  return /^(re|回复|回覆)\s*[:：]/i.test(value) ? value : `Re: ${value}`;
}

function dedupe(addresses: MailAddress[]): MailAddress[] {
  const seen = new Set<string>();
  const result: MailAddress[] = [];
  for (const address of addresses) {
    const key = address.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}
