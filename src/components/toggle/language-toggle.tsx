import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";

export function LanguageToggle() {
  const { i18n, t } = useTranslation();

  const toggleLanguage = async () => {
    const newLang = i18n.language === "zh" ? "en" : "zh";
    await i18n.changeLanguage(newLang);

    // Emit event to sync language across windows
    await emit("language-changed", { language: newLang });
  };

  return (
    <button
      onClick={toggleLanguage}
      className="title-bar-btn mr-1"
      aria-label={t("language.toggle")}
      title={i18n.language === "zh" ? "Switch to English" : "Switch to 中文"}
      tabIndex={-1}
    >
      <Languages className="h-4 w-4" />
    </button>
  );
}
