import { AppShell } from "@/components/app-shell";
import { ProvidersTab } from "./providers-tab";

/**
 * CC Switch 页面。
 *
 * 这里只管供应商：应用的开/关、版本检测、配置目录都挪到了「设置 - 应用配置」，
 * 所以不再分页签，直接铺开供应商列表。
 */
export default function CcSwitchPage() {
  return (
    <AppShell>
      <div className="flex w-full flex-col gap-4">
        <ProvidersTab />
      </div>
    </AppShell>
  );
}
