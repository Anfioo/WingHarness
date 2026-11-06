//! SQL text per dialect for introspection: quoting, catalogs, columns, indexes,
//! foreign keys, triggers, routines and sequences. Pure functions, so they are
//! unit-tested without a server.
//!
//! Ported from `ide_db::sql` of the reference project (Apache-2.0), keeping the
//! introspection queries. The table paging, row editing and DDL helpers are
//! declared but not implemented yet. The query builders for SQL Server,
//! ClickHouse and Oracle are kept as strings (they never run — `Pool::connect`
//! rejects those drivers) so the match arms stay exhaustive.

use crate::models::{DbRowEdit, SortKey};
use crate::objects::DbObjectKind;
use crate::source::DbDriver;

pub fn quote_ident(driver: DbDriver, name: &str) -> String {
    match driver {
        DbDriver::Clickhouse => format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`")),
        DbDriver::Mysql => format!("`{}`", name.replace('`', "``")),
        DbDriver::SqlServer => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

pub fn quote_literal(driver: DbDriver, value: &str) -> String {
    let mut text = value.replace('\'', "''");
    if matches!(driver, DbDriver::Mysql | DbDriver::Clickhouse) {
        text = text.replace('\\', "\\\\");
    }
    format!("'{text}'")
}

/// `schema.table`; an empty schema is left out.
pub fn qualified(driver: DbDriver, schema: &str, table: &str) -> String {
    if schema.is_empty() {
        quote_ident(driver, table)
    } else {
        format!("{}.{}", quote_ident(driver, schema), quote_ident(driver, table))
    }
}

/// PostgreSQL databases one can connect to; template databases only with `templates`.
pub fn databases(templates: bool) -> &'static str {
    if templates {
        "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname"
    } else {
        "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname"
    }
}

/// Databases of managed services that their users cannot use (hidden unless connected to).
pub const INTERNAL_DATABASES: &[&str] = &["rdsadmin", "azure_maintenance", "azure_sys", "cloudsqladmin"];

pub fn schemas(driver: DbDriver, system: bool) -> &'static str {
    match driver {
        DbDriver::Sqlite => "SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq",
        DbDriver::Clickhouse if system => "SELECT name FROM system.databases ORDER BY name",
        DbDriver::Clickhouse => {
            "SELECT name FROM system.databases WHERE lower(name) NOT IN ('system', 'information_schema') ORDER BY name"
        }
        DbDriver::Postgres if system => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT LIKE 'pg\\_toast%' AND schema_name NOT LIKE 'pg\\_temp%' ORDER BY 1"
        }
        DbDriver::Mysql if system => "SELECT schema_name FROM information_schema.schemata ORDER BY 1",
        DbDriver::SqlServer if system => "SELECT schema_name FROM information_schema.schemata ORDER BY 1",
        DbDriver::Oracle if system => "SELECT username FROM all_users ORDER BY username",
        DbDriver::Oracle => {
            "SELECT username FROM all_users WHERE username NOT IN \
             ('CTXSYS', 'DBSFWUSER', 'DVSYS', 'GSMADMIN_INTERNAL', 'LBACSYS', 'MDDATA', 'MDSYS', 'OLAPSYS', \
             'OUTLN', 'SYS', 'SYSTEM', 'XDB', 'XS$NULL') ORDER BY username"
        }
        DbDriver::Postgres => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('pg_catalog', 'information_schema') \
             AND schema_name NOT LIKE 'pg\\_toast%' AND schema_name NOT LIKE 'pg\\_temp%' ORDER BY 1"
        }
        DbDriver::Mysql => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY 1"
        }
        DbDriver::SqlServer => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('sys', 'information_schema', 'guest') ORDER BY 1"
        }
    }
}

