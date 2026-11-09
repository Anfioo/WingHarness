// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { Database } from 'sql.js';

export function isSqliteDatabase(bytes: Uint8Array): boolean {
  const signature = 'SQLite format 3\0';
  return (
    bytes.length >= signature.length &&
    Array.from(signature).every((character, index) => bytes[index] === character.charCodeAt(0))
  );
}

export function databaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/file is not a database|file is encrypted/i.test(message))
    return '无法读取此数据库：文件可能经过加密，或并非标准 SQLite 格式。';
  if (/database disk image is malformed|malformed database schema/i.test(message))
    return 'SQLite 数据结构不完整或已损坏，无法读取。';
  return message;
}

export interface DatabaseTable {
  name: string;
  type: string;
  sql: string;
}
export interface DatabasePage {
  columns: string[];
  rows: string[][];
  count: number;
  schema: string;
}
const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
export function databaseTables(database: Database): DatabaseTable[] {
  const result = database.exec(
    "SELECT name, type, COALESCE(sql, '') FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )[0];
  return (result?.values ?? []).map((row) => ({
    name: String(row[0]),
    type: String(row[1]),
    sql: String(row[2]),
  }));
}
export function databasePage(database: Database, table: string, page: number): DatabasePage {
  const tables = databaseTables(database);
  const schema = tables.find((item) => item.name === table);
  if (!schema) throw new Error('数据库表不存在。');
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('数据库页码无效。');
  const count = Number(database.exec(`SELECT count(*) FROM ${identifier(table)}`)[0].values[0][0]);
  const statement = database.prepare(`SELECT * FROM ${identifier(table)} LIMIT ? OFFSET ?`);
  try {
    statement.bind([200, page * 200]);
    const columns = statement.getColumnNames();
    const rows: string[][] = [];
    while (statement.step())
      rows.push(
        statement
          .get()
          .map((value) =>
            value === null
              ? 'NULL'
              : value instanceof Uint8Array
                ? `BLOB (${value.length} B) ${Array.from(value.slice(0, 32), (byte) => byte.toString(16).padStart(2, '0')).join(' ')}${value.length > 32 ? ' …' : ''}`
                : String(value),
          ),
      );
    return { columns, rows, count, schema: schema.sql };
  } finally {
    statement.free();
  }
}
