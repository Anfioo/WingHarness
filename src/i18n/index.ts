import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import gitRepoEn from "./locales/git-repo/en";
import gitRepoZh from "./locales/git-repo/zh";
import apiClientEn from "./locales/api-client/en";
import apiClientZh from "./locales/api-client/zh";
import svnWorkspaceEn from "./locales/svn-workspace/en";
import svnWorkspaceZh from "./locales/svn-workspace/zh";
import clashEn from "./locales/clash/en";
import clashZh from "./locales/clash/zh";
import systoolsEn from "./locales/systools/en";
import systoolsZh from "./locales/systools/zh";
import mdEditorEn from "./locales/md-editor/en";
import mdEditorZh from "./locales/md-editor/zh";
import spacePreviewEn from "./locales/space-preview/en";
import spacePreviewZh from "./locales/space-preview/zh";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: {
          ...en,
          gitRepo: { ...en.gitRepo, ...gitRepoEn },
          apiClient: apiClientEn,
          svnWorkspace: svnWorkspaceEn,
          clash: clashEn,
          systools: systoolsEn,
          mdEditor: mdEditorEn,
          spacePreview: spacePreviewEn,
        },
      },
      zh: {
        translation: {
          ...zh,
          gitRepo: { ...zh.gitRepo, ...gitRepoZh },
          apiClient: apiClientZh,
          svnWorkspace: svnWorkspaceZh,
          clash: clashZh,
          systools: systoolsZh,
          mdEditor: mdEditorZh,
          spacePreview: spacePreviewZh,
        },
      },
    },
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
