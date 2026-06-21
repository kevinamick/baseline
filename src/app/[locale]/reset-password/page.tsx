import { ResetPasswordForm } from "@/app/_components/auth-form";
import { AuthShell } from "@/app/_components/auth-shell";
import { noindex } from "@/lib/seo";

export const metadata = noindex;

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <ResetPasswordForm />
    </AuthShell>
  );
}
