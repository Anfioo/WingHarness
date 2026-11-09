import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { List, ChevronLeft, Search, X } from 'lucide-react';
import { readHtmlResource } from '@/commands';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { localResource } from '@/lib/space-preview/engine/html-resources';
import { markdownImageUrl } from '@/lib/space-preview/engine/markdown-images';
import { trackReadingPosition } from './reading-position';
import PreviewToolbar from './PreviewToolbar';
import ReadingWidth from './ReadingWidth';
import { TextAppearanceControls } from './TextAppearance';

export interface OutlineItem {
  id: string;
  title: string;
  level: number;
}
export function ReadingLayout({
  outline,
  onNavigate,
  children,
  toolbar,
  activeId,
  loading = false,
}: {
  outline: OutlineItem[];
  onNavigate: (id: string) => void;
  children: React.ReactNode;
  toolbar?: React.ReactNode;
  activeId?: string;
  loading?: boolean;
}) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(() => !/Mac/i.test(navigator.platform));
  const [active, setActive] = useState('');
  const [width, setWidth] = useState(220);
  const [filter, setFilter] = useState('');
  const nav = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const current = activeId ?? active;
  const showOutline = open && (outline.length > 0 || loading);
  useEffect(() => {
    const button = nav.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!button || !nav.current) return;
    const pane = nav.current.getBoundingClientRect(),
      item = button.getBoundingClientRect();
    if (item.top < pane.top) nav.current.scrollTop += item.top - pane.top - 8;
    else if (item.bottom > pane.bottom) nav.current.scrollTop += item.bottom - pane.bottom + 8;
  }, [current, open, filter]);
  return (
    <div className="reading-view">
      <PreviewToolbar className="reading-tools">
        <button
          className={showOutline ? 'selected' : ''}
          disabled={!outline.length && !loading}
          title={t('spacePreview.viewer.toggleOutline', { defaultValue: 'Toggle the document outline' })}
          aria-expanded={showOutline}
          onClick={() => setOpen((v) => !v)}
        >
          <List size={15} /> {t('spacePreview.viewer.outline', { defaultValue: 'Outline' })}
        </button>
        {toolbar}
      </PreviewToolbar>
      <div className="reading-body">
        {showOutline && (
          <aside
            className="reading-outline"
            aria-label={t('spacePreview.viewer.outline', { defaultValue: 'Outline' })}
            style={{ width }}
          >
            <div className="outline-caption">
              {t('spacePreview.viewer.outline', { defaultValue: 'Outline' })}{' '}
              <span>{outline.length}</span>
              <button
                title={t('spacePreview.viewer.collapseOutline', { defaultValue: 'Collapse the outline' })}
                onClick={() => setOpen(false)}
              >
                <ChevronLeft size={14} />
              </button>
            </div>
            {outline.length > 8 && (
              <label className="outline-search">
                <Search size={13} />
                <input
                  aria-label={t('spacePreview.viewer.searchHeadings', {
                    defaultValue: 'Search the document headings',
                  })}
                  placeholder={t('spacePreview.viewer.searchHeadingsPlaceholder', {
                    defaultValue: 'Search headings',
                  })}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                  <button
                    type="button"
                    aria-label={t('spacePreview.viewer.clearOutlineSearch', {
                      defaultValue: 'Clear the outline search',
                    })}
                    title={t('spacePreview.viewer.clearSearch', { defaultValue: 'Clear the search' })}
                    onClick={(event) => {
                      setFilter('');
                      event.currentTarget.parentElement?.querySelector('input')?.focus();
                    }}
                  >
                    <X size={13} />
                  </button>
                )}
              </label>
            )}
            {loading && !outline.length && (
              <p className="outline-empty" role="status">
                {t('spacePreview.viewer.readingOutline', { defaultValue: 'Reading the outline…' })}
              </p>
            )}
            <nav ref={nav}>
              {outline
                .filter((item) => item.title.toLowerCase().includes(filter.toLowerCase()))
                .map((item) => (
                  <button
                    key={item.id}
                    title={item.title}
                    className={current === item.id ? 'active' : ''}
                    aria-current={current === item.id ? 'location' : undefined}
                    style={{ paddingLeft: 12 + Math.min(item.level - 1, 5) * 12 }}
                    onClick={() => {
                      setActive(item.id);
                      onNavigate(item.id);
                    }}
                  >
                    {item.title}
                  </button>
                ))}
            </nav>
            {filter &&
              !outline.some((item) => item.title.toLowerCase().includes(filter.toLowerCase())) && (
                <p className="outline-empty">
                  {t('spacePreview.viewer.noMatchingHeadings', {
                    defaultValue: 'No heading matches the search.',
                  })}
                </p>
              )}
          </aside>
        )}
        {showOutline && (
          <div
            className="outline-resizer"
            role="separator"
            aria-label={t('spacePreview.viewer.resizeOutline', {
              defaultValue: 'Resize the outline',
            })}
            aria-orientation="vertical"
            aria-valuenow={width}
            aria-valuemin={160}
            aria-valuemax={320}
            tabIndex={0}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, width };
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              if (drag.current)
                setWidth(
                  Math.max(160, Math.min(320, drag.current.width + e.clientX - drag.current.x)),
                );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
                e.stopPropagation();
                e.preventDefault();
                if (e.code !== 'Space')
                  setWidth((w) =>
                    Math.max(160, Math.min(320, w + (e.code === 'ArrowRight' ? 16 : -16))),
                  );
              }
            }}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.stopPropagation();
            }}
          />
        )}
        <div className="reading-content">{children}</div>
      </div>
    </div>
  );
}

