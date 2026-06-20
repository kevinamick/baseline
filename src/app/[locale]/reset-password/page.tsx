import { ResetPasswordForm } from "@/app/_components/auth-form";
import { AuthShell } from "@/app/_components/auth-shell";

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <ResetPasswordForm />
    </AuthShell>
  );
}
