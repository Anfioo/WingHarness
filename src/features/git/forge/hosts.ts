import { forgeKindForProvider, registerForgeHosts } from "@/lib/git-core/forge";
import { accountList, type HostingAccount } from "@/commands";

export function seedForgeHosts(accounts: HostingAccount[]): void {
  registerForgeHosts(
    accounts.flatMap((account) => {
      const kind = forgeKindForProvider(account.provider);
      return kind ? [{ host: account.host, kind }] : [];
    })
  );
}

export async function seedForgeHostsFromAccounts(): Promise<void> {
  try {
    seedForgeHosts(await accountList());
  } catch {
    registerForgeHosts([]);
  }
}
