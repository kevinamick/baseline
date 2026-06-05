import { SignInForm } from "@/app/_components/auth-form";
import { AuthShell } from "@/app/_components/auth-shell";
import { enabledOAuthProviders } from "@/lib/auth/oauth";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <AuthShell>
      <SignInForm next={next} providers={enabledOAuthProviders()} />
    </AuthShell>
  );
}
