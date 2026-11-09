import { usePreviewLoading } from './PreviewLoading';
import PreviewToolbar from './PreviewToolbar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ArrowLeft, Search, FolderOpen } from 'lucide-react';
import Preview from './Preview';
import { archiveTree, type ArchiveNode } from '@/lib/space-preview/engine/archive-tree';
import { extension, formatSize } from '@/lib/space-preview/engine/files';
import { previewMime } from '@/lib/space-preview/registry';
import { readRange, type PreviewFile } from '@/lib/space-preview/bridge';
import { readZipDirectory, readZipEntry } from '@/lib/space-preview/engine/zip-range';
import { parseInWorker } from '@/lib/space-preview/worker/worker-client';
import type { ArchiveEntry } from '@/lib/space-preview/worker/worker-types';
import { openArchive } from '@/lib/space-preview/engine/archive-session';
import { useAppTranslation } from '@/hooks/use-app-translation';
import FileIcon from './FileIcon';
import { errorText } from './errors';

// An entry must fit in memory as both a compressed and an expanded blob.
const ENTRY_LIMIT = 32 * 1024 * 1024;

export default function ArchivePreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const entryLimit = ENTRY_LIMIT;
  const entryReason = useCallback(
    (entry: ArchiveEntry): string => {
      if (entry.directory) return '';
      if (entry.size > ENTRY_LIMIT || entry.compressed > ENTRY_LIMIT)
        return t('spacePreview.viewer.entryTooLarge', {
          defaultValue: 'The compressed or expanded size exceeds {{size}} MiB',
          size: ENTRY_LIMIT / (1024 * 1024),
        });
      if (entry.encrypted)
        return t('spacePreview.viewer.entryEncrypted', { defaultValue: 'Encrypted' });
      return entry.sourcePath === undefined && ![0, 8].includes(entry.method ?? -1)
        ? t('spacePreview.viewer.entryUnsupported', { defaultValue: 'Unsupported algorithm' })
        : '';
    },
    [t],
  );
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
  const [error, setError] = useState('');
  const [entryError, setEntryError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [visible, setVisible] = useState<Record<string, number>>({});
  const [stack, setStack] = useState<PreviewFile[]>([]);
  const [query, setQuery] = useState('');
  const [extracting, setExtracting] = useState(false);
  usePreviewLoading(
    (!entries && !error) || extracting,
    extracting
      ? t('spacePreview.viewer.extractingSelected', {
          defaultValue: 'Extracting the selected file',
        })
      : t('spacePreview.viewer.readingArchiveDirectory', {
          defaultValue: 'Reading the archive directory',
        }),
  );
  const [selected, setSelected] = useState('');
  const restoreSelected = useRef(selected);
  const [reload, setReload] = useState(0);
  const [password, setPassword] = useState('');
  // The password only applies on an explicit reload, never on every keystroke.
  const passwordRef = useRef(password);
  const session = useRef<Awaited<ReturnType<typeof openArchive>> | null>(null);
  const zip = [
    'zip',
    'jar',
    'apk',
    'ipa',
    'cbz',
    'whl',
    'nupkg',
    'snupkg',
    'vsix',
    'xpi',
    'egg',
    'pyz',
    'appx',
    'appxbundle',
    'msix',
    'msixbundle',
    'aab',
    'hap',
    'wgt',
    'wgtu',
    'qlplugin',
  ].includes(extension(file.name));
  const extraction = useRef<AbortController | null>(null);
  const read = useCallback(
    (offset: number, length: number) => readRange(file, offset, length),
    [file],
  );
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setError('');
      setEntries(null);
      setStack([]);
      if (reload) {
        setSelected('');
        setExpanded(new Set());
        setVisible({});
      }
      setEntryError('');
      setExtracting(false);
      if (!zip) {
        const archive = await openArchive(file, controller.signal, passwordRef.current, entryLimit);
        if (controller.signal.aborted) {
          archive.close();
          return;
        }
        session.current = archive;
        setEntries(archive.entries);
        return;
      }
      const directory = await readZipDirectory(file.size, (offset, length) =>
        readRange(file, offset, length),
      );
      if (controller.signal.aborted) return;
      const parsed = await parseInWorker(
        { kind: 'archive-directory', name: file.name, ...directory },
        controller.signal,
      );
      if (!controller.signal.aborted) setEntries(parsed.entries!);
    };
    void load().catch((e) => {
      if (!controller.signal.aborted) setError(errorText(e));
    });
    return () => {
      controller.abort();
      session.current?.close();
      session.current = null;
      extraction.current?.abort();
    };
  }, [file, reload, zip, entryLimit]);
  useEffect(() => {
    extraction.current?.abort();
    setExtracting(false);
    setStack([]);
  }, [entryLimit]);
  const nodes = useMemo(() => archiveTree(entries ?? []), [entries]);
  const matches = useMemo(
    () =>
      query
        ? (entries ?? [])
            .filter(
              (entry) => !entry.directory && entry.name.toLowerCase().includes(query.toLowerCase()),
            )
            .map((entry) => ({ id: `file:${entry.index}:${entry.name}`, name: entry.name, entry }))
        : nodes,
    [entries, nodes, query],
  );
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openEntry = useCallback(async (entry: ArchiveEntry) => {
    if (entry.directory || entryReason(entry)) return;
    setSelected(`file:${entry.index}:${entry.name}`);
    setStack([]);
    extraction.current?.abort();
    const controller = new AbortController();
    extraction.current = controller;
    setExtracting(true);
    setEntryError('');
    try {
      let blob: Blob;
      if (session.current) {
        blob = await session.current.extract(entry, entryLimit);
      } else {
        const bytes = await readZipEntry(
          entry,
          file.size,
          (offset, length) => {
            controller.signal.throwIfAborted();
            return read(offset, length);
          },
          entryLimit,
        );
        if (controller.signal.aborted) return;
        const result = await parseInWorker(
          { kind: 'archive-data', name: file.name, bytes, entry, archiveEntryLimit: entryLimit },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        blob = new Blob([result.data as Uint8Array<ArrayBuffer>]);
      }
      if (controller.signal.aborted) return;
      const name = entry.name.split('/').pop() || entry.name;
      const mime = previewMime(name);
      blob = blob.slice(0, blob.size, mime);
      setStack([
        {
          id: crypto.randomUUID(),
          name,
          size: blob.size,
          modified: file.modified,
          mime,
          blob,
        },
      ]);
    } catch (e) {
      if (!controller.signal.aborted) setEntryError(errorText(e));
    } finally {
      if (!controller.signal.aborted) setExtracting(false);
    }
  }, [entryReason, file, entryLimit, read]);
  useEffect(() => {
    if (!entries || !restoreSelected.current) return;
    const id = restoreSelected.current;
    restoreSelected.current = '';
    const entry = entries.find((item) => `file:${item.index}:${item.name}` === id);
    if (entry) void openEntry(entry);
  }, [entries, openEntry]);
  const passwordControls = !zip && (
    <PreviewToolbar className="content-toolbar">
      <label className="preview-menu-option">
        <span>{t('spacePreview.viewer.archivePassword', { defaultValue: 'Archive password' })}</span>
        <input
          type="password"
          aria-label={t('spacePreview.viewer.archivePassword', {
            defaultValue: 'Archive password',
          })}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            passwordRef.current = event.target.value;
          }}
        />
      </label>
      <button onClick={() => setReload((value) => value + 1)}>
        {t('spacePreview.viewer.rereadWithPassword', { defaultValue: 'Read again with the password' })}
      </button>
    </PreviewToolbar>
  );
  if (error)
    return (
      <>
        {passwordControls}
        <div className="preview-message" role="alert">
          {error}
          <p>
            {t('spacePreview.viewer.openWithDefaultHint', {
              defaultValue: 'Use the default app from the window menu.',
            })}
          </p>
        </div>
      </>
    );
  if (!entries)
    return (
      <div className="preview-message" role="status">
        <span className="spinner" />
        {t('spacePreview.viewer.readingArchiveDirectory', {
          defaultValue: 'Reading the archive directory…',
        })}
      </div>
    );
  const tree = (children: ArchiveNode[], parent = '', depth = 0): React.ReactNode => {
    const limit = visible[parent] ?? 100;
    return (
      <>
        {children.slice(0, limit).map((node) => {
          const reason = node.entry ? entryReason(node.entry) : '';
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-expanded={node.children ? expanded.has(node.id) : undefined}
              aria-selected={selected === node.id}
            >
              <button
                className={`directory-row ${selected === node.id ? 'selected' : ''}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                title={reason ? `${node.name} · ${reason}` : (node.entry?.name ?? node.id)}
                disabled={Boolean(reason) || (!zip && extracting)}
                onClick={() => (node.children ? toggle(node.id) : void openEntry(node.entry!))}
              >
                {node.children ? (
                  expanded.has(node.id) ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )
                ) : (
                  <span className="tree-indent" />
                )}
                <FileIcon name={node.name} folder={!!node.children} size={16} />
                <span>{node.name}</span>
              </button>
              {node.children && expanded.has(node.id) && (
                <div role="group">{tree(node.children, node.id, depth + 1)}</div>
              )}
            </div>
          );
        })}
        {children.length > limit && (
          <button
            className="directory-more"
            onClick={() => setVisible((current) => ({ ...current, [parent]: limit + 100 }))}
          >
            {t('spacePreview.viewer.showMore', {
              defaultValue: 'Show more ({{count}} remaining)',
              count: children.length - limit,
            })}
          </button>
        )}
        {!children.length && (
          <p className="directory-note">
            {query
              ? t('spacePreview.viewer.noMatchingFiles', {
                  defaultValue: 'No file matches the search.',
                })
              : t('spacePreview.viewer.emptyFolder', { defaultValue: 'Empty folder' })}
          </p>
        )}
      </>
    );
  };
  const current = stack.at(-1);
  return (
    <div className="directory-preview archive-tree-preview">
      {passwordControls}
      <ArchiveSidebar>
        <label className="search archive-tree-search">
          <Search size={14} />
          <input
            aria-label={t('spacePreview.viewer.filterArchiveContents', {
              defaultValue: 'Filter the archive contents',
            })}
            placeholder={t('spacePreview.viewer.searchArchive', {
              defaultValue: 'Search the archive',
            })}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisible({});
            }}
          />
        </label>
        <div
          className="directory-tree"
          role="tree"
          aria-label={t('spacePreview.viewer.archiveDirectory', {
            defaultValue: 'Archive directory',
          })}
          onKeyDown={(event) => {
            if (
              !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                event.key,
              )
            )
              return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '.directory-row:not(:disabled)',
              ),
            );
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            event.stopPropagation();
            const node = buttons[index].parentElement!;
            if (event.key === 'ArrowRight') {
              if (node.getAttribute('aria-expanded') === 'false') buttons[index].click();
              else if (node.getAttribute('aria-expanded') === 'true') buttons[index + 1]?.focus();
            } else if (event.key === 'ArrowLeft') {
              if (node.getAttribute('aria-expanded') === 'true') buttons[index].click();
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
          {tree(matches, query ? 'search' : '')}
        </div>
        <div className="directory-note">
          {t('spacePreview.viewer.archiveItems', {
            defaultValue: '{{total}} items · {{size}}',
            total: entries.length.toLocaleString(),
            size: formatSize(file.size),
          })}
        </div>
      </ArchiveSidebar>
      <section className="directory-content">
        {extracting || entryError ? (
          <div className="preview-message" role={entryError ? 'alert' : 'status'}>
            {extracting && <span className="spinner" />}
            {entryError ||
              t('spacePreview.viewer.readingSelected', {
                defaultValue: 'Reading the selected file…',
              })}
            {extracting && (
              <button
                onClick={() => {
                  extraction.current?.abort();
                  setExtracting(false);
                  if (!zip) setReload((value) => value + 1);
                }}
              >
                {t('spacePreview.viewer.cancel', { defaultValue: 'Cancel' })}
              </button>
            )}
          </div>
        ) : current ? (
          <>
            <div className="directory-file-heading">
              {stack.length > 1 && (
                <button
                  aria-label={t('spacePreview.viewer.backToParentFile', {
                    defaultValue: 'Back to the parent file',
                  })}
                  onClick={() => setStack((value) => value.slice(0, -1))}
                >
                  <ArrowLeft size={16} />
                </button>
              )}
              <span>{current.name}</span>
            </div>
            <div className="directory-file-preview">
              <Preview
                key={current.id}
                file={current}
                mode="auto"
                onOpen={(entry) => setStack((value) => [...value, entry])}
              />
            </div>
          </>
        ) : (
          <div className="preview-message">
            <FolderOpen size={40} />
            <h3>{file.name}</h3>
            <p>
              {t('spacePreview.viewer.archiveHint', {
                defaultValue: 'Expand a folder on the left and pick a file to view its contents.',
              })}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function ArchiveSidebar({ children }: { children: React.ReactNode }) {
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
