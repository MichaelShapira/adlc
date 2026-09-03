# ADLC Bug-Fix PoC

A proof of concept for an **agentic development lifecycle (ADLC)** on AWS: paste a
bug report, let AI triage it and draft a fix plan, approve it at a human gate (or
auto-approve simple cases), have the **Kiro CLI** coding agent implement the fix in
an isolated **Bedrock AgentCore** container, validate the result independently, and
get a fully audited report with cost and resource usage.

## Features

- **End-to-end pipeline** — triage → dual artifact draft (Simple prompt / Complex
  spec) → human approval gate → Kiro implementation → independent validation →
  bounded fix loop (max 3 attempts) → report. Orchestrated by AWS Step Functions.
- **Frozen artifacts** — the prompt or spec you approve is executed byte-for-byte
  on every attempt; retries can never drift from the approval.
- **Independent verification** — a hard build gate (`npm install && npm run build`
  must exit 0) plus a separate validator model reviewing the diff against the
  frozen artifact. The agent's own summary is displayed as a claim, not evidence.
- **Human-in-the-loop controls** — editable artifacts at the gate, execute/cancel,
  optional auto-execute for SIMPLE triage verdicts (COMPLEX always pauses).
- **MCP support** — a JSON editor for Model Context Protocol servers; the config is
  snapshotted per run, written to `.kiro/settings/mcp.json` for Kiro inside the
  container, never committed, and every MCP tool call is logged.
- **Context library** — private notes, PDFs, and images that inform triage
  (multimodal Bedrock analysis).
- **Full cost & usage accounting** — analysis model tokens, Kiro credits (parsed
  from Kiro's structured stream output), and in-container CPU / peak-memory
  sampling via cgroup v2, per implementation attempt.
- **Read-only repository explorer** — before/after fix review with verification
  evidence, seeded-bug jump cards, guarded restore of the canonical buggy state,
  and guarded fix-branch deletion (`main` is structurally protected).
- **In-app user guide** — the 📖 button in the header.

## Architecture

```
React SPA (CloudFront + S3, Cognito auth)
        │
        ▼
API Gateway (HTTP API, JWT authorizer) ── Lambdas: runs, decision, models,
        │                                  repository, context, mcp
        ▼
Step Functions state machine
  TRIAGE ─ DRAFT ─ (auto-)GATE ─ IMPLEMENT ─ VALIDATE ─┐
     ▲                              │                  │ fail (≤3)
     │                              ▼                  ▼
  Bedrock (analysis models)   Bedrock AgentCore ── Kiro CLI (headless)
                                    │                + user MCP servers
                                    ▼
                              CodeCommit repo (fix/<run-id> branches)
```

Storage: DynamoDB (runs, context items + MCP config, repo control, reset audit),
S3 (context files, UI assets), Secrets Manager (Kiro API key).

## Repository structure

| Path | Contents |
|------|----------|
| `infra/` | AWS CDK app (single stack `AdlcPocStack`) and all Lambda sources |
| `agent/` | AgentCore container: `Dockerfile` and `app.py` (Kiro CLI harness) |
| `ui/` | React + Vite single-page application |
| `dummy-app/` | The seeded target repository (todo-service with BUG-001/BUG-002) |
| `docs/` | Design documents (todo-service design doc in Markdown and PDF) |

## Prerequisites

- An AWS account with **Bedrock model access** enabled for Anthropic Claude models
  (used for triage, drafting, and validation) in your deployment region
- A **Kiro subscription** and API key (`ksk_…`) from [kiro.dev](https://kiro.dev)
- Node.js ≥ 18 and npm
- Docker (the agent container image is built locally during deploy)
- AWS CLI configured, and the target account **CDK-bootstrapped**
  (`npx cdk bootstrap`)

## Deployment

```bash
# 1. Build the UI (its dist/ is deployed by the stack)
cd ui
npm install
npm run build

# 2. Deploy the stack
cd ../infra
npm install
npx cdk deploy AdlcPocStack --require-approval never
```

The stack outputs the CloudFront URL, API endpoint, Cognito pool/client IDs, the
state machine ARN, the AgentCore runtime ARN, and the Kiro key secret ARN. The
target repository is created and seeded automatically from `dummy-app/`.

### Post-deploy setup

1. **Kiro API key** (required — there is no fallback engine):

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id adlc-poc/kiro-api-key \
     --secret-string ksk_YOUR_KEY_HERE
   ```

2. **Create a user** (self-signup is disabled):

   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <UserPoolId output> \
     --username you@example.com \
     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
     --temporary-password 'ChooseATempPassword1!' \
     --message-action SUPPRESS

   # Optional: allow this user to restore the canonical buggy repo state
   aws cognito-idp admin-add-user-to-group \
     --user-pool-id <UserPoolId output> \
     --username you@example.com \
     --group-name repo-resetters
   ```

3. Open the **UiUrl** output, sign in (you will be asked to set a permanent
   password), and check that the "Implementation model" dropdown lists Kiro
   models — that proves the agent container and key work end to end.

## Usage

1. On the **Workflow** tab, load a seeded bug preset (or paste your own bug
   report), pick an analysis model, optionally enable context / auto-execute,
   and start the run.
2. Watch the pipeline timeline and live agent logs.
3. At the gate, review and optionally edit the Simple prompt or Complex spec,
   then execute.
4. Read the report: verification panel, usage breakdown, validation checks.
5. Click **Inspect fix** to see the before/after diff with evidence, or use the
   **Repository** tab directly.
6. Use **Restore buggy state** to reset the demo between sessions.

The in-app 📖 **User guide** covers every screen and field in detail.

## Costs

Each run consumes Bedrock tokens (analysis), Kiro credits (implementation), and
AgentCore compute — all reported per run in the UI. The idle stack costs are the
usual serverless baseline (DynamoDB on-demand, S3, CloudFront, Secrets Manager).
Delete the stack with `npx cdk destroy AdlcPocStack` when done.

## Security notes

This is a proof of concept, not a production system:

- API CORS is permissive (`*`) until tightened post-deploy.
- MCP servers configured by users run inside the agent container with the same
  trust as the coding agent — add only servers you trust.
- The Kiro key secret and Cognito resources use `RemovalPolicy.DESTROY`.
- The agent can only push `fix/*` branches; `main` is protected structurally and
  reset/delete operations require group membership plus typed confirmations.

## License

MIT — see [LICENSE](LICENSE).
