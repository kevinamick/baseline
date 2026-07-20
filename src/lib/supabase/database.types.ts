export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      billing_events: {
        Row: {
          processed_at: string
          stripe_event_id: string
          type: string
        }
        Insert: {
          processed_at?: string
          stripe_event_id: string
          type: string
        }
        Update: {
          processed_at?: string
          stripe_event_id?: string
          type?: string
        }
        Relationships: []
      }
      billing_notifications: {
        Row: {
          kind: string
          org_id: string
          period_start: string
          sent_at: string
        }
        Insert: {
          kind: string
          org_id: string
          period_start: string
          sent_at?: string
        }
        Update: {
          kind?: string
          org_id?: string
          period_start?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_notifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_settings: {
        Row: {
          managed_spend_cap_usd: number | null
          org_id: string
          overage_cap_usd: number | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          managed_spend_cap_usd?: number | null
          org_id: string
          overage_cap_usd?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          managed_spend_cap_usd?: number | null
          org_id?: string
          overage_cap_usd?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      connections: {
        Row: {
          agent_kind: string
          auth_header: string | null
          auth_secret_id: string | null
          config: Json | null
          created_at: string
          created_by: string
          endpoint: string
          id: string
          kind: string
          name: string
          optimizable_prompts: Json | null
          org_id: string
          provider: string
          request_template: Json | null
          response_path: string
          target_model: string | null
          updated_at: string
        }
        Insert: {
          agent_kind?: string
          auth_header?: string | null
          auth_secret_id?: string | null
          config?: Json | null
          created_at?: string
          created_by: string
          endpoint: string
          id?: string
          kind?: string
          name: string
          optimizable_prompts?: Json | null
          org_id: string
          provider?: string
          request_template?: Json | null
          response_path: string
          target_model?: string | null
          updated_at?: string
        }
        Update: {
          agent_kind?: string
          auth_header?: string | null
          auth_secret_id?: string | null
          config?: Json | null
          created_at?: string
          created_by?: string
          endpoint?: string
          id?: string
          kind?: string
          name?: string
          optimizable_prompts?: Json | null
          org_id?: string
          provider?: string
          request_template?: Json | null
          response_path?: string
          target_model?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connections_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          cancel_at_period_end: boolean
          current_period_end: string | null
          current_period_start: string | null
          email: string | null
          managed_failed_invoice_id: string | null
          managed_payment_failed_at: string | null
          mirror_event_at: string | null
          org_id: string
          pending_change_at: string | null
          pending_price_id: string | null
          schedule_event_at: string | null
          status: string | null
          stripe_customer_id: string
          stripe_price_id: string | null
          stripe_schedule_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          current_period_end?: string | null
          current_period_start?: string | null
          email?: string | null
          managed_failed_invoice_id?: string | null
          managed_payment_failed_at?: string | null
          mirror_event_at?: string | null
          org_id: string
          pending_change_at?: string | null
          pending_price_id?: string | null
          schedule_event_at?: string | null
          status?: string | null
          stripe_customer_id: string
          stripe_price_id?: string | null
          stripe_schedule_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          current_period_end?: string | null
          current_period_start?: string | null
          email?: string | null
          managed_failed_invoice_id?: string | null
          managed_payment_failed_at?: string | null
          mirror_event_at?: string | null
          org_id?: string
          pending_change_at?: string | null
          pending_price_id?: string | null
          schedule_event_at?: string | null
          status?: string | null
          stripe_customer_id?: string
          stripe_price_id?: string | null
          stripe_schedule_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_run_results: {
        Row: {
          criterion_name: string
          eval_run_id: string
          id: string
          reasoning: string
          row_index: number
          score: number
        }
        Insert: {
          criterion_name: string
          eval_run_id: string
          id?: string
          reasoning: string
          row_index: number
          score: number
        }
        Update: {
          criterion_name?: string
          eval_run_id?: string
          id?: string
          reasoning?: string
          row_index?: number
          score?: number
        }
        Relationships: [
          {
            foreignKeyName: "eval_run_results_eval_run_id_fkey"
            columns: ["eval_run_id"]
            isOneToOne: false
            referencedRelation: "eval_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_run_rows: {
        Row: {
          agent_output: string
          eval_run_id: string
          expected_output: string | null
          id: string
          retrieval_context: string | null
          row_index: number
          user_input: string
        }
        Insert: {
          agent_output: string
          eval_run_id: string
          expected_output?: string | null
          id?: string
          retrieval_context?: string | null
          row_index: number
          user_input: string
        }
        Update: {
          agent_output?: string
          eval_run_id?: string
          expected_output?: string | null
          id?: string
          retrieval_context?: string | null
          row_index?: number
          user_input?: string
        }
        Relationships: [
          {
            foreignKeyName: "eval_run_rows_eval_run_id_fkey"
            columns: ["eval_run_id"]
            isOneToOne: false
            referencedRelation: "eval_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_runs: {
        Row: {
          created_at: string
          created_by: string
          deleted_at: string | null
          description: string | null
          error_message: string | null
          eval_type: string
          id: string
          notification_emails: string[] | null
          overall_score: number | null
          rubric_id: string
          schedule_id: string | null
          status: Database["public"]["Enums"]["eval_run_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          deleted_at?: string | null
          description?: string | null
          error_message?: string | null
          eval_type?: string
          id?: string
          notification_emails?: string[] | null
          overall_score?: number | null
          rubric_id: string
          schedule_id?: string | null
          status?: Database["public"]["Enums"]["eval_run_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          description?: string | null
          error_message?: string | null
          eval_type?: string
          id?: string
          notification_emails?: string[] | null
          overall_score?: number | null
          rubric_id?: string
          schedule_id?: string | null
          status?: Database["public"]["Enums"]["eval_run_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "eval_runs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_runs_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_runs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          org_id: string
          role: string
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          org_id: string
          role?: string
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          org_id?: string
          role?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      managed_invoice_lines: {
        Row: {
          accrued_usd: number
          dirty: boolean
          invoiced_usd: number
          model: string
          org_id: string
          period_end: string
          period_start: string
          provider: string
          stripe_invoice_id: string | null
          stripe_invoice_item_id: string | null
          unit_markup_pct: number | null
          updated_at: string
        }
        Insert: {
          accrued_usd?: number
          dirty?: boolean
          invoiced_usd?: number
          model: string
          org_id: string
          period_end: string
          period_start: string
          provider: string
          stripe_invoice_id?: string | null
          stripe_invoice_item_id?: string | null
          unit_markup_pct?: number | null
          updated_at?: string
        }
        Update: {
          accrued_usd?: number
          dirty?: boolean
          invoiced_usd?: number
          model?: string
          org_id?: string
          period_end?: string
          period_start?: string
          provider?: string
          stripe_invoice_id?: string | null
          stripe_invoice_item_id?: string | null
          unit_markup_pct?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "managed_invoice_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      managed_spend_ledger: {
        Row: {
          amount_usd: number
          call_kind: string | null
          cap_usd: number | null
          created_at: string
          entry_type: string
          eval_run_id: string | null
          id: string
          input_tokens: number | null
          input_unit_usd: number | null
          markup_pct: number | null
          model: string | null
          opt_run_id: string | null
          org_id: string
          output_tokens: number | null
          output_unit_usd: number | null
          period_end: string
          period_start: string
          provider: string | null
        }
        Insert: {
          amount_usd: number
          call_kind?: string | null
          cap_usd?: number | null
          created_at?: string
          entry_type: string
          eval_run_id?: string | null
          id?: string
          input_tokens?: number | null
          input_unit_usd?: number | null
          markup_pct?: number | null
          model?: string | null
          opt_run_id?: string | null
          org_id: string
          output_tokens?: number | null
          output_unit_usd?: number | null
          period_end: string
          period_start: string
          provider?: string | null
        }
        Update: {
          amount_usd?: number
          call_kind?: string | null
          cap_usd?: number | null
          created_at?: string
          entry_type?: string
          eval_run_id?: string | null
          id?: string
          input_tokens?: number | null
          input_unit_usd?: number | null
          markup_pct?: number | null
          model?: string | null
          opt_run_id?: string | null
          org_id?: string
          output_tokens?: number | null
          output_unit_usd?: number | null
          period_end?: string
          period_start?: string
          provider?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "managed_spend_ledger_eval_run_id_fkey"
            columns: ["eval_run_id"]
            isOneToOne: false
            referencedRelation: "eval_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "managed_spend_ledger_opt_run_id_fkey"
            columns: ["opt_run_id"]
            isOneToOne: false
            referencedRelation: "optimization_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "managed_spend_ledger_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          org_id: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      optimization_candidates: {
        Row: {
          created_at: string
          generation: number
          id: string
          iteration: number | null
          opt_run_id: string
          parent_id: string | null
          prompts: Json
          target_module: string | null
        }
        Insert: {
          created_at?: string
          generation?: number
          id?: string
          iteration?: number | null
          opt_run_id: string
          parent_id?: string | null
          prompts: Json
          target_module?: string | null
        }
        Update: {
          created_at?: string
          generation?: number
          id?: string
          iteration?: number | null
          opt_run_id?: string
          parent_id?: string | null
          prompts?: Json
          target_module?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "optimization_candidates_opt_run_id_fkey"
            columns: ["opt_run_id"]
            isOneToOne: false
            referencedRelation: "optimization_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "optimization_candidates_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "optimization_candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      optimization_inputs: {
        Row: {
          expected_output: string | null
          id: string
          instance_index: number
          opt_run_id: string
          retrieval_context: string | null
          user_input: string
        }
        Insert: {
          expected_output?: string | null
          id?: string
          instance_index: number
          opt_run_id: string
          retrieval_context?: string | null
          user_input: string
        }
        Update: {
          expected_output?: string | null
          id?: string
          instance_index?: number
          opt_run_id?: string
          retrieval_context?: string | null
          user_input?: string
        }
        Relationships: [
          {
            foreignKeyName: "optimization_inputs_opt_run_id_fkey"
            columns: ["opt_run_id"]
            isOneToOne: false
            referencedRelation: "optimization_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      optimization_rollouts: {
        Row: {
          agent_output: string | null
          candidate_id: string
          created_at: string
          id: string
          instance_index: number
          phase: string
          trace: Json | null
        }
        Insert: {
          agent_output?: string | null
          candidate_id: string
          created_at?: string
          id?: string
          instance_index: number
          phase: string
          trace?: Json | null
        }
        Update: {
          agent_output?: string | null
          candidate_id?: string
          created_at?: string
          id?: string
          instance_index?: number
          phase?: string
          trace?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "optimization_rollouts_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "optimization_candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      optimization_run_ledger: {
        Row: {
          created_at: string
          entry_type: string
          id: string
          meta: Json
          opt_run_id: string | null
          org_id: string
          period_end: string
          period_start: string
          units: number
        }
        Insert: {
          created_at?: string
          entry_type: string
          id?: string
          meta?: Json
          opt_run_id?: string | null
          org_id: string
          period_end: string
          period_start: string
          units: number
        }
        Update: {
          created_at?: string
          entry_type?: string
          id?: string
          meta?: Json
          opt_run_id?: string | null
          org_id?: string
          period_end?: string
          period_start?: string
          units?: number
        }
        Relationships: [
          {
            foreignKeyName: "optimization_run_ledger_opt_run_id_fkey"
            columns: ["opt_run_id"]
            isOneToOne: false
            referencedRelation: "optimization_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "optimization_run_ledger_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      optimization_runs: {
        Row: {
          best_candidate_id: string | null
          best_score: number | null
          budget_rollouts: number
          connection_id: string
          created_at: string
          created_by: string
          deleted_at: string | null
          error_message: string | null
          eval_type: string
          id: string
          max_iters: number
          mode: string
          org_id: string
          pause_max_wait_minutes: number
          paused_reason: string | null
          plateau_patience: number | null
          probe_interval_seconds: number
          reflect_model: string
          reflect_provider: string | null
          rubric_id: string
          status: Database["public"]["Enums"]["optimization_run_status"]
          updated_at: string
          workflow_id: string | null
        }
        Insert: {
          best_candidate_id?: string | null
          best_score?: number | null
          budget_rollouts: number
          connection_id: string
          created_at?: string
          created_by: string
          deleted_at?: string | null
          error_message?: string | null
          eval_type?: string
          id?: string
          max_iters: number
          mode?: string
          org_id: string
          pause_max_wait_minutes?: number
          paused_reason?: string | null
          plateau_patience?: number | null
          probe_interval_seconds?: number
          reflect_model?: string
          reflect_provider?: string | null
          rubric_id: string
          status?: Database["public"]["Enums"]["optimization_run_status"]
          updated_at?: string
          workflow_id?: string | null
        }
        Update: {
          best_candidate_id?: string | null
          best_score?: number | null
          budget_rollouts?: number
          connection_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          error_message?: string | null
          eval_type?: string
          id?: string
          max_iters?: number
          mode?: string
          org_id?: string
          pause_max_wait_minutes?: number
          paused_reason?: string | null
          plateau_patience?: number | null
          probe_interval_seconds?: number
          reflect_model?: string
          reflect_provider?: string | null
          rubric_id?: string
          status?: Database["public"]["Enums"]["optimization_run_status"]
          updated_at?: string
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "optimization_runs_best_candidate_fkey"
            columns: ["best_candidate_id"]
            isOneToOne: false
            referencedRelation: "optimization_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "optimization_runs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "optimization_runs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "optimization_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "optimization_runs_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      overage_invoice_lines: {
        Row: {
          dirty: boolean
          invoiced_quantity: number
          meter: string
          org_id: string
          period_start: string
          quantity: number
          stripe_invoice_item_id: string | null
          unit_usd: number | null
          updated_at: string
        }
        Insert: {
          dirty?: boolean
          invoiced_quantity?: number
          meter: string
          org_id: string
          period_start: string
          quantity: number
          stripe_invoice_item_id?: string | null
          unit_usd?: number | null
          updated_at?: string
        }
        Update: {
          dirty?: boolean
          invoiced_quantity?: number
          meter?: string
          org_id?: string
          period_start?: string
          quantity?: number
          stripe_invoice_item_id?: string | null
          unit_usd?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "overage_invoice_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      paid_invoices: {
        Row: {
          amount_usd: number
          created_at: string
          org_id: string
          paid_at: string
          reversal_reason: string | null
          reversed_at: string | null
          stripe_invoice_id: string
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount_usd?: number
          created_at?: string
          org_id: string
          paid_at: string
          reversal_reason?: string | null
          reversed_at?: string | null
          stripe_invoice_id: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_usd?: number
          created_at?: string
          org_id?: string
          paid_at?: string
          reversal_reason?: string | null
          reversed_at?: string | null
          stripe_invoice_id?: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "paid_invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      point_ledger: {
        Row: {
          created_at: string
          entry_type: string
          eval_run_id: string | null
          id: string
          meta: Json
          opt_run_id: string | null
          org_id: string
          period_end: string
          period_start: string
          points: number
        }
        Insert: {
          created_at?: string
          entry_type: string
          eval_run_id?: string | null
          id?: string
          meta?: Json
          opt_run_id?: string | null
          org_id: string
          period_end: string
          period_start: string
          points: number
        }
        Update: {
          created_at?: string
          entry_type?: string
          eval_run_id?: string | null
          id?: string
          meta?: Json
          opt_run_id?: string | null
          org_id?: string
          period_end?: string
          period_start?: string
          points?: number
        }
        Relationships: [
          {
            foreignKeyName: "point_ledger_eval_run_id_fkey"
            columns: ["eval_run_id"]
            isOneToOne: false
            referencedRelation: "eval_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "point_ledger_opt_run_id_fkey"
            columns: ["opt_run_id"]
            isOneToOne: false
            referencedRelation: "optimization_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "point_ledger_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_keys: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          last4: string | null
          org_id: string
          provider: string
          secret_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          last4?: string | null
          org_id: string
          provider: string
          secret_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          last4?: string | null
          org_id?: string
          provider?: string
          secret_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_keys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_hits: {
        Row: {
          count: number
          hashed_key: string
          keytype: string
          surface: string
          window_start: string
        }
        Insert: {
          count?: number
          hashed_key: string
          keytype: string
          surface: string
          window_start: string
        }
        Update: {
          count?: number
          hashed_key?: string
          keytype?: string
          surface?: string
          window_start?: string
        }
        Relationships: []
      }
      rollout_results: {
        Row: {
          criterion_name: string
          id: string
          reasoning: string
          rollout_id: string
          score: number
        }
        Insert: {
          criterion_name: string
          id?: string
          reasoning: string
          rollout_id: string
          score: number
        }
        Update: {
          criterion_name?: string
          id?: string
          reasoning?: string
          rollout_id?: string
          score?: number
        }
        Relationships: [
          {
            foreignKeyName: "rollout_results_rollout_id_fkey"
            columns: ["rollout_id"]
            isOneToOne: false
            referencedRelation: "optimization_rollouts"
            referencedColumns: ["id"]
          },
        ]
      }
      rubrics: {
        Row: {
          created_at: string
          created_by: string
          criteria: Json
          evaluation_mode: Database["public"]["Enums"]["evaluation_mode"]
          expected_outcome: string
          grounding_context: string | null
          id: string
          name: string
          org_id: string
          scenario_description: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          criteria?: Json
          evaluation_mode: Database["public"]["Enums"]["evaluation_mode"]
          expected_outcome: string
          grounding_context?: string | null
          id?: string
          name: string
          org_id: string
          scenario_description: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          criteria?: Json
          evaluation_mode?: Database["public"]["Enums"]["evaluation_mode"]
          expected_outcome?: string
          grounding_context?: string | null
          id?: string
          name?: string
          org_id?: string
          scenario_description?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rubrics_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubrics_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_inputs: {
        Row: {
          expected_output: string | null
          id: string
          retrieval_context: string | null
          row_index: number
          schedule_id: string
          user_input: string
        }
        Insert: {
          expected_output?: string | null
          id?: string
          retrieval_context?: string | null
          row_index: number
          schedule_id: string
          user_input: string
        }
        Update: {
          expected_output?: string | null
          id?: string
          retrieval_context?: string | null
          row_index?: number
          schedule_id?: string
          user_input?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_inputs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      schedules: {
        Row: {
          connection_id: string
          created_at: string
          created_by: string
          day_of_month: number | null
          days_of_week: number[] | null
          description: string | null
          enabled: boolean
          eval_type: string
          frequency: string
          id: string
          last_run_at: string | null
          local_hour: number | null
          max_rows: number | null
          name: string
          next_run_at: string | null
          notification_emails: string[] | null
          org_id: string
          rubric_id: string
          timezone: string
          updated_at: string
          window_minutes: number | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          created_by: string
          day_of_month?: number | null
          days_of_week?: number[] | null
          description?: string | null
          enabled?: boolean
          eval_type?: string
          frequency: string
          id?: string
          last_run_at?: string | null
          local_hour?: number | null
          max_rows?: number | null
          name: string
          next_run_at?: string | null
          notification_emails?: string[] | null
          org_id: string
          rubric_id: string
          timezone?: string
          updated_at?: string
          window_minutes?: number | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          created_by?: string
          day_of_month?: number | null
          days_of_week?: number[] | null
          description?: string | null
          enabled?: boolean
          eval_type?: string
          frequency?: string
          id?: string
          last_run_at?: string | null
          local_hour?: number | null
          max_rows?: number | null
          name?: string
          next_run_at?: string | null
          notification_emails?: string[] | null
          org_id?: string
          rubric_id?: string
          timezone?: string
          updated_at?: string
          window_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "schedules_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          id: string
        }
        Insert: {
          created_at?: string
          id: string
        }
        Update: {
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      worker_config: {
        Row: {
          id: number
          managed_threshold_secret: string | null
          managed_threshold_url: string | null
          retention_secret: string | null
          retention_url: string | null
          wake_secret: string | null
          wake_url: string | null
        }
        Insert: {
          id?: number
          managed_threshold_secret?: string | null
          managed_threshold_url?: string | null
          retention_secret?: string | null
          retention_url?: string | null
          wake_secret?: string | null
          wake_url?: string | null
        }
        Update: {
          id?: number
          managed_threshold_secret?: string | null
          managed_threshold_url?: string | null
          retention_secret?: string | null
          retention_url?: string | null
          wake_secret?: string | null
          wake_url?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accrue_managed_spend: {
        Args: {
          p_amount_usd: number
          p_call_kind: string
          p_eval_run_id?: string
          p_input_tokens: number
          p_input_unit_usd: number
          p_markup_pct: number
          p_model: string
          p_opt_run_id?: string
          p_org_id: string
          p_output_tokens: number
          p_output_unit_usd: number
          p_provider: string
        }
        Returns: number
      }
      ack_eval_run_message: { Args: { p_msg_id: number }; Returns: undefined }
      compute_next_run_at: {
        Args: {
          p_after?: string
          p_day_of_month: number
          p_days_of_week: number[]
          p_frequency: string
          p_local_hour: number
          p_timezone: string
        }
        Returns: string
      }
      create_connection_secret: {
        Args: { p_name: string; p_secret: string }
        Returns: string
      }
      dashboard_runs: {
        Args: { p_n?: number; p_org_id: string; p_window_start: string }
        Returns: {
          created_at: string
          id: string
          overall_score: number
          rubric_id: string
          run_no: number
          status: Database["public"]["Enums"]["eval_run_status"]
        }[]
      }
      delete_connection_secret: {
        Args: { p_secret_id: string }
        Returns: undefined
      }
      dequeue_eval_run_message: {
        Args: { vt_seconds?: number }
        Returns: {
          msg_id: number
          run_id: string
        }[]
      }
      enqueue_eval_run: { Args: { run_id: string }; Returns: undefined }
      ensure_optimization_grant: {
        Args: {
          p_included: number
          p_org_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: undefined
      }
      ensure_point_grant: {
        Args: {
          p_included: number
          p_org_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: undefined
      }
      expire_runs_before: {
        Args: { p_cutoff: string; p_org_id: string }
        Returns: {
          eval_expired: number
          opt_expired: number
        }[]
      }
      get_connection_auth: { Args: { p_secret_id: string }; Returns: string }
      get_provider_secret: { Args: { p_secret_id: string }; Returns: string }
      increment_rate_limit: {
        Args: {
          p_hashed_key: string
          p_keytype: string
          p_surface: string
          p_window_start: string
        }
        Returns: number
      }
      managed_invoice_candidate_orgs: {
        Args: never
        Returns: {
          org_id: string
        }[]
      }
      managed_spend_total: {
        Args: { p_org_id: string; p_period_start: string }
        Returns: number
      }
      managed_uninvoiced_total: {
        Args: { p_org_id: string; p_period_start: string }
        Returns: number
      }
      mark_managed_line_invoiced: {
        Args: {
          p_amount: number
          p_invoice_id: string
          p_item_id: string
          p_model: string
          p_org_id: string
          p_period_start: string
          p_provider: string
        }
        Returns: undefined
      }
      optimization_run_balance: {
        Args: { p_org_id: string; p_period_start: string }
        Returns: number
      }
      point_balance: {
        Args: { p_org_id: string; p_period_start: string }
        Returns: number
      }
      projected_overage_usd: {
        Args: {
          p_point_balance: number
          p_point_unit_usd: number
        }
        Returns: number
      }
      purge_expired_runs: {
        Args: { p_grace_days?: number }
        Returns: {
          eval_purged: number
          opt_purged: number
        }[]
      }
      reap_stale_eval_runs: {
        Args: { p_threshold_minutes?: number }
        Returns: number
      }
      reap_stale_optimization_runs: {
        Args: { p_threshold_minutes?: number }
        Returns: number
      }
      reconcile_plan_grants: {
        Args: {
          p_included_points: number
          p_included_runs: number
          p_org_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: undefined
      }
      refresh_managed_invoice_lines: {
        Args: { p_org_id: string; p_period_start: string }
        Returns: undefined
      }
      refresh_overage_line: {
        Args: { p_meter: string; p_org_id: string; p_period_start: string }
        Returns: undefined
      }
      release_managed_reservation: {
        Args: { p_eval_run_id?: string; p_opt_run_id?: string }
        Returns: undefined
      }
      reserve_eval_points: {
        Args: {
          p_cost: number
          p_included: number
          p_meta?: Json
          p_org_id: string
          p_period_end: string
          p_period_start: string
          p_point_unit_usd?: number
          p_run_id: string
        }
        Returns: {
          balance: number
          cap_usd: number
          reserved: boolean
        }[]
      }
      reserve_optimization_points: {
        Args: {
          p_cost: number
          p_included: number
          p_meta?: Json
          p_org_id: string
          p_period_end: string
          p_period_start: string
          p_point_unit_usd?: number
          p_run_id: string
        }
        Returns: {
          balance: number
          cap_usd: number
          reserved: boolean
        }[]
      }
      reserve_managed_spend: {
        Args: {
          p_cap_usd: number
          p_estimate_usd: number
          p_eval_run_id?: string
          p_markup_pct: number
          p_opt_run_id?: string
          p_org_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          committed_usd: number
          reserved: boolean
        }[]
      }
      reserve_optimization_run: {
        Args: {
          p_included: number
          p_lifetime?: boolean
          p_org_id: string
          p_period_end: string
          p_period_start: string
          p_run_id: string
        }
        Returns: {
          balance: number
          reserved: boolean
        }[]
      }
      restore_runs_since: {
        Args: { p_cutoff: string; p_org_id: string }
        Returns: {
          eval_restored: number
          opt_restored: number
        }[]
      }
      retention_candidate_orgs: { Args: never; Returns: string[] }
      set_provider_key: {
        Args: {
          p_created_by: string
          p_last4: string
          p_org_id: string
          p_provider: string
          p_secret: string
        }
        Returns: string
      }
      settle_eval_run_points: {
        Args: { p_outcome: string; p_run_id: string }
        Returns: undefined
      }
      settle_optimization_run: {
        Args: { p_run_id: string }
        Returns: undefined
      }
      settle_optimization_run_points: {
        Args: { p_outcome: string; p_run_id: string }
        Returns: undefined
      }
      tick_managed_threshold: { Args: never; Returns: number }
      tick_retention: { Args: never; Returns: number }
      tick_schedules: { Args: never; Returns: number }
    }
    Enums: {
      eval_run_status: "queued" | "running" | "completed" | "failed" | "skipped"
      evaluation_mode: "conversational" | "prompt_response"
      optimization_run_status: "queued" | "running" | "completed" | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      eval_run_status: ["queued", "running", "completed", "failed", "skipped"],
      evaluation_mode: ["conversational", "prompt_response"],
      optimization_run_status: ["queued", "running", "completed", "failed"],
    },
  },
} as const

