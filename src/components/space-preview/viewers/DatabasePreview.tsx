import { usePreviewLoading } from './PreviewLoading';
import { useEffect, useRef, useState } from 'react';
import PreviewToolbar from './PreviewToolbar';
import { TextAppearanceControls } from './TextAppearance';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { readBytes, readFullBytes } from '@/lib/space-preview/bridge';
import {
  isSqliteDatabase,
  type DatabasePage,
  type DatabaseTable,
} from '@/lib/space-preview/engine/database';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { errorText } from './errors';

export default function DatabasePreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [tables, setTables] = useState<DatabaseTable[]>([]);
  const [table, setTable] = useState('');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<DatabasePage>();
  const [schema, setSchema] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  usePreviewLoading(
    loading && !error,
    t('spacePreview.viewer.queryingDatabase', { defaultValue: 'Querying the database' }),
  );
  const worker = useRef<Worker | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const instance = new Worker(new URL('./database.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.current = instance;
    instance.onmessage = (event) => {
      if (controller.signal.aborted || event.data.id !== sequence.current) return;
      setLoading(false);
      if (event.data.error) {
        setError(event.data.error);
        return;
      }
      if (event.data.tables) {
        setTables(event.data.tables);
        setTable(event.data.tables[0]?.name ?? '');
      } else setResult(event.data.result);
    };
    instance.onerror = () => {
      setError(
        t('spacePreview.viewer.databaseParseFailed', {
          defaultValue:
            'The database could not be parsed; the file may be damaged or encrypted.',
        }),
      );
      setLoading(false);
    };
    void readBytes(file, 16)
      .then((header) => {
        controller.signal.throwIfAborted();
        if (!isSqliteDatabase(header))
          throw new Error(
            t('spacePreview.viewer.databaseNotSqlite', {
              defaultValue:
                'The file header is not standard SQLite. A .db file may also be an application cache or an encrypted database, so its tables and records cannot be read here. Check the file information, or open it with the app that created it.',
            }),
          );
        return readFullBytes(file, controller.signal);
      })
      .then((bytes) => {
        if (!controller.signal.aborted)
          instance.postMessage({ id: ++sequence.current, bytes }, [bytes.buffer]);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorText(e));
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      instance.terminate();
      worker.current = null;
    };
  }, [file, t]);
  useEffect(() => {
    if (!table || !worker.current) return;
    setLoading(true);
    setError('');
    setResult(undefined);
    worker.current.postMessage({ id: ++sequence.current, table, page });
  }, [table, page]);
  if (error)
    return (
      <div className="preview-message" role="alert">
        <h3>
          {t('spacePreview.viewer.databaseUnavailable', {
            defaultValue: 'The database contents cannot be previewed',
          })}
        </h3>
        <p>{error}</p>
      </div>
    );
  return (
    <div className="database-preview">
      <TextAppearanceControls />
      <PreviewToolbar className="content-toolbar">
        <span>
          {t('spacePreview.viewer.databaseRecords', {
            defaultValue: 'SQLite · read-only · {{total}} records',
            total: result?.count.toLocaleString() ?? '…',
          })}
        </span>
        <button onClick={() => setSchema((value) => !value)}>
          {schema
            ? t('spacePreview.viewer.viewRecords', { defaultValue: 'View records' })
            : t('spacePreview.viewer.viewSchema', { defaultValue: 'View the table schema' })}
        </button>
        <button disabled={loading || !page} onClick={() => setPage((value) => value - 1)}>
          {t('spacePreview.viewer.previousPage', { defaultValue: 'Previous page' })}
        </button>
        <span>
          {page + 1} / {Math.max(1, Math.ceil((result?.count ?? 0) / 200))}
        </span>
        <button
          disabled={loading || !result || (page + 1) * 200 >= result.count}
          onClick={() => setPage((value) => value + 1)}
        >
          {t('spacePreview.viewer.nextPage', { defaultValue: 'Next page' })}
        </button>
      </PreviewToolbar>
      <aside
        className="database-tables"
        aria-label={t('spacePreview.viewer.databaseTables', { defaultValue: 'Database tables' })}
      >
        <h2>{t('spacePreview.viewer.tablesAndViews', { defaultValue: 'Tables and views' })}</h2>
        {tables.map((item) => (
          <button
            key={item.name}
            aria-pressed={item.name === table}
            className={item.name === table ? 'active' : ''}
            onClick={() => {
              setTable(item.name);
              setPage(0);
            }}
          >
            {item.name}
            <small>
              {item.type === 'view'
                ? t('spacePreview.viewer.viewType', { defaultValue: 'view' })
                : t('spacePreview.viewer.tableType', { defaultValue: 'table' })}
            </small>
          </button>
        ))}
      </aside>
      <div className="database-content">
        {loading ? (
          <div className="preview-message" role="status">
            <span className="spinner" />
            {t('spacePreview.viewer.readingDatabase', { defaultValue: 'Reading the database…' })}
          </div>
        ) : !table ? (
          <div className="preview-message">
            {t('spacePreview.viewer.databaseNoTables', {
              defaultValue: 'The database has no tables.',
            })}
          </div>
        ) : schema ? (
          <pre className="database-schema">{result?.schema}</pre>
        ) : (
          result && (
            <table className="database-grid">
              <thead>
                <tr>
                  {result.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((value, j) => (
                      <td key={j} title={value}>
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}
