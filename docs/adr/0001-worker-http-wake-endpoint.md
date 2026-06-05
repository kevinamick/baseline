# Worker uses an HTTP wake endpoint to trigger Fly machine start

The eval worker is a pgmq queue consumer that exits after the queue is idle, allowing Fly to stop the machine (`auto_stop_machines = "stop"`). To restart it when a new job is enqueued, the worker exposes a minimal HTTP endpoint. `createEvalRun` POSTs to it after enqueuing, which causes Fly's `auto_start_machines` to start the stopped machine before the request arrives.

## Considered options

**Fly Machines API** — `createEvalRun` calls `POST /v1/apps/{app}/machines/{id}/start` directly. Rejected because it requires a `FLY_API_TOKEN` and a hardcoded machine ID in the Next.js environment, and adds a Fly-specific API call to the application layer.

**Fly Sprites** — Sprites auto-sleep on HTTP inactivity and wake on incoming requests. Rejected because Sprites sleep based on HTTP traffic, not outbound queue activity; the worker's poll loop would not be considered idle by the platform, so the machine would never sleep.
