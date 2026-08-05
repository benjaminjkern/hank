import { redirect } from "next/navigation";

import { signIn, auth } from "@/server/auth/config";

import { SignInPanel } from "./SignInPanel";

type SearchParams = Promise<{ callbackUrl?: string; error?: string }>;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  const params = await searchParams;
  if (session?.user?.id) {
    redirect(params.callbackUrl || "/");
  }

  const callbackUrl = params.callbackUrl || "/";

  async function googleAction() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }
  async function githubAction() {
    "use server";
    await signIn("github", { redirectTo: callbackUrl });
  }

  return (
    <SignInPanel
      error={params.error}
      googleAction={googleAction}
      githubAction={githubAction}
    />
  );
}
