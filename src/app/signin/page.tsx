import { redirect } from "next/navigation";

import { signIn, auth } from "@/server/auth/config";
import { signInLocally } from "@/server/auth/localSignIn";
import { authMode, oauthProviders } from "@/server/platform/deployment";

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
  // Returns an error string to render rather than throwing: a bad email is a
  // normal outcome here, not an exception. On success it redirects, so the
  // caller never sees a return value.
  async function localAction(formData: FormData): Promise<string | null> {
    "use server";
    const raw = formData.get("email");
    const result = await signInLocally(typeof raw === "string" ? raw : "");
    if (!result.ok) return result.error;
    redirect(callbackUrl);
  }

  return (
    <SignInPanel
      error={params.error}
      mode={authMode}
      providers={oauthProviders}
      googleAction={googleAction}
      githubAction={githubAction}
      localAction={localAction}
    />
  );
}
