import { login, signup } from "./actions";
import { getLocale } from "@/lib/i18n";
import { LanguageToggle } from "@/components/language-toggle";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";

  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authBrand">
          <span className="brandMark">S</span>
          <div>
            <strong>SignalCore</strong>
            <small>{tr ? "Kanıt → Aksiyon" : "Evidence → Action"}</small>
          </div>
        </div>

        <div className="authIntro">
          <div className="authIntroTop">
            <p className="eyebrow">{tr ? "İç çalışma alanı" : "Internal workspace"}</p>
            <LanguageToggle locale={locale} />
          </div>
          <h1>{tr ? "SignalCore'a giriş yap" : "Sign in to SignalCore"}</h1>
          <p className="muted">
            {tr
              ? "SEO içgörüleri, otomasyonlar ve proje operasyonlarına güvenli erişim."
              : "Secure access to SEO intelligence, automations and project operations."}
          </p>
        </div>

        {params.error ? <p className="formMessage formError">{params.error}</p> : null}
        {params.message ? <p className="formMessage formSuccess">{params.message}</p> : null}

        <form className="formPanel" action={login}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            {tr ? "Şifre" : "Password"}
            <input name="password" type="password" autoComplete="current-password" minLength={8} required />
          </label>
          <div className="buttonRow">
            <button className="primaryButton" type="submit">
              {tr ? "Giriş yap" : "Sign in"}
            </button>
            <button className="secondaryButton" formAction={signup}>
              {tr ? "Hesap oluştur" : "Create account"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
