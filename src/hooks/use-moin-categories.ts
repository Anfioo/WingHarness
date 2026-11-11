import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isMoinError,
  moinCreateCategory,
  moinDeleteCategory,
  moinErrorKey,
  moinListCategories,
  moinReorderCategories,
  moinUpdateCategory,
  type MoinCategory,
} from "@/commands";

/**
 * Category list, kept in `order` so the list renders in the same order the
 * engine matches them. Every mutation returns the whole list, which is what the
 * page renders — no local re-sorting, no drift. `error` is an i18n key.
 */
export function useMoinCategories(): {
  categories: MoinCategory[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (category: MoinCategory) => Promise<void>;
  update: (category: MoinCategory) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
} {
  const [categories, setCategories] = useState<MoinCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fail = useCallback((failure: unknown) => {
    if (!mounted.current) return;
    setError(isMoinError(failure) ? moinErrorKey(failure.code) : moinErrorKey(undefined));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await moinListCategories();
      if (!mounted.current) return;
      setCategories(list);
      setError(null);
    } catch (failure) {
      fail(failure);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [fail]);

  const create = useCallback(
    async (category: MoinCategory) => {
      try {
        setCategories(await moinCreateCategory(category));
        setError(null);
      } catch (failure) {
        fail(failure);
      }
    },
    [fail]
  );

  const update = useCallback(
    async (category: MoinCategory) => {
      try {
        setCategories(await moinUpdateCategory(category));
        setError(null);
      } catch (failure) {
        fail(failure);
      }
    },
    [fail]
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        setCategories(await moinDeleteCategory(id));
        setError(null);
      } catch (failure) {
        fail(failure);
      }
    },
    [fail]
  );

  const reorder = useCallback(
    async (ids: string[]) => {
      try {
        setCategories(await moinReorderCategories(ids));
        setError(null);
      } catch (failure) {
        fail(failure);
      }
    },
    [fail]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const ordered = useMemo(
    () => [...categories].sort((left, right) => left.order - right.order),
    [categories]
  );

  return { categories: ordered, loading, error, reload, create, update, remove, reorder };
}
