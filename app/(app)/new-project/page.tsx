import { createProject } from "./actions";
import { getLocale } from "@/lib/i18n";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";

  const types = [
    [
      "owned",
      tr ? "Kendi Projem" : "Owned Project",
      tr
        ? "Erişim olan tüm iç bağlam, veri ve otomasyonlar kullanılabilir."
        : "Full internal context can be stored when access exists.",
    ],
    [
      "client",
      tr ? "Müşteri Projesi" : "Client Project",
      tr
        ? "Yalnızca sağlanan, bağlanan veya açıkça bilinen müşteri bağlamı kullanılır."
        : "Bounded memory: only supplied, connected or explicitly known client context.",
    ],
    [
      "lead_prospect",
      tr ? "Potansiyel Müşteri" : "Lead Prospect",
      tr
        ? "Yalnızca public ve lisanslı üçüncü taraf kanıtları kullanılır; özel analytics iddiası yapılmaz."
        : "Public and licensed third-party evidence only; no private analytics claims.",
    ],
  ] as const;

  return (
    <div className="page narrowPage">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "Çalışma alanı oluştur" : "Create workspace"}</p>
          <h1>{tr ? "Yeni proje" : "New project"}</h1>
          <p className="muted">
            {tr
              ? "Önce proje sınırını belirle. Veri bağlantıları ve otomasyonlar proje oluşturulduktan sonra eklenir."
              : "Define the project boundary first. Data connections and automations come after creation."}
          </p>
        </div>
      </header>

      <form className="panel formPanel" action={createProject}>
        {params.error ? <p className="formMessage formError">{params.error}</p> : null}
        <label>
          {tr ? "Proje adı" : "Project name"}
          <input name="name" placeholder="e.g. EatBetter" required />
        </label>
        <label>
          Domain
          <input name="domain" placeholder="example.com" />
        </label>

        <fieldset>
          <legend>{tr ? "Proje türü" : "Project type"}</legend>
          <div className="typeGrid">
            {types.map(([value, name, desc]) => (
              <label className="typeCard" key={value}>
                <input type="radio" name="projectType" value={value} required />
                <strong>{name}</strong>
                <span>{desc}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label>
          {tr ? "Başlangıç bağlamı" : "Initial background"}
          <textarea
            name="description"
            rows={5}
            placeholder={
              tr
                ? "Opsiyonel kısa bağlam. Detaylı LLM Background dosyaları proje oluşturulduktan sonra eklenebilir."
                : "Optional short context. Full LLM Background files can be added after the project is created."
            }
          />
        </label>

        <button className="primaryButton" type="submit">
          {tr ? "Projeyi oluştur" : "Create project"}
        </button>
      </form>
    </div>
  );
}