export default function DocumentReader({
  html,
  loading = false,
  note,
  toolbar,
  remoteImages = false,
  imagePath,
}: {
  html: string;
  loading?: boolean;
  note?: string;
  toolbar?: React.ReactNode;
  remoteImages?: boolean;
  imagePath?: string;
}) {
  const { t } = useAppTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState('');
  const document = useMemo(() => {
    const safe = DOMPurify.sanitize(html, {
      FORBID_TAGS: [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'form',
        'video',
        'audio',
        'link',
        'meta',
        'base',
      ],
      FORBID_ATTR: ['style', 'srcset'],
    });
    const parsed = new DOMParser().parseFromString(safe, 'text/html');
    // Markdown can reference public images. Other document readers retain embedded images.
    parsed.querySelectorAll('img').forEach((img) => {
      const source = img.getAttribute('src') || '';
      if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(source)) return;
      const url = remoteImages ? markdownImageUrl(source) : null;
      const relative = remoteImages ? localResource(source) : null;
      const local = relative && /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(relative);
      if (!url && !local) {
        img.remove();
        return;
      }
      if (url) img.src = url;
      else {
        img.removeAttribute('src');
        img.setAttribute('data-local-image', relative!);
      }
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      const wrapper = parsed.createElement('span');
      wrapper.className = 'reader-image';
      const error = parsed.createElement('span');
      error.className = 'reader-image-error';
      error.hidden = true;
      error.setAttribute('role', 'status');
      const alt = img.alt || t('spacePreview.viewer.imageFallback', { defaultValue: 'The image' });
      error.textContent = local
        ? t('spacePreview.viewer.localImageFailed', {
            defaultValue:
              '{{alt}} failed to load. Check that the attachment exists, is under 8 MB, and open the original Markdown file from the desktop app.',
            alt,
          })
        : t('spacePreview.viewer.remoteImageFailed', {
            defaultValue:
              '{{alt}} failed to load. The link may be broken or the network unavailable.',
            alt,
          });
      img.replaceWith(wrapper);
      wrapper.append(img, error);
    });
    parsed.querySelectorAll('input').forEach((input) => {
      if (input.type !== 'checkbox') input.remove();
      else input.disabled = true;
    });
    const anchors = new Map<string, string>();
    const counts = new Map<string, number>();
    const outline = Array.from(parsed.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((heading, i) => {
      const title =
        heading.textContent?.trim() ||
        t('spacePreview.viewer.untitledHeading', { defaultValue: 'Untitled' });
      const slug = title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
      const count = counts.get(slug) || 0;
      counts.set(slug, count + 1);
      if (heading.id) anchors.set(heading.id, `reader-heading-${i}`);
      anchors.set(count ? `${slug}-${count}` : slug, `reader-heading-${i}`);
      heading.id = `reader-heading-${i}`;
      return { id: heading.id, title, level: Number(heading.tagName[1]) };
    });
    parsed.querySelectorAll('a[href^="#"]').forEach((a) => {
      try {
        const id = anchors.get(decodeURIComponent(a.getAttribute('href')!.slice(1)));
        if (id) a.setAttribute('href', `#${id}`);
      } catch {
        /* Invalid fragment stays inert. */
      }
    });
    return { html: parsed.body.innerHTML, outline };
  }, [html, remoteImages, t]);
  useEffect(() => {
    if (!scroll.current) return;
    let active = true;
    const urls = new Map<string, Promise<string>>();
    const fail = (img: HTMLImageElement) => {
      img.hidden = true;
      const error = img.nextElementSibling as HTMLElement | null;
      if (error) error.hidden = false;
    };
    const load = async (img: HTMLImageElement) => {
      const relative = img.dataset.localImage!;
      if (!imagePath) {
        fail(img);
        return;
      }
      let pending = urls.get(relative);
      if (!pending) {
        pending = readHtmlResource(relative, imagePath).then((bytes) => {
          if (!active) throw new Error('Preview closed');
          const extension = relative.split('.').at(-1)!.toLowerCase();
          const type =
            extension === 'svg'
              ? 'image/svg+xml'
              : extension === 'jpg'
                ? 'image/jpeg'
                : extension === 'ico'
                  ? 'image/x-icon'
                  : `image/${extension}`;
          return URL.createObjectURL(new Blob([bytes], { type }));
        });
        urls.set(relative, pending);
      }
      try {
        const url = await pending;
        if (active) img.src = url;
      } catch {
        if (active) fail(img);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            void load(entry.target as HTMLImageElement);
          }
      },
      { root: scroll.current, rootMargin: '300px' },
    );
    scroll.current
      .querySelectorAll<HTMLImageElement>('img[data-local-image]')
      .forEach((img) => observer.observe(img));
    return () => {
      active = false;
      observer.disconnect();
      for (const pending of urls.values())
        void pending.then(
          (url) => URL.revokeObjectURL(url),
          () => {},
        );
    };
  }, [document, imagePath]);
  useEffect(() => {
    if (!scroll.current) return;
    const headings = document.outline.flatMap((item) => {
      const element = scroll.current!.querySelector(`#${item.id}`);
      return element ? [{ id: item.id, element }] : [];
    });
    return trackReadingPosition(scroll.current, headings, setActiveId);
  }, [document]);
  return (
    <ReadingLayout
      loading={loading}
      outline={document.outline}
      activeId={activeId}
      onNavigate={(id) =>
        globalThis.document.getElementById(id)?.scrollIntoView({ block: 'start' })
      }
      toolbar={toolbar}
    >
      <ReadingWidth>
        <div className="document-scroll" ref={scroll}>
          <TextAppearanceControls />
          {note && <div className="document-note">{note}</div>}
          <article
            className="document-paper prose"
            style={{
              fontSize: 'var(--preview-font-size, 16px)',
              fontFamily: 'var(--preview-font-family, var(--font-reading))',
            }}
            onClick={(e) => {
              const anchor = (e.target as HTMLElement).closest('a');
              if (anchor) {
                e.preventDefault();
                const href = anchor.getAttribute('href');
                if (href?.startsWith('#reader-heading-'))
                  globalThis.document
                    .getElementById(href.slice(1))
                    ?.scrollIntoView({ block: 'start' });
              }
            }}
            onErrorCapture={(event) => {
              const image = event.target;
              if (
                image instanceof HTMLImageElement &&
                image.parentElement?.classList.contains('reader-image')
              ) {
                image.hidden = true;
                const error = image.nextElementSibling as HTMLElement | null;
                if (error) error.hidden = false;
              }
            }}
            dangerouslySetInnerHTML={{ __html: document.html }}
          />
        </div>
      </ReadingWidth>
    </ReadingLayout>
  );
}
