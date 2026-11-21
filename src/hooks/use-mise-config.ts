// The config tab's data: the workspace for the selected project (or the global
// configuration), the project list for its selector, and the preview/save pair
// every write goes through. Nothing watches the files; the tab reloads when it
// mounts, when the refresh button is pressed and after a successful save.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  miseConfigPreviewEdit,
  miseConfigSave,
  miseConfigWorkspace,
  miseErrorCode,
  miseProjectsScan,
  type MiseConfigDocument,
  type MiseConfigEdit,
  type MiseConfigSavePreview,
  type MiseConfigSaveResult,
  type MiseConfigWorkspace,
  type MiseErrorCode,
  type MiseProject,
} from "@/commands";

export type MiseConfigState = {
  workspace: MiseConfigWorkspace | null;
  projects: MiseProject[];
  selectedProject: MiseProject | null;
  globalDocument: MiseConfigDocument | null;
  projectDocument: MiseConfigDocument | null;
  loading: boolean;
  error: MiseErrorCode | null;
  /** True while a preview or save is in flight. */
  busy: boolean;
  selectProject: (project: MiseProject | null) => void;
  reload: () => Promise<void>;
  preview: (path: string, edit: MiseConfigEdit) => Promise<MiseConfigSavePreview>;
  save: (path: string, nextContent: string) => Promise<MiseConfigSaveResult>;
};

/** `http_timeout` → `httpTimeout`, the suffix of a `mise.config.*` label key. */
export function camelCaseKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

function loadWorkspace(project: MiseProject | null): Promise<MiseConfigWorkspace> {
  if (project === null) return miseConfigWorkspace();
  return miseConfigWorkspace({
    projectPath: project.path,
    projectConfigPath: project.configPath,
    projectName: project.name,
  });
}

export function useMiseConfig(): MiseConfigState {
  const [workspace, setWorkspace] = useState<MiseConfigWorkspace | null>(null);
  const [projects, setProjects] = useState<MiseProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<MiseProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MiseErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  const sequence = useRef(0);

  const load = useCallback(async (project: MiseProject | null, scanProjects: boolean) => {
    // A newer load makes every pending response stale, so a quick switch between
    // projects cannot let the previous project's workspace win the race.
    const sequenceId = sequence.current + 1;
    sequence.current = sequenceId;
    setLoading(true);

    try {
      const [nextWorkspace, coverage] = await Promise.all([
        loadWorkspace(project),
        scanProjects ? miseProjectsScan() : Promise.resolve(null),
      ]);
      if (cancelled.current || sequence.current !== sequenceId) return;

      setWorkspace(nextWorkspace);
      if (coverage !== null) {
        setProjects(coverage.projects);
        // Keep the selected record in step with the rescan, or drop it when the
        // project disappeared.
        setSelectedProject((current) =>
          current === null
            ? null
            : (coverage.projects.find((item) => item.path === current.path) ?? null)
        );
      }
      setError(null);
    } catch (failure) {
      if (!cancelled.current && sequence.current === sequenceId) {
        setError(miseErrorCode(failure) ?? "internal");
      }
    } finally {
      if (!cancelled.current && sequence.current === sequenceId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void load(null, true);
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  const selectProject = useCallback(
    (project: MiseProject | null) => {
      setSelectedProject(project);
      void load(project, false);
    },
    [load]
  );

  const reload = useCallback(() => load(selectedProject, true), [load, selectedProject]);

  const preview = useCallback(async (path: string, edit: MiseConfigEdit) => {
    setBusy(true);
    try {
      return await miseConfigPreviewEdit(path, edit);
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(
    async (path: string, nextContent: string) => {
      setBusy(true);
      try {
        const result = await miseConfigSave(path, nextContent);
        // Read the file back so every panel reflects what is now on disk.
        await load(selectedProject, false);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [load, selectedProject]
  );

  return {
    workspace,
    projects,
    selectedProject,
    globalDocument: workspace?.documents.find((document) => document.kind === "global") ?? null,
    projectDocument: workspace?.documents.find((document) => document.kind === "project") ?? null,
    loading,
    error,
    busy,
    selectProject,
    reload,
    preview,
    save,
  };
}
