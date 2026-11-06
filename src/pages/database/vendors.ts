// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Presets of the data source form: products that speak the PostgreSQL or MySQL
 * wire protocol, with the port, URL scheme and SSL requirement they use.
 *
 * Only the two network drivers this app implements are listed; a preset of an
 * unimplemented driver would fill in settings that cannot connect.
 */
import type { DbDriver, DbSslMode } from "@/commands";

export type DbVendor = {
  /** Stored in `DataSource.vendor`; empty means the driver itself. */
  id: string;
  /** Product name, shown as is: it is a name, not a translatable string. */
  label: string;
  driver: DbDriver;
  /** The port the product listens on by default. */
  port: number;
  /** URL scheme of the product (`<scheme>://…`). */
  scheme: string;
  /** Set for managed services that only accept encrypted connections. */
  ssl?: DbSslMode;
};

export const VENDORS: readonly DbVendor[] = [
  {
    id: "aurora-mysql",
    label: "Amazon Aurora MySQL",
    driver: "mysql",
    port: 3306,
    scheme: "mysql",
  },
  {
    id: "redshift",
    label: "Amazon Redshift",
    driver: "postgres",
    port: 5439,
    scheme: "redshift",
    ssl: "require",
  },
  {
    id: "cockroachdb",
    label: "CockroachDB",
    driver: "postgres",
    port: 26257,
    scheme: "postgresql",
    ssl: "require",
  },
  { id: "greenplum", label: "Greenplum", driver: "postgres", port: 5432, scheme: "postgresql" },
  { id: "mariadb", label: "MariaDB", driver: "mysql", port: 3306, scheme: "mariadb" },
  { id: "mysql", label: "MySQL", driver: "mysql", port: 3306, scheme: "mysql" },
  {
    id: "neon",
    label: "Neon",
    driver: "postgres",
    port: 5432,
    scheme: "postgresql",
    ssl: "require",
  },
  {
    id: "oceanbase",
    label: "OceanBase (MySQL mode)",
    driver: "mysql",
    port: 2881,
    scheme: "oceanbase",
  },
  { id: "postgres", label: "PostgreSQL", driver: "postgres", port: 5432, scheme: "postgresql" },
  { id: "singlestore", label: "SingleStore", driver: "mysql", port: 3306, scheme: "singlestore" },
  {
    id: "supabase",
    label: "Supabase",
    driver: "postgres",
    port: 5432,
    scheme: "postgresql",
    ssl: "require",
  },
  { id: "tidb", label: "TiDB", driver: "mysql", port: 4000, scheme: "mysql" },
  {
    id: "timescaledb",
    label: "TimescaleDB",
    driver: "postgres",
    port: 5432,
    scheme: "postgresql",
  },
  {
    id: "yugabytedb",
    label: "YugabyteDB",
    driver: "postgres",
    port: 5433,
    scheme: "postgresql",
  },
];

const BY_ID = new Map(VENDORS.map((vendor) => [vendor.id, vendor]));

/** The preset called `id`, or `null` when the id is not a known preset. */
export function vendorById(id: string): DbVendor | null {
  return BY_ID.get(id) ?? null;
}

/** Every preset, in display order. */
export function vendorOptions(): DbVendor[] {
  return [...VENDORS];
}

/** The URL prefix of a preset, for example `postgresql://`. */
export function vendorUrlPrefix(vendor: DbVendor): string {
  return `${vendor.scheme}://`;
}
