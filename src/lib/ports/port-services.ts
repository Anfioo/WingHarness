// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.

import { Code, Database, FileCode, Globe, Package, Server, type LucideIcon } from "lucide-react";

export type PortServiceInfo = {
  /** Well-known service name, or null when the port has no entry. */
  label: string | null;
  icon: LucideIcon;
};

const PORT_SERVICES: Record<number, { label: string; icon: LucideIcon }> = {
  // Web servers
  80: { label: "HTTP", icon: Globe },
  443: { label: "HTTPS", icon: Globe },
  8080: { label: "HTTP Alt", icon: Globe },
  8000: { label: "HTTP Dev", icon: Globe },
  3000: { label: "React/Node", icon: Globe },
  3001: { label: "Next.js", icon: Globe },
  4200: { label: "Angular", icon: Globe },
  5173: { label: "Vite", icon: Globe },
  5000: { label: "Flask", icon: Globe },

  // Databases
  5432: { label: "PostgreSQL", icon: Database },
  3306: { label: "MySQL", icon: Database },
  27017: { label: "MongoDB", icon: Database },
  6379: { label: "Redis", icon: Database },
  1433: { label: "MSSQL", icon: Database },

  // Application servers
  9000: { label: "PHP-FPM", icon: Server },
  8081: { label: "App Server", icon: Server },

  // Debuggers
  9229: { label: "Node Debug", icon: Code },
  5858: { label: "Java Debug", icon: Code },

  // Package registry
  4873: { label: "Verdaccio", icon: Package },
};

/** Service name and icon for a port; unmapped ports get a neutral icon and no label. */
export function portService(port: number): PortServiceInfo {
  return PORT_SERVICES[port] ?? { label: null, icon: FileCode };
}