/// Rows: `name, kind` where kind is `table`, `view` or `materialized view`.
pub fn tables(driver: DbDriver, schema: &str) -> String {
    match driver {
        DbDriver::Clickhouse => format!(
            "SELECT name, CASE engine WHEN 'View' THEN 'view' WHEN 'MaterializedView' THEN 'materialized view' \
             WHEN 'WindowView' THEN 'view' ELSE 'table' END FROM system.tables \
             WHERE database = {} AND is_temporary = 0 ORDER BY name",
            quote_literal(driver, schema)
        ),
        DbDriver::Sqlite => format!(
            "SELECT name, type FROM {}.sqlite_master WHERE type IN ('table', 'view') \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
            quote_ident(driver, schema)
        ),
        DbDriver::Oracle => format!(
            "SELECT table_name, 'table' FROM all_tables WHERE owner = {} \
             UNION ALL SELECT view_name, 'view' FROM all_views WHERE owner = {} ORDER BY 1",
            quote_literal(driver, schema),
            quote_literal(driver, schema)
        ),
        DbDriver::Postgres => format!(
            "SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {} AND c.relkind IN ('r', 'v', 'm', 'p', 'f') ORDER BY 1",
            quote_literal(driver, schema)
        ),
        DbDriver::Mysql => format!(
            "SELECT table_name, CASE WHEN table_type LIKE '%VIEW%' THEN 'view' ELSE 'table' END \
             FROM information_schema.tables WHERE table_schema = {} ORDER BY 1",
            quote_literal(driver, schema)
        ),
        DbDriver::SqlServer => format!(
            "SELECT table_name, CASE WHEN table_type LIKE '%VIEW%' THEN 'view' ELSE 'table' END \
             FROM information_schema.tables WHERE table_schema = {} ORDER BY 1",
            quote_literal(driver, schema)
        ),
    }
}

/// Rows: `name, type, nullable (YES/NO or 0/1), default, is_pk (0/1)`.
pub fn columns(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => format!(
            "SELECT name, type, CASE WHEN startsWith(type, 'Nullable(') \
             OR startsWith(type, 'LowCardinality(Nullable(') THEN 'YES' ELSE 'NO' END, \
             if(default_kind = '', NULL, default_expression), is_in_primary_key \
             FROM system.columns WHERE database = {s} AND table = {t} ORDER BY position"
        ),
        DbDriver::Sqlite => format!(
            "SELECT name, type, CASE WHEN \"notnull\" = 0 THEN 'YES' ELSE 'NO' END, dflt_value, \
             CASE WHEN pk > 0 THEN 1 ELSE 0 END FROM pragma_table_info({t}, {s}) ORDER BY cid"
        ),
        DbDriver::Postgres => format!(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
             CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name \
               AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema \
               AND tc.table_name = c.table_name AND k.column_name = c.column_name) THEN 1 ELSE 0 END \
             FROM information_schema.columns c WHERE c.table_schema = {s} AND c.table_name = {t} \
             ORDER BY c.ordinal_position"
        ),
        DbDriver::Mysql => format!(
            "SELECT column_name, column_type, is_nullable, column_default, \
             CASE WHEN column_key = 'PRI' THEN 1 ELSE 0 END \
             FROM information_schema.columns WHERE table_schema = {s} AND table_name = {t} \
             ORDER BY ordinal_position"
        ),
        DbDriver::SqlServer => format!(
            "SELECT column_name, data_type, is_nullable, column_default, \
             CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name \
               AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = {s} \
               AND tc.table_name = {t} AND k.column_name = c.column_name) THEN 1 ELSE 0 END \
             FROM information_schema.columns c WHERE c.table_schema = {s} AND c.table_name = {t} \
             ORDER BY c.ordinal_position"
        ),
        DbDriver::Oracle => format!(
            "SELECT c.column_name, c.data_type, DECODE(c.nullable, 'Y', 'YES', 'NO'), c.data_default, \
             CASE WHEN k.column_name IS NOT NULL THEN 1 ELSE 0 END \
             FROM all_tab_columns c \
             LEFT JOIN (SELECT kc.column_name FROM all_constraints con \
               JOIN all_cons_columns kc ON kc.owner = con.owner AND kc.table_name = con.table_name \
               AND kc.constraint_name = con.constraint_name \
               WHERE con.constraint_type = 'P' AND con.owner = {s} AND con.table_name = {t}) k \
             ON k.column_name = c.column_name \
             WHERE c.owner = {s} AND c.table_name = {t} ORDER BY c.column_id"
        ),
    }
}

