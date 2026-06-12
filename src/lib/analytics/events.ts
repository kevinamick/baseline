import type { OAuthProvider } from "@/lib/auth/oauth";

export type DeviceProps = {
  browser?: string | null;
  browser_version?: string | null;
  os?: string | null;
  device_type?: string | null;
  viewport_width?: number;
  viewport_height?: number;
};

export type AnalyticsEvent =
  | { name: "app.page_viewed"; props: { path: string } & DeviceProps }
  | { name: "session.started"; props: { session_id: string } & DeviceProps }
  | { name: "auth.signup_started"; props?: Record<string, never> }
  | { name: "auth.sign_in_clicked"; props?: Record<string, never> }
  | { name: "auth.oauth_clicked"; props: { provider: OAuthProvider } }
  | { name: "auth.password_reset_requested"; props?: Record<string, never> }
  | { name: "auth.user_signed_up"; props: { user_id: string; email_domain?: string } }
  | {
      name: "billing.checkout_started";
      props: { team_id: string; price_id: string };
    }
  | {
      name: "billing.subscription_started";
      props: {
        team_id: string;
        stripe_subscription_id: string;
        stripe_customer_id: string;
      };
    }
  | { name: "billing.checkout_success"; props?: Record<string, never> }
  | { name: "billing.checkout_cancelled"; props?: Record<string, never> }
  | {
      name: "system.web_vital";
      props: {
        metric: string;
        value: number;
        rating: string;
        navigation_type: string;
      };
    }
  | { name: "team.created"; props: { team_id: string } }
  | { name: "team.deleted"; props: { team_id: string } }
  | { name: "invitation.sent"; props: { team_id: string } }
  | { name: "invitation.accepted"; props: { team_id: string } }
  | { name: "invitation.revoked"; props: { team_id: string } }
  | {
      name: "membership.role_changed";
      props: { team_id: string; role: "admin" | "member" };
    }
  | { name: "membership.removed"; props: { team_id: string } }
  | { name: "rubric.create_dialog_opened"; props?: Record<string, never> }
  | { name: "rubric.edit_dialog_opened"; props?: Record<string, never> }
  | {
      name: "rubric.created";
      props: { evaluation_mode: string; criteria_count: number };
    }
  | {
      name: "rubric.updated";
      props: {
        rubric_id: string;
        evaluation_mode: string;
        criteria_count: number;
      };
    }
  | { name: "rubric.deleted"; props: { rubric_id: string } }
  | { name: "eval_run.dialog_opened"; props?: Record<string, never> }
  | {
      name: "eval_run.created";
      props: { rubric_id: string; row_count: number; input_source: string };
    }
  | {
      name: "eval_run.completed";
      props: { run_id: string; overall_score: number; row_count: number };
    }
  | {
      name: "schedule.created";
      props: { frequency: string; kind: string; input_count: number };
    }
  | { name: "schedule.deleted"; props: { schedule_id: string } }
  | {
      name: "optimization_run.started";
      props: { instance_count: number; budget: number };
    }
  | { name: "optimization_run.cancelled"; props: Record<string, never> };

export type EventName = AnalyticsEvent["name"];
