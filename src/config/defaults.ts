export function generateDefaultConfig(repoName: string): string {
  return `# Autocatalyst configuration for ${repoName}
# All sections previously in WORKFLOW.md are now here.

polling:
  interval_ms: 30000

workspace:
  root: ~/.autocatalyst/workspaces/${repoName}

channels:
  - provider: slack
    name: <your-slack-channel>
    config:
      bot_token: \${AC_SLACK_BOT_TOKEN}
      app_token: \${AC_SLACK_APP_TOKEN}

publishers:
  - provider: notion
    artifacts:
      - artifact
      - implementation_feedback
    config:
      integration_token: \${AC_NOTION_INTEGRATION_TOKEN}
      specs_database_id: <your-specs-database-id>
      testing_guides_database_id: <your-testing-guides-database-id>

ai:
  credentials:
    - name: anthropic-default
      type: api_key
      value: \${ANTHROPIC_API_KEY}

  endpoints:
    - name: anthropic-direct
      protocol: anthropic
      credential: anthropic-default

  profiles:
    - name: classify-haiku
      endpoint: anthropic-direct
      model: claude-haiku-4-5-20251001
      runner: anthropic_direct
      anthropic:
        effort: low

    - name: impl-agent
      endpoint: anthropic-direct
      model: claude-sonnet-4-6
      runner: claude_agent_sdk
      anthropic:
        effort: high
        thinking: adaptive

    - name: artifact-agent
      endpoint: anthropic-direct
      model: claude-sonnet-4-6
      runner: claude_agent_sdk
      anthropic:
        effort: high
        thinking: adaptive

    - name: question-agent
      endpoint: anthropic-direct
      model: claude-sonnet-4-6
      runner: claude_agent_sdk
      anthropic:
        effort: low
        thinking: adaptive

    - name: triage-agent
      endpoint: anthropic-direct
      model: claude-sonnet-4-6
      runner: claude_agent_sdk
      anthropic:
        effort: high
        thinking: adaptive

    - name: review-agent
      endpoint: anthropic-direct
      model: claude-sonnet-4-6
      runner: claude_agent_sdk
      anthropic:
        effort: high
        thinking: adaptive

  routing:
    intent.classify: classify-haiku
    pr.title_generate: classify-haiku
    artifact.create: artifact-agent
    artifact.revise: artifact-agent
    implementation.plan: impl-agent
    implementation.run: impl-agent
    implementation.review.initial: review-agent
    implementation.review.final: review-agent
    question.answer: question-agent
    issue.triage: triage-agent

sandbox:
  env_tokens:
    - AC_GITHUB_TOKEN
`;
}
