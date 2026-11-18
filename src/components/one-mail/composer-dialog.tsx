// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Loader2, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { oneMailErrorCode, type DraftAttachmentInput, type MailAddress } from "@/commands";
import MarkdownEditor from "@/components/one-mail/markdown-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { useAppTranslation } from "@/hooks/use-app-translation";
import { oneMailErrorKey } from "@/lib/one-mail/error-key";
import { markdownToEmail } from "@/lib/one-mail/mail-markdown";
import { useOneMailPageContext } from "@/pages/one-mail/context";

type AddressField = {
  list: MailAddress[];
  /** What the user has typed but not committed yet. */
  raw: string;
  /** Tokens that failed to parse; sending stays disabled while any remain. */
  invalid: string[];
};

type ComposerForm = {
  accountId: number | null;
  to: AddressField;
  cc: AddressField;
  bcc: AddressField;
  subject: string;
  body: string;
  attachments: DraftAttachmentInput[];
};

type BusyState = "send" | "draft" | null;

const TITLE_KEY: Record<string, string> = {
  new: "oneMail.compose.new",
  reply: "oneMail.compose.reply",
  reply_all: "oneMail.compose.replyAll",
  forward: "oneMail.compose.forward",
};

// Deliberately loose: the backend validates addresses again, and rejecting a
// technically valid address here would be worse than accepting a bad one.
const EMAIL_PATTERN = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;
const ADDRESS_SEPARATOR = /[,;]+/;

function emptyAddress(): AddressField {
  return { list: [], raw: "", invalid: [] };
}

function addressField(addresses: MailAddress[]): AddressField {
  return { list: addresses, raw: "", invalid: [] };
}

