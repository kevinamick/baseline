import { ForgotPasswordForm } from "@/app/_components/auth-form";
import { AuthShell } from "@/app/_components/auth-shell";
import { noindex } from "@/lib/seo";

export const metadata = noindex;

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
