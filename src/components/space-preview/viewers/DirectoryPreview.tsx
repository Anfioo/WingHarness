// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { openPath } from '@/commands';
import { useAppTranslation } from '@/hooks/use-app-translation';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { listDirectory, type DirectoryPage } from '@/lib/space-preview/bridge';
import FileIcon from './FileIcon';
import Preview from './Preview';
import { usePreviewLoading } from './PreviewLoading';
import { errorText } from './errors';

type Branch = DirectoryPage & { loading?: boolean; error?: string };

export default function DirectoryPreview(props: {
  file: PreviewFile;
  mode: 'auto' | 'text';
  /** Accepted to match `Preview`'s signature; nested files open inside the folder. */
  onOpen: (file: PreviewFile) => void;
}) {
  const { file, mode } = props;
  const { t } = useAppTranslation();
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const [expanded, setExpanded] = useState(() => new Set([file.id]));
  const [stack, setStack] = useState<PreviewFile[]>([]);
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const selected = stack.at(-1);
  usePreviewLoading(
    !branches[file.id] || Object.values(branches).some((branch) => branch.loading),
    t('spacePreview.directory.loading', { defaultValue: 'Reading the folder' }),
  );
  const load = async (folder: PreviewFile, offset = 0) => {
    if (pending.current.has(folder.id)) return;
    pending.current.add(folder.id);
    setBranches((all) => ({
      ...all,
      [folder.id]: { entries: all[folder.id]?.entries ?? [], nextOffset: offset, loading: true },
    }));
    try {
      const page = await listDirectory(folder, offset);
      if (!alive.current) return;
      setBranches((all) => {
        const entries = [...(offset ? (all[folder.id]?.entries ?? []) : []), ...page.entries];
        const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
        unique.sort(
          (a, b) =>
            Number(!!b.directory) - Number(!!a.directory) ||
            a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
        return { ...all, [folder.id]: { entries: unique, nextOffset: page.nextOffset } };
      });
    } catch (reason) {
      if (alive.current)
        setBranches((all) => ({
          ...all,
          [folder.id]: { ...all[folder.id], loading: false, error: errorText(reason) },
        }));
    } finally {
      pending.current.delete(folder.id);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load(file);
    return () => {
      alive.current = false;
    };
    // The folder is the only input that should start a new read.
  }, [file]);
  const toggle = (folder: PreviewFile) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folder.id)) next.delete(folder.id);
      else next.add(folder.id);
      return next;
    });
    if (!branches[folder.id]) void load(folder);
  };
  const open = (entry: PreviewFile) => {
    if (entry.directory) toggle(entry);
    else setStack([entry]);
  };
  const openDefault = async (entry: PreviewFile) => {
    if (!entry.path) return;
    try {
      await openPath(entry.path);
    } catch (reason) {
      toast.error(
        t('spacePreview.directory.openFailed', {
          defaultValue: 'The file could not be opened with the default app.',
        }),
        { description: errorText(reason) },
      );
    }
  };
  const tree = (folder: PreviewFile, depth = 0): React.ReactNode => {
    const branch = branches[folder.id];
    return (
      <>
        {branch?.entries.map((entry) => (
          <div
            key={entry.id}
            role="treeitem"
            aria-expanded={entry.directory ? expanded.has(entry.id) : undefined}
            aria-selected={stack[0]?.id === entry.id}
          >
            <button
              className={`directory-row ${stack[0]?.id === entry.id ? 'selected' : ''}`}
              style={{ paddingLeft: 10 + depth * 16 }}
              title={entry.path}
              onClick={() => open(entry)}
            >
              {entry.directory ? (
                expanded.has(entry.id) ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : (
                <span className="tree-indent" />
              )}
              <FileIcon name={entry.name} folder={entry.directory} size={16} />
              <span>{entry.name}</span>
            </button>
            {entry.directory && expanded.has(entry.id) && (
              <div role="group">{tree(entry, depth + 1)}</div>
            )}
          </div>
        ))}
        {branch?.loading && (
          <p className="directory-note" role="status">
            {t('spacePreview.directory.reading', { defaultValue: 'Reading…' })}
          </p>
        )}
        {branch?.error && (
          <div className="directory-note" role="alert">
            {t('spacePreview.directory.readFailed', {
              defaultValue: 'The folder contents could not be read.',
            })}
            <button onClick={() => void load(folder, branch.nextOffset ?? 0)}>
              {t('spacePreview.directory.retry', { defaultValue: 'Retry' })}
            </button>
          </div>
        )}
        {branch && !branch.loading && !branch.error && !branch.entries.length && (
          <p className="directory-note">
            {t('spacePreview.directory.empty', { defaultValue: 'This folder is empty.' })}
          </p>
        )}
        {branch?.nextOffset != null && !branch.loading && !branch.error && (
          <button className="directory-more" onClick={() => void load(folder, branch.nextOffset!)}>
            {t('spacePreview.directory.loadMore', { defaultValue: 'Load more' })}
          </button>
        )}
      </>
    );
  };
  return (
    <div className="directory-preview">
      <DirectorySidebar>
        <div
          className="directory-tree"
          role="tree"
          aria-label={t('spacePreview.directory.treeLabel', {
            defaultValue: 'Folder contents',
          })}
          onKeyDown={(event) => {
            if (
              !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('.directory-row'),
            );
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            const button = buttons[index];
            if (!button) return;
            const node = button.parentElement!;
            if (event.key === 'ArrowRight') {
              if (node.getAttribute('aria-expanded') === 'false') button.click();
              else buttons[index + 1]?.focus();
            } else if (event.key === 'ArrowLeft') {
              if (node.getAttribute('aria-expanded') === 'true') button.click();
              else node.parentElement?.closest('[role=treeitem]')?.querySelector('button')?.focus();
            } else
              buttons[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : Math.max(
                        0,
                        Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                      )
              ]?.focus();
          }}
        >
          {tree(file)}
        </div>
      </DirectorySidebar>
      <section className="directory-content">
        {selected ? (
          <>
            <div className="directory-file-heading">
              {stack.length > 1 && (
                <button
                  aria-label={t('spacePreview.directory.backToParent', {
                    defaultValue: 'Back to the parent file',
                  })}
                  onClick={() => setStack((value) => value.slice(0, -1))}
                >
                  <ArrowLeft size={16} />
                </button>
              )}
              <span title={selected.path ?? selected.name}>{selected.name}</span>
              {selected.path && (
                <button
                  title={t('spacePreview.directory.openWithDefault', {
                    defaultValue: 'Open with the default app',
                  })}
                  onClick={() => void openDefault(selected)}
                >
                  <ExternalLink size={16} />
                </button>
              )}
            </div>
            <div className="directory-file-preview">
              <Preview
                key={`${selected.id}:${mode}`}
                file={selected}
                mode={mode}
                onOpen={(entry) => setStack((value) => [...value, entry])}
              />
            </div>
          </>
        ) : (
          <div className="preview-message">
            <FolderOpen size={40} />
            <h3>
              {t('spacePreview.directory.emptyTitle', {
                defaultValue: 'Pick a file to preview',
              })}
            </h3>
            <p>
              {t('spacePreview.directory.emptyBody', {
                defaultValue: 'Expand a folder on the left and pick a file to view its contents.',
              })}
            </p>
            <p>
              {t('spacePreview.directory.emptyNote', {
                defaultValue: 'Folders are read on demand; the whole tree is never scanned.',
              })}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function DirectorySidebar({ children }: { children: React.ReactNode }) {
  const { t } = useAppTranslation();
  const [width, setWidth] = useState(260);
  const sidebar = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const maximum = () =>
    Math.max(150, Math.min(640, (sidebar.current?.parentElement?.clientWidth ?? 1000) * 0.55));
  const resize = (next: number) => setWidth(Math.round(Math.max(150, Math.min(maximum(), next))));
  return (
    <>
      <aside className="directory-sidebar" ref={sidebar} style={{ width }}>
        {children}
      </aside>
      <div
        className="directory-resizer"
        role="separator"
        aria-label={t('spacePreview.viewer.resizeDirectory', {
          defaultValue: 'Resize the file directory',
        })}
        aria-orientation="vertical"
        aria-valuemin={150}
        aria-valuemax={640}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          drag.current = {
            x: event.clientX,
            width: sidebar.current!.getBoundingClientRect().width,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const current = sidebar.current!.getBoundingClientRect().width;
          resize(
            event.key === 'Home'
              ? 150
              : event.key === 'End'
                ? maximum()
                : current + (event.key === 'ArrowRight' ? 16 : -16),
          );
        }}
      />
    </>
  );
}
