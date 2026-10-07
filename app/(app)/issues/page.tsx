export default function Page() {
import { getLocale } from "@/lib/i18n";
  return (
    <div className="page">
      <header className="pageHeader"><div><p className="eyebrow">SignalCore</p><h1>{tr ? "Sorunlar & Regresyonlar" : "Issues & Regressions"}</h1><p className="muted">{tr ? "Teknik ve performans sorunları ham alert gürültüsü üretmek yerine gruplanır." : "Technical and performance issues are grouped instead of producing raw alert noise."}</p></div></header>
      <section className="panel emptyState"><strong>{tr ? "Altyapı hazır" : "Foundation ready"}</strong><span>{tr ? "Issue detection GSC ve crawl engine verileriyle beslenir." : "Issue detection is powered by GSC and crawl engines."}</span></section>
    </div>
  );
}
