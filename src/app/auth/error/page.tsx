import { AuthErrorPanel } from "./AuthErrorPanel";

type SearchParams = Promise<{ error?: string }>;

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  return <AuthErrorPanel code={params.error} />;
}
