// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useState, type FormEvent } from "react";
import { FolderDown, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { MoinCategory } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMoinCategories } from "@/hooks/use-moin-categories";

const DEFAULT_COLOR = "#378ADD";

export default function CategoriesTab() {
  const { t } = useAppTranslation();
  const categories = useMoinCategories();
  const [editing, setEditing] = useState<MoinCategory | null>(null);
  const [name, setName] = useState("");
  const [extensions, setExtensions] = useState("");
  const [saveDir, setSaveDir] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setEditing(null);
    setName("");
    setExtensions("");
    setSaveDir("");
    setColor(DEFAULT_COLOR);
  };

  const startEdit = (category: MoinCategory) => {
    setEditing(category);
    setName(category.name);
    setExtensions(
      category.triggers
        .filter((trigger) => trigger.type === "extension")
        .flatMap((trigger) => trigger.exts)
        .join(", ")
    );
    setSaveDir(category.save_dir ?? "");
    setColor(category.color || DEFAULT_COLOR);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const exts = extensions
      .split(",")
      .map((value) => value.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean);
    const category: MoinCategory = {
      ...(editing ?? ({} as MoinCategory)),
      id: editing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      color,
      icon: editing?.icon ?? null,
      hidden_from_all: editing?.hidden_from_all ?? false,
      save_dir: saveDir.trim() || null,
      incomplete_dir: editing?.incomplete_dir ?? null,
      sources: editing?.sources ?? [],
      triggers: [
        ...(editing?.triggers.filter((trigger) => trigger.type !== "extension") ?? []),
        ...(exts.length > 0 ? [{ type: "extension" as const, exts }] : []),
      ],
      order: editing?.order ?? categories.categories.length,
    };
    setSaving(true);
    try {
      if (editing) {
        await categories.update(category);
      } else {
        await categories.create(category);
      }
      resetForm();
      toast.success(t("moin.category.saved"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (category: MoinCategory) => {
    if (!window.confirm(t("moin.category.deleteConfirm", { name: category.name }))) return;
    setSaving(true);
    try {
      await categories.remove(category.id);
      if (editing?.id === category.id) resetForm();
    } finally {
      setSaving(false);
    }
  };

  const move = async (category: MoinCategory, direction: -1 | 1) => {
    const list = categories.categories;
    const index = list.findIndex((item) => item.id === category.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= list.length) return;
    const ids = list.map((item) => item.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    await categories.reorder(ids);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">{t("moin.category.title")}</h2>
          <Button type="button" size="sm" onClick={resetForm}>
            {t("moin.category.new")}
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">{t("moin.category.subtitle")}</p>
        {categories.error && (
          <p role="alert" className="text-destructive text-sm">
            {t(categories.error)}
          </p>
        )}
        {categories.loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 rounded-lg border py-10 text-sm">
            <LoaderCircle className="size-4 animate-spin" />
            {t("moin.common.loading")}
          </div>
        ) : categories.categories.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-5 text-center">
            <FolderDown className="text-muted-foreground size-7" />
            <p className="font-medium">{t("moin.category.empty")}</p>
            <p className="text-muted-foreground text-sm">{t("moin.category.emptyDescription")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {categories.categories.map((category, index) => (
              <article
                key={category.id}
                className="bg-card flex min-w-0 items-center gap-3 rounded-lg border p-3"
              >
                <span
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: category.color || "var(--primary)" }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{category.name}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {category.triggers
                      .map((trigger) =>
                        trigger.type === "extension"
                          ? trigger.exts.map((ext) => `.${ext}`).join(", ")
                          : t(
                              `moin.trigger.${trigger.type === "size" ? "size" : trigger.type === "url-pattern" ? "urlPattern" : "namePattern"}`
                            )
                      )
                      .filter(Boolean)
                      .join(" · ") || t("moin.category.noRules")}
                  </p>
                  {category.save_dir && (
                    <p className="text-muted-foreground truncate text-xs">{category.save_dir}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("moin.category.moveUp")}
                    disabled={index === 0 || saving}
                    onClick={() => void move(category, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("moin.category.moveDown")}
                    disabled={index === categories.categories.length - 1 || saving}
                    onClick={() => void move(category, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => startEdit(category)}
                  >
                    {t("moin.category.edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => void remove(category)}
                  >
                    {t("moin.common.delete")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <form onSubmit={(event) => void save(event)} className="bg-card h-fit rounded-lg border p-4">
        <h2 className="mb-4 font-medium">
          {t(editing ? "moin.category.editTitle" : "moin.category.createTitle")}
        </h2>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.category.name")}</span>
            <Input
              required
              maxLength={128}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.trigger.extension")}</span>
            <Input
              value={extensions}
              onChange={(event) => setExtensions(event.target.value)}
              placeholder="zip, pdf, mp4"
              disabled={saving}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.category.saveDir")}</span>
            <Input
              value={saveDir}
              onChange={(event) => setSaveDir(event.target.value)}
              disabled={saving}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.category.color")}</span>
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="border-input bg-background h-9 w-full rounded-md border p-1"
              disabled={saving}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {editing && (
            <Button type="button" variant="ghost" disabled={saving} onClick={resetForm}>
              {t("moin.common.cancel")}
            </Button>
          )}
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? t("moin.common.saving") : t("moin.common.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
