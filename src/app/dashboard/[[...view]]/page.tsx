import { AppShell } from "@/app/AppShell";

// Every addressable panel view below the dashboard. One optional catch-all
// rather than a route per mode: the segments are entity slugs, so the grammar
// lives in parsePanelUrl (src/lib/panelUrl.ts), not in the file tree.
export default async function DashboardPanel({
  params,
}: {
  params: Promise<{ view?: string[] }>;
}) {
  const { view } = await params;
  const segments = view ?? [];
  return <AppShell path={`/dashboard/${segments.join("/")}`} />;
}
