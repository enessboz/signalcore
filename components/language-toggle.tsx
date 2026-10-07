"use client";

import { useRouter } from "next/navigation";
import type { Locale } from "@/lib/i18n";

export function LanguageToggle({ locale }: { locale: Locale }) {
  const router = useRouter();

  function setLocale(next: Locale) {
    document.cookie =
      "signalcore_locale=" +
      next +
      "; path=/; max-age=31536000; samesite=lax";
    router.refresh();
  }

  return (
    <div className="languageToggle" role="group" aria-label="Language">
      <button
        type="button"
        className={locale === "en" ? "active" : ""}
        onClick={() => setLocale("en")}
      >
        EN
      </button>
      <button
        type="button"
        className={locale === "tr" ? "active" : ""}
        onClick={() => setLocale("tr")}
      >
        TR
      </button>
    </div>
  );
}
