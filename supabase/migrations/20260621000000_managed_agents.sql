-- Managed Agent (#290, ADR-0014): an `agent` Connection whose System is Baseline's managed
-- LLM running a Team-supplied prompt, instead of an external HTTP endpoint. The optimization
-- loop invokes the model directly (system = the Candidate's prompt, user = the instance input),
-- so a Managed Agent has no endpoint / response_path / request_template — it carries a
-- target_model instead.
--
-- Discriminator on agent Connections: agent_kind. Existing agent rows backfill to 'external'
-- (today's HTTP path); 'managed' is the new one. Dataset connections keep agent_kind at its
-- default and are unaffected (the shape CHECK below only constrains kind = 'agent').

alter table public.connections
  add column agent_kind   text not null default 'external'
    check (agent_kind in ('external', 'managed')),
  add column target_model text;

-- endpoint / response_path were NOT NULL for the HTTP-only world; a Managed Agent has neither.
-- (request_template was already nullable.) The shape CHECK keeps external connections honest.
alter table public.connections
  alter column endpoint      drop not null,
  alter column response_path drop not null;

alter table public.connections
  add constraint connections_agent_kind_shape check (
    kind <> 'agent'
    or (agent_kind = 'external' and endpoint is not null and response_path is not null)
    or (agent_kind = 'managed'  and target_model is not null and endpoint is null)
  );
