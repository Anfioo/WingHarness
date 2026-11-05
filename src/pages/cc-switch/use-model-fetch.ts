import { useState } from "react";
import { toast } from "sonner";
import { ccsFetchModels } from "@/commands";
import type { AppId, FetchedModel, Provider } from "@/commands/services/ccs/types";

/// 获取模型列表：用当前表单的 settingsConfig 构造一个临时 provider 交给后端探测。
export function useModelFetch(
  app: AppId,
  buildProvider: () => Provider
): { models: FetchedModel[]; loading: boolean; fetch: () => Promise<void> } {
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = async () => {
    setLoading(true);
    try {
      const list = await ccsFetchModels(app, buildProvider());
      setModels(list);
      if (list.length === 0) toast.info("未获取到模型");
      else toast.success(`已获取 ${list.length} 个模型`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  };

  return { models, loading, fetch };
}
