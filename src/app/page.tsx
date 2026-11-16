import { AppShell } from "@/app/AppShell";
import { DASHBOARD_PATH } from "@/shared/panelUrl";

export default function Home() {
  return <AppShell path={DASHBOARD_PATH} />;
}
