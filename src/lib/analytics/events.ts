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
  | { name: "auth.user_signed_up"; props: { user_id: string; email_domain?: string } }
  | {
      name: "billing.checkout_started";
      props: { user_id: string; price_id: string };
    }
  | {
      name: "billing.subscription_started";
      props: {
        user_id: string;
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
    };

export type EventName = AnalyticsEvent["name"];