function parseAddress(token: string): MailAddress | null {
  const trimmed = token.trim();
  if (trimmed === "") return null;

  const named = /^(.*)<([^<>]+)>$/.exec(trimmed);
  if (named) {
    const name = named[1].trim().replace(/^["']|["']$/g, "");
    const email = named[2].trim();
    if (!EMAIL_PATTERN.test(email)) return null;
    return { name: name === "" ? null : name, email };
  }

  return EMAIL_PATTERN.test(trimmed) ? { name: null, email: trimmed } : null;
}

/** Moves the typed text into the address list; unparsable tokens stay flagged. */
function commitAddress(field: AddressField): AddressField {
  if (field.raw.trim() === "") return field;

  const list = [...field.list];
  const invalid = [...field.invalid];
  for (const token of field.raw.split(ADDRESS_SEPARATOR)) {
    if (token.trim() === "") continue;
    const address = parseAddress(token);
    if (!address) {
      invalid.push(token.trim());
      continue;
    }
    if (!list.some((item) => item.email.toLowerCase() === address.email.toLowerCase())) {
      list.push(address);
    }
  }

  return { list, raw: "", invalid };
}

function flushForm(form: ComposerForm): ComposerForm {
  return {
    ...form,
    to: commitAddress(form.to),
    cc: commitAddress(form.cc),
    bcc: commitAddress(form.bcc),
  };
}

function formSignature(form: ComposerForm): string {
  return JSON.stringify({
    accountId: form.accountId,
    to: form.to.list,
    cc: form.cc.list,
    bcc: form.bcc.list,
    subject: form.subject,
    body: form.body,
    attachments: form.attachments.map((attachment) => attachmentKey(attachment)),
  });
}

function attachmentKey(attachment: DraftAttachmentInput): string {
  return attachment.filePath ?? attachment.filename;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAddress(address: MailAddress): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

/**
 * The compose overlay: Markdown body, recipients, attachments and the three
 * exits (send, save draft, discard).
 *
 * The message's identity comes from the page hook: a new message has no draft
 * behind it, while replies, forwards and saved drafts arrive pre-filled. The
 * dialog only edits that identity — the To/Cc/Bcc subject and quoted body of a
 * reply are never rebuilt here.
 */
export default function ComposerDialog() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();
  const composer = page.composer;

  const [form, setForm] = useState<ComposerForm>(() => emptyForm(null));
  const [initialSignature, setInitialSignature] = useState("");
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [ccVisible, setCcVisible] = useState(false);
  const [bccVisible, setBccVisible] = useState(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const formRef = useRef(form);
  formRef.current = form;

  // Building the form only when the overlay opens (or the underlying draft
  // changes) keeps an in-progress edit from being reset by an account refresh.
  const draftKey = composer.open
    ? composer.draft
      ? `draft:${composer.draft.outboxId}:${composer.draft.updatedAt}`
      : `new:${composer.mode}`
    : null;

  useLayoutEffect(() => {
    if (!composer.open || draftKey === null || draftKey === openedKey) return;
    const next = emptyForm(resolveAccountId());
    const draft = composer.draft;
    if (draft) {
      next.accountId = draft.accountId;
      next.to = addressField(draft.to);
      next.cc = addressField(draft.cc);
      next.bcc = addressField(draft.bcc);
      next.subject = draft.subject;
      next.body = draft.bodyText;
      next.attachments = draft.attachments;
    }
    setForm(next);
    setInitialSignature(formSignature(next));
    setOpenedKey(draftKey);
    setCcVisible((draft?.cc.length ?? 0) > 0);
    setBccVisible((draft?.bcc.length ?? 0) > 0);
    setBusy(null);
    setFormError(null);
    setConfirmOpen(false);
    // resolveAccountId reads page state that is already loaded when the overlay
    // opens; adding it to the deps would reset the form on every account event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer.open, draftKey, openedKey]);

  // Closing resets the identity key so the next open rebuilds the form even
  // when it opens in the same mode as the previous message.
  useEffect(() => {
    if (!composer.open) setOpenedKey(null);
  }, [composer.open]);

  const account = useMemo(
    () => page.accounts.find((item) => item.accountId === form.accountId) ?? null,
    [page.accounts, form.accountId]
  );

  function resolveAccountId(): number | null {
    if (composer.draft) return composer.draft.accountId;
    const selected = page.selectedAccountId;
    if (selected !== null && page.accounts.some((item) => item.accountId === selected)) {
      return selected;
    }
    return page.accounts[0]?.accountId ?? null;
  }

  const dirty = formSignature(form) !== initialSignature;

  const closeRequested = useCallback(() => {
    if (busy) return;
    if (!dirty) {
      composer.close();
      return;
    }
    setConfirmOpen(true);
  }, [busy, composer, dirty]);

  const handleSend = async () => {
    const current = flushForm(formRef.current);
    setForm(current);
    setFormError(null);

    if (current.accountId === null) {
      setFormError(t("oneMail.accounts.noAccounts"));
      return;
    }
    if (current.to.list.length === 0) {
      setFormError(t("oneMail.compose.emptyRecipient"));
      return;
    }
    if (
      current.to.invalid.length > 0 ||
      current.cc.invalid.length > 0 ||
      current.bcc.invalid.length > 0
    ) {
      setFormError(t("oneMail.compose.invalidAddress"));
      return;
    }

    setBusy("send");
    const parts = markdownToEmail(current.body);
    try {
      const result = await composer.send({
        outboxId: composer.draft?.outboxId ?? null,
        accountId: current.accountId,
        composeKind: composer.draft?.composeKind ?? composer.mode,
        relatedMessageId: composer.draft?.relatedMessageId ?? null,
        to: current.to.list,
        cc: current.cc.list,
        bcc: current.bcc.list,
        subject: current.subject,
        bodyText: parts.text,
        bodyHtml: parts.html,
        attachments: current.attachments,
        inReplyTo: composer.draft?.inReplyTo ?? null,
        referencesHeader: composer.draft?.referencesHeader ?? null,
      });
      toast.success(t("oneMail.compose.sent"));
      if (result.warning) toast.warning(t("oneMail.compose.warningAppend"));
    } catch (failure) {
      // The draft stays on screen so nothing typed is lost.
      toast.error(t(oneMailErrorKey(oneMailErrorCode(failure))));
    } finally {
      setBusy(null);
    }
  };

  const handleSaveDraft = async (): Promise<boolean> => {
    const current = flushForm(formRef.current);
    setForm(current);
    setFormError(null);

    if (current.accountId === null) {
      setFormError(t("oneMail.accounts.noAccounts"));
      return false;
    }
    if (
      current.to.invalid.length > 0 ||
      current.cc.invalid.length > 0 ||
      current.bcc.invalid.length > 0
    ) {
      setFormError(t("oneMail.compose.invalidAddress"));
      return false;
    }

    setBusy("draft");
    const parts = markdownToEmail(current.body);
    try {
      await composer.saveDraft({
        outboxId: composer.draft?.outboxId ?? null,
        accountId: current.accountId,
        composeKind: composer.draft?.composeKind ?? composer.mode,
        relatedMessageId: composer.draft?.relatedMessageId ?? null,
        to: current.to.list,
        cc: current.cc.list,
        bcc: current.bcc.list,
        subject: current.subject,
        bodyText: parts.text,
        bodyHtml: parts.html,
        attachments: current.attachments,
      });
      return true;
    } catch (failure) {
      toast.error(t(oneMailErrorKey(oneMailErrorCode(failure))));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleDiscard = () => {
    setConfirmOpen(false);
    // Discarding a draft that already exists should not leave an empty copy in
    // the outbox; a never-saved message has nothing to delete.
    if (composer.draft) void page.deleteOutbox(composer.draft.outboxId);
    composer.close();
  };

  const saveAndClose = async () => {
    if (await handleSaveDraft()) setConfirmOpen(false);
  };

  const addAttachments = async () => {
    try {
      const picked = await composer.pickAttachments();
      if (picked.length === 0) return;
      setForm((current) => {
        const known = new Set(current.attachments.map(attachmentKey));
        const additions = picked
          .filter((attachment) => !known.has(attachmentKey(attachment)))
          .map((attachment) => ({
            filePath: attachment.filePath,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          }));
        return { ...current, attachments: [...current.attachments, ...additions] };
      });
    } catch (failure) {
      toast.error(t(oneMailErrorKey(oneMailErrorCode(failure))));
    }
  };

  const removeAttachment = (index: number) => {
    setForm((current) => ({
      ...current,
      attachments: current.attachments.filter((_, position) => position !== index),
    }));
  };

  const updateField = <Key extends keyof ComposerForm>(key: Key, value: ComposerForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const sending = busy === "send";
  const savingDraft = busy === "draft";
  const disabled = busy !== null;
  const noAccount = page.accounts.length === 0;

  return (
    <>
      <Dialog
        open={composer.open}
        onOpenChange={(open) => {
          if (!open) closeRequested();
        }}
      >
        <DialogContent
          showCloseButton={!disabled}
          className="grid h-[min(80vh,720px)] w-[min(920px,92vw)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <DialogHeader className="border-b px-4 py-3 pr-12">
            <DialogTitle className="text-base">
              {t(TITLE_KEY[composer.mode] ?? "oneMail.compose.title")}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {account ? `${account.accountLabel} <${account.email}>` : "—"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground w-14 shrink-0 text-xs">
                {t("oneMail.compose.from")}
              </span>
              <span className="min-w-0 truncate">
                {account ? `${account.accountLabel} <${account.email}>` : "—"}
              </span>
            </div>

            <AddressRow
              id="one-mail-compose-to"
              label={t("oneMail.compose.to")}
              field={form.to}
              disabled={disabled}
              onChange={(field) => updateField("to", field)}
            />

            <div className="flex flex-wrap items-center gap-2">
              {!ccVisible && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  disabled={disabled}
                  onClick={() => setCcVisible(true)}
                >
                  {t("oneMail.compose.cc")}
                </Button>
              )}
              {!bccVisible && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  disabled={disabled}
                  onClick={() => setBccVisible(true)}
                >
                  {t("oneMail.compose.bcc")}
                </Button>
              )}
            </div>

            {ccVisible && (
              <AddressRow
                id="one-mail-compose-cc"
                label={t("oneMail.compose.cc")}
                field={form.cc}
                disabled={disabled}
                onChange={(field) => updateField("cc", field)}
              />
            )}
            {bccVisible && (
              <AddressRow
                id="one-mail-compose-bcc"
                label={t("oneMail.compose.bcc")}
                field={form.bcc}
                disabled={disabled}
                onChange={(field) => updateField("bcc", field)}
              />
            )}

            <div className="flex items-center gap-3">
              <label
                htmlFor="one-mail-compose-subject"
                className="text-muted-foreground w-14 text-xs"
              >
                {t("oneMail.compose.subject")}
              </label>
              <Input
                id="one-mail-compose-subject"
                value={form.subject}
                disabled={disabled}
                className="h-8 min-w-0 flex-1"
                onChange={(event) => updateField("subject", event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-muted-foreground text-xs">{t("oneMail.compose.body")}</label>
                <div className="flex items-center gap-1.5">
                  {composer.mode === "forward" && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        disabled
                        aria-label={t("oneMail.compose.addOriginalAttachments")}
                        title={t("oneMail.compose.forwardAttachmentUnavailable")}
                      >
                        <Paperclip />
                      </Button>
                      <span className="text-muted-foreground max-w-56 text-[11px]">
                        {t("oneMail.compose.forwardAttachmentUnavailable")}
                      </span>
                    </>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    disabled={disabled}
                    onClick={() => void addAttachments()}
                  >
                    <Plus />
                    {t("oneMail.compose.addAttachment")}
                  </Button>
                </div>
              </div>
              <MarkdownEditor
                value={form.body}
                onChange={(value) => updateField("body", value)}
                placeholder={t("oneMail.compose.body")}
                disabled={disabled}
                minHeight={220}
              />
            </div>

            {form.attachments.length > 0 && (
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">{t("oneMail.compose.attachments")}</p>
                <ul className="divide-y rounded-md border">
                  {form.attachments.map((attachment, index) => (
                    <li
                      key={`${attachmentKey(attachment)}:${index}`}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                    >
                      <Paperclip className="text-muted-foreground size-3.5 shrink-0" />
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={attachment.filePath ?? undefined}
                      >
                        {attachment.filename}
                      </span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {formatBytes(attachment.sizeBytes)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="size-6 shrink-0 p-0"
                        disabled={disabled}
                        aria-label={t("oneMail.compose.removeAttachment")}
                        title={t("oneMail.compose.removeAttachment")}
                        onClick={() => removeAttachment(index)}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {noAccount && (
              <p role="alert" className="text-destructive text-xs">
                {t("oneMail.accounts.noAccounts")}
              </p>
            )}
            {formError && (
              <p role="alert" className="text-destructive text-xs">
                {formError}
              </p>
            )}
          </div>

          <DialogFooter className="border-t px-4 py-3 sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={disabled}
              onClick={closeRequested}
            >
              <Trash2 />
              {t("oneMail.compose.discard")}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={disabled || noAccount}
                onClick={() => void handleSaveDraft()}
              >
                {savingDraft && <Loader2 className="animate-spin" />}
                {savingDraft ? t("oneMail.compose.savingDraft") : t("oneMail.compose.saveDraft")}
              </Button>
              <Button
                type="button"
                disabled={disabled || noAccount}
                onClick={() => void handleSend()}
              >
                {sending ? <Loader2 className="animate-spin" /> : <Send />}
                {sending ? t("oneMail.compose.sending") : t("oneMail.compose.send")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("oneMail.compose.discard")}</AlertDialogTitle>
            <AlertDialogDescription>{t("oneMail.compose.discardConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled}>{t("oneMail.common.cancel")}</AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => void saveAndClose()}
            >
              {savingDraft && <Loader2 className="animate-spin" />}
              {t("oneMail.compose.saveDraft")}
            </Button>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={disabled}
                onClick={(event) => {
                  event.preventDefault();
                  handleDiscard();
                }}
              >
                {t("oneMail.compose.discard")}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function emptyForm(accountId: number | null): ComposerForm {
  return {
    accountId,
    to: emptyAddress(),
    cc: emptyAddress(),
    bcc: emptyAddress(),
    subject: "",
    body: "",
    attachments: [],
  };
}

type AddressRowProps = {
  id: string;
  label: string;
  field: AddressField;
  disabled: boolean;
  onChange: (field: AddressField) => void;
};

/** One recipient row: committed addresses as chips, plus the live input. */
function AddressRow({ id, label, field, disabled, onChange }: AddressRowProps) {
  const { t } = useAppTranslation();

  const commit = () => {
    const next = commitAddress(field);
    if (next !== field) onChange(next);
  };

  const removeAddress = (email: string) => {
    onChange({ ...field, list: field.list.filter((item) => item.email !== email) });
  };

  const removeInvalid = (index: number) => {
    onChange({ ...field, invalid: field.invalid.filter((_, position) => position !== index) });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-3">
        <label htmlFor={id} className="text-muted-foreground w-14 shrink-0 pt-1.5 text-xs">
          {label}
        </label>
        <div className="focus-within:ring-ring flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 focus-within:ring-1">
          {field.list.map((address) => (
            <span
              key={address.email}
              className="bg-muted flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs"
              title={address.email}
            >
              <span className="truncate">{formatAddress(address)}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                disabled={disabled}
                aria-label={t("oneMail.common.delete")}
                onClick={() => removeAddress(address.email)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {field.invalid.map((token, index) => (
            <span
              key={`${token}:${index}`}
              className="border-destructive/50 text-destructive flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            >
              <span className="truncate">{token}</span>
              <button
                type="button"
                className="hover:text-foreground"
                disabled={disabled}
                aria-label={t("oneMail.common.delete")}
                onClick={() => removeInvalid(index)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            id={id}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={field.raw}
            disabled={disabled}
            className="min-w-32 flex-1 bg-transparent py-0.5 text-sm outline-none disabled:opacity-60"
            onChange={(event) => onChange({ ...field, raw: event.target.value })}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "," || event.key === ";") {
                event.preventDefault();
                commit();
              } else if (event.key === "Backspace" && field.raw === "" && field.list.length > 0) {
                removeAddress(field.list[field.list.length - 1].email);
              }
            }}
          />
        </div>
      </div>
      {field.invalid.length > 0 && (
        <p role="alert" className="text-destructive pl-17 text-xs">
          {t("oneMail.compose.invalidAddress")}
        </p>
      )}
    </div>
  );
}