/// Rows: `index name, unique (0/1), column` (one row per indexed column, in order).
pub fn indexes(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => format!(
            "SELECT * FROM (SELECT 'PRIMARY KEY' AS index_name, 0 AS is_unique, primary_key AS expression \
             FROM system.tables WHERE database = {s} AND name = {t} AND primary_key != '' \
             UNION ALL SELECT name, 0, expr FROM system.data_skipping_indices \
             WHERE database = {s} AND table = {t}) ORDER BY index_name"
        ),
        DbDriver::Sqlite => format!(
            "SELECT il.name, il.\"unique\", ii.name FROM pragma_index_list({t}, {s}) il \
             JOIN pragma_index_info(il.name, {s}) ii ORDER BY il.name, ii.seqno"
        ),
        DbDriver::Postgres => format!(
            "SELECT i.relname, CASE WHEN ix.indisunique THEN 1 ELSE 0 END, a.attname \
             FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
             WHERE n.nspname = {s} AND t.relname = {t} ORDER BY i.relname, k.ord"
        ),
        DbDriver::Mysql => format!(
            "SELECT index_name, CASE WHEN non_unique = 0 THEN 1 ELSE 0 END, column_name \
             FROM information_schema.statistics WHERE table_schema = {s} AND table_name = {t} \
             ORDER BY index_name, seq_in_index"
        ),
        DbDriver::SqlServer => format!(
            "SELECT i.name, CASE WHEN i.is_unique = 1 THEN 1 ELSE 0 END, c.name \
             FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE OBJECT_SCHEMA_NAME(i.object_id) = {s} AND OBJECT_NAME(i.object_id) = {t} AND i.name IS NOT NULL \
             ORDER BY i.name, ic.key_ordinal"
        ),
        DbDriver::Oracle => format!(
            "SELECT i.index_name, CASE WHEN i.uniqueness = 'UNIQUE' THEN 1 ELSE 0 END, ic.column_name \
             FROM all_indexes i JOIN all_ind_columns ic \
             ON ic.index_owner = i.owner AND ic.index_name = i.index_name \
             WHERE i.owner = {s} AND i.table_name = {t} ORDER BY i.index_name, ic.column_position"
        ),
    }
}

/// The foreign-key rows of one table:
/// `schema, table, constraint, column, ref schema, ref table, ref column`.
pub fn table_foreign_keys(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => "SELECT '', '', '', '', '', '', '' WHERE 0".to_owned(),
        DbDriver::Sqlite => format!(
            "SELECT {s}, {t}, f.id, f.\"from\", {s}, f.\"table\", f.\"to\" \
             FROM pragma_foreign_key_list({t}, {s}) f ORDER BY f.id, f.seq"
        ),
        DbDriver::Postgres => format!(
            "SELECT sn.nspname, sc.relname, con.conname, sa.attname, tn.nspname, tc.relname, ta.attname \
             FROM pg_constraint con \
             JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace \
             JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace \
             CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(s, t, ord) \
             JOIN pg_attribute sa ON sa.attrelid = sc.oid AND sa.attnum = k.s \
             JOIN pg_attribute ta ON ta.attrelid = tc.oid AND ta.attnum = k.t \
             WHERE con.contype = 'f' AND sn.nspname = {s} AND sc.relname = {t} ORDER BY 3, k.ord"
        ),
        DbDriver::Mysql => format!(
            "SELECT table_schema, table_name, constraint_name, column_name, \
             referenced_table_schema, referenced_table_name, referenced_column_name \
             FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL \
             AND table_schema = {s} AND table_name = {t} ORDER BY constraint_name, ordinal_position"
        ),
        DbDriver::SqlServer => format!(
            "SELECT table_schema, table_name, constraint_name, column_name, \
             referenced_table_schema, referenced_table_name, referenced_column_name \
             FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL \
             AND table_schema = {s} AND table_name = {t} ORDER BY constraint_name, ordinal_position"
        ),
        DbDriver::Oracle => format!(
            "SELECT con.owner, con.table_name, con.constraint_name, col.column_name, \
             rcon.owner, rcon.table_name, rcol.column_name \
             FROM all_constraints con \
             JOIN all_cons_columns col ON col.owner = con.owner AND col.table_name = con.table_name \
             AND col.constraint_name = con.constraint_name \
             JOIN all_constraints rcon ON rcon.owner = con.r_owner AND rcon.constraint_name = con.r_constraint_name \
             JOIN all_cons_columns rcol ON rcol.owner = rcon.owner AND rcol.table_name = rcon.table_name \
             AND rcol.constraint_name = rcon.constraint_name \
             WHERE con.constraint_type = 'R' AND con.owner = {s} AND con.table_name = {t} \
             ORDER BY con.constraint_name, col.position"
        ),
    }
}

