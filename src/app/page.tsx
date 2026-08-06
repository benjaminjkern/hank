import { AppShell } from "@/app/AppShell";
import { DASHBOARD_PATH } from "@/lib/panelUrl";

export default function Home() {
  return <AppShell path={DASHBOARD_PATH} />;
}
