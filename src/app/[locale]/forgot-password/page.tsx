import { ForgotPasswordForm } from "@/app/_components/auth-form";
import { AuthShell } from "@/app/_components/auth-shell";

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
