# Coding agent for the ADLC PoC — runs on Bedrock AgentCore Runtime (ARM64).
# Engine: Kiro CLI (headless) only; optional user-defined MCP servers.
FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/root

# git + curl for tooling, Node.js 22 for building the target repo
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends git curl ca-certificates unzip && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y -qq --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Kiro CLI (headless setup; binary copied onto PATH)
RUN curl -fsSL https://cli.kiro.dev/install | KIRO_CLI_SKIP_SETUP=1 bash && \
    cp /root/.local/bin/kiro-cli* /usr/local/bin/ 2>/dev/null || true

# Python deps: AgentCore runtime app SDK, AWS SDK, CodeCommit git remote helper,
# and uv (provides uvx, the standard launcher for Python-based MCP servers)
RUN pip install --no-cache-dir \
    bedrock-agentcore \
    boto3 \
    git-remote-codecommit \
    uv
# Pre-warm the most common MCP server so per-run startup does not pay the
# package download cost. Best effort: user configs can reference any server.
RUN uvx awslabs.aws-documentation-mcp-server@latest --help >/dev/null 2>&1 || true

# Git identity for the agent's commits
RUN git config --global user.name "adlc-coding-agent" && \
    git config --global user.email "adlc-coding-agent@example.com" && \
    git config --global init.defaultBranch main

WORKDIR /app
COPY app.py .

EXPOSE 8080
CMD ["python", "app.py"]