/// Rows: `name, timing, events` of the triggers of a table (SQLite: `name, sql`).
pub fn triggers(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => "SELECT '', '', '' WHERE 0".to_owned(),
        DbDriver::Sqlite => format!(
            "SELECT name, sql FROM {}.sqlite_master WHERE type = 'trigger' AND tbl_name = {t} ORDER BY name",
            quote_ident(driver, schema)
        ),
        DbDriver::Postgres => format!(
            "SELECT t.tgname, CASE WHEN t.tgtype & 2 <> 0 THEN 'before' WHEN t.tgtype & 64 <> 0 THEN 'instead of' \
             ELSE 'after' END, concat_ws(' or ', CASE WHEN t.tgtype & 4 <> 0 THEN 'insert' END, \
             CASE WHEN t.tgtype & 16 <> 0 THEN 'update' END, CASE WHEN t.tgtype & 8 <> 0 THEN 'delete' END, \
             CASE WHEN t.tgtype & 32 <> 0 THEN 'truncate' END) \
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE NOT t.tgisinternal AND n.nspname = {s} AND c.relname = {t} ORDER BY 1"
        ),
        DbDriver::Mysql => format!(
            "SELECT trigger_name, lower(action_timing), lower(event_manipulation) FROM information_schema.triggers \
             WHERE event_object_schema = {s} AND event_object_table = {t} ORDER BY 1"
        ),
        DbDriver::SqlServer => format!(
            "SELECT t.name, lower(te.type_desc), '' FROM sys.triggers t \
             WHERE OBJECT_SCHEMA_NAME(t.parent_id) = {s} AND OBJECT_NAME(t.parent_id) = {t} ORDER BY 1"
        ),
        DbDriver::Oracle => format!(
            "SELECT trigger_name, CASE WHEN trigger_type LIKE 'BEFORE%' THEN 'before' \
             WHEN trigger_type LIKE 'INSTEAD%' THEN 'instead of' ELSE 'after' END, \
             lower(replace(triggering_event, ' OR ', ',')) \
             FROM all_triggers WHERE owner = {s} AND table_name = {t} ORDER BY 1"
        ),
    }
}

/// `before`, `insert` of SQLite's `CREATE TRIGGER name BEFORE INSERT ON …` (its catalog keeps only the text).
pub fn sqlite_trigger_event(sql: &str) -> (String, String) {
    let upper = sql.to_ascii_uppercase();
    let words: Vec<&str> = upper.split_whitespace().collect();
    let timing = if words.contains(&"BEFORE") {
        "before"
    } else if words.windows(2).any(|window| window == ["INSTEAD", "OF"]) {
        "instead of"
    } else {
        "after"
    };
    let event = ["INSERT", "UPDATE", "DELETE"].into_iter().find(|event| words.contains(event)).unwrap_or_default();
    (timing.to_owned(), event.to_ascii_lowercase())
}

/// Rows: `name, kind (function/procedure), arguments, result` of a schema's routines (none in SQLite).
pub fn routines(driver: DbDriver, schema: &str) -> Option<String> {
    let s = quote_literal(driver, schema);
    match driver {
        DbDriver::Sqlite | DbDriver::Clickhouse => None,
        // Functions of extensions are left out, as in IDEA.
        DbDriver::Postgres => Some(format!(
            "SELECT p.proname, CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END, \
             pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid) \
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {s} AND p.prokind IN ('f', 'p') \
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1, 3"
        )),
        DbDriver::Mysql => Some(format!(
            "SELECT r.routine_name, lower(r.routine_type), \
             (SELECT GROUP_CONCAT(CONCAT(p.parameter_name, ' ', p.dtd_identifier) ORDER BY p.ordinal_position \
              SEPARATOR ', ') FROM information_schema.parameters p WHERE p.specific_schema = r.routine_schema \
              AND p.specific_name = r.specific_name AND p.ordinal_position > 0), r.dtd_identifier \
             FROM information_schema.routines r WHERE r.routine_schema = {s} ORDER BY 1"
        )),
        DbDriver::SqlServer => Some(format!(
            "SELECT r.routine_name, lower(r.routine_type), '', r.data_type \
             FROM information_schema.routines r WHERE r.routine_schema = {s} ORDER BY 1"
        )),
        DbDriver::Oracle => Some(format!(
            "SELECT object_name, CASE object_type WHEN 'PROCEDURE' THEN 'procedure' ELSE 'function' END, '', NULL \
             FROM all_objects WHERE owner = {s} AND object_type IN ('PROCEDURE', 'FUNCTION') \
             AND object_name NOT LIKE 'BIN$%' ORDER BY 1"
        )),
    }
}

