import { SignUpForm } from "@/app/_components/auth-form";
import { AuthShell } from "@/app/_components/auth-shell";
import { enabledOAuthProviders } from "@/lib/auth/oauth";

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUpForm providers={enabledOAuthProviders()} />
    </AuthShell>
  );
}
