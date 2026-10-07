import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { AppTopbar } from "@/components/app-topbar";
import { createClient } from "@/lib/supabase/server";
import { getLocale, navCopy } from "@/lib/i18n";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims?.sub) {
    redirect("/login");
  }

  const locale = await getLocale();
  const copy = navCopy(locale);

  return (
    <div className="appShell">
      <Sidebar />
      <div className="appContent">
        <AppTopbar locale={locale} copy={copy} />
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
