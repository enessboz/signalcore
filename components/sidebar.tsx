import { SidebarClient } from "@/components/sidebar-client";
import { getLocale, navCopy } from "@/lib/i18n";

export async function Sidebar() {
  const locale = await getLocale();
  return <SidebarClient locale={locale} copy={navCopy(locale)} />;
}
