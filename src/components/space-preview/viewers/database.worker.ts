import initSqlJs, { type Database } from 'sql.js';
import { databaseTables, databasePage, databaseError } from '@/lib/space-preview/engine/database';

// The SQLite engine runs off the main thread: a large database would otherwise
// freeze the viewer while it is loaded and queried.
let database: Database | undefined;

self.onmessage = async (
  event: MessageEvent<{ id: number; bytes?: Uint8Array; table?: string; page?: number }>,
) => {
  const { id, bytes, table, page } = event.data;
  try {
    if (bytes) {
      const SQL = await initSqlJs({
        locateFile: () => new URL('/engines/sql-wasm.wasm', self.location.href).href,
      });
      database?.close();
      database = new SQL.Database(bytes);
      database.run('PRAGMA query_only = ON');
      self.postMessage({ id, tables: databaseTables(database) });
    } else {
      if (!database || !table) throw new Error('The database is not loaded yet.');
      self.postMessage({ id, result: databasePage(database, table, page ?? 0) });
    }
  } catch (error) {
    self.postMessage({ id, error: databaseError(error) });
  }
};