/// Rows: `name, data type` of a schema's sequences (PostgreSQL, Oracle).
pub fn sequences(driver: DbDriver, schema: &str) -> Option<String> {
    match driver {
        DbDriver::Postgres => Some(format!(
            "SELECT sequence_name, data_type FROM information_schema.sequences WHERE sequence_schema = {} ORDER BY 1",
            quote_literal(driver, schema)
        )),
        // Every sequence is numeric; ALL_SEQUENCES has no data_type column before 18c.
        DbDriver::Oracle => Some(format!(
            "SELECT sequence_name, 'NUMBER' FROM all_sequences WHERE sequence_owner = {} ORDER BY 1",
            quote_literal(driver, schema)
        )),
        _ => None,
    }
}

/// Rows: `name, data type, nullable, default, primary key` of every column of
/// the catalog, for the completion model.
pub fn completion_columns(_driver: DbDriver) -> &'static str {
    ""
}

/// Rows: `schema, table, column, ref schema, ref table, ref column` of every
/// foreign key of the catalog, for the completion model.
pub fn foreign_keys(_driver: DbDriver) -> &'static str {
    ""
}

/// The schema a query resolves unqualified names in (PostgreSQL's
/// `search_path`), where the driver reports one.
pub fn current_schema(_driver: DbDriver) -> Option<&'static str> {
    None
}

/// One page of a table: `SELECT * FROM table [WHERE filter] [ORDER BY …]
/// LIMIT limit + 1 OFFSET offset`. The extra row tells the caller there is
/// another page.
pub fn table_page(
    _driver: DbDriver,
    _schema: &str,
    _table: &str,
    _filter: Option<&str>,
    _sort: &[SortKey],
    _offset: u64,
    _limit: u64,
) -> String {
    String::new()
}

/// The one statement that applies a row edit (update, insert or delete).
pub fn edit_statement(
    _driver: DbDriver,
    _schema: &str,
    _table: &str,
    _edit: &DbRowEdit,
) -> Result<String, String> {
    Err("not implemented".into())
}

/// SQLite keeps the `CREATE TABLE` text in its catalog.
pub fn sqlite_ddl(_schema: &str, _name: &str) -> String {
    String::new()
}

/// PostgreSQL relation lookup by schema and name; the row carries the OID the
/// column, constraint and index queries are run against.
pub fn postgres_relation(_schema: &str, _name: &str) -> String {
    String::new()
}

/// PostgreSQL column rows of the relation with this OID.
pub fn postgres_ddl_columns(_oid: u32) -> String {
    String::new()
}

/// PostgreSQL constraint rows of the relation with this OID.
pub fn postgres_ddl_constraints(_oid: u32) -> String {
    String::new()
}

/// PostgreSQL index rows of the relation with this OID.
pub fn postgres_ddl_indexes(_oid: u32) -> String {
    String::new()
}

/// One column of a `CREATE TABLE` assembled from PostgreSQL catalog rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DdlColumn {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub default: Option<String>,
}

/// Assembles `CREATE TABLE` from the catalog rows read for it.
pub fn postgres_table_ddl(
    _schema: &str,
    _name: &str,
    _columns: &[DdlColumn],
    _constraints: &[(String, String)],
    _indexes: &[String],
) -> String {
    String::new()
}

/// The definition of a routine, trigger or sequence, and the column its text
/// starts at (`None` where the driver has no such object).
pub fn object_ddl(
    _driver: DbDriver,
    _schema: &str,
    _kind: DbObjectKind,
    _name: &str,
) -> Option<(String, usize)> {
    Some((String::new(), 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(quote_ident(DbDriver::Postgres, "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident(DbDriver::Mysql, "a`b"), "`a``b`");
        assert_eq!(quote_ident(DbDriver::SqlServer, "a]b"), "[a]]b]");
        assert_eq!(quote_literal(DbDriver::Sqlite, "it's \\"), "'it''s \\'");
        assert_eq!(quote_literal(DbDriver::Mysql, "it's \\"), "'it''s \\\\'");
        assert_eq!(qualified(DbDriver::Postgres, "public", "users"), "\"public\".\"users\"");
        assert_eq!(qualified(DbDriver::Mysql, "", "users"), "`users`");
    }

    #[test]
    fn postgres_catalog_queries() {
        assert_eq!(
            databases(false),
            "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname"
        );
        assert!(databases(true).contains("WHERE datallowconn"));
        assert!(schemas(DbDriver::Postgres, false).contains("'pg_catalog', 'information_schema'"));
        assert!(schemas(DbDriver::Postgres, true).contains("NOT LIKE 'pg\\_toast%'"));
        let relations = tables(DbDriver::Postgres, "public");
        assert!(relations.contains("n.nspname = 'public'"));
        assert!(relations.contains("WHEN 'm' THEN 'materialized view'"));
        assert!(columns(DbDriver::Postgres, "public", "users").contains("information_schema.columns"));
        assert!(indexes(DbDriver::Postgres, "public", "users").contains("pg_index"));
        assert!(table_foreign_keys(DbDriver::Postgres, "public", "users").contains("con.contype = 'f'"));
        assert!(triggers(DbDriver::Postgres, "public", "users").contains("NOT t.tgisinternal"));
        assert!(routines(DbDriver::Postgres, "public").unwrap().contains("p.prokind IN ('f', 'p')"));
        assert!(sequences(DbDriver::Postgres, "public").unwrap().contains("information_schema.sequences"));
    }

    #[test]
    fn mysql_catalog_queries() {
        assert!(schemas(DbDriver::Mysql, false).contains("'information_schema', 'mysql'"));
        assert_eq!(schemas(DbDriver::Mysql, true), "SELECT schema_name FROM information_schema.schemata ORDER BY 1");
        assert!(tables(DbDriver::Mysql, "shop").contains("table_schema = 'shop'"));
        assert!(columns(DbDriver::Mysql, "shop", "orders").contains("column_key = 'PRI'"));
        assert!(indexes(DbDriver::Mysql, "shop", "orders").contains("information_schema.statistics"));
        assert!(table_foreign_keys(DbDriver::Mysql, "shop", "orders").contains("referenced_table_name"));
        assert!(triggers(DbDriver::Mysql, "shop", "orders").contains("information_schema.triggers"));
        assert!(routines(DbDriver::Mysql, "shop").unwrap().contains("information_schema.routines"));
        assert!(sequences(DbDriver::Mysql, "shop").is_none());
    }

    #[test]
    fn sqlite_catalog_queries() {
        assert_eq!(
            schemas(DbDriver::Sqlite, false),
            "SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq"
        );
        assert!(tables(DbDriver::Sqlite, "main").contains("\"main\".sqlite_master"));
        // SQLite escapes its own catalog names in LIKE; the pattern is not a wildcard.
        assert!(tables(DbDriver::Sqlite, "main").contains("name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"));
        assert!(columns(DbDriver::Sqlite, "main", "t").contains("pragma_table_info('t', 'main')"));
        assert!(indexes(DbDriver::Sqlite, "main", "t").contains("pragma_index_list"));
        assert!(table_foreign_keys(DbDriver::Sqlite, "main", "t").contains("pragma_foreign_key_list"));
        assert!(triggers(DbDriver::Sqlite, "main", "t").contains("type = 'trigger'"));
        assert!(routines(DbDriver::Sqlite, "main").is_none());
        assert!(sequences(DbDriver::Sqlite, "main").is_none());
    }

    #[test]
    fn sqlite_trigger_events() {
        let event = sqlite_trigger_event;
        assert_eq!(
            event("CREATE TRIGGER t BEFORE UPDATE OF a ON x BEGIN SELECT 1; END"),
            ("before".into(), "update".into())
        );
        assert_eq!(event("create trigger t instead of insert on v begin end"), ("instead of".into(), "insert".into()));
        assert_eq!(event("CREATE TRIGGER t DELETE ON x BEGIN END"), ("after".into(), "delete".into()));
    }

    #[test]
    fn schema_objects_per_dialect() {
        assert!(routines(DbDriver::Sqlite, "main").is_none());
        assert!(sequences(DbDriver::Mysql, "db").is_none());
        assert!(routines(DbDriver::Postgres, "public").unwrap().contains("n.nspname = 'public'"));
        assert!(sequences(DbDriver::Postgres, "public").unwrap().contains("sequence_schema = 'public'"));
        assert!(routines(DbDriver::Clickhouse, "default").is_none());
        assert!(sequences(DbDriver::Clickhouse, "default").is_none());
    }
}
