import type { AgentProfile, AgentProfileSummary, AgentRoute, AgentRoutingPolicy, AgentEffort, AgentThinking } from '../../types/ai.js';
import type { AiConfig, ProfileConfig, EndpointConfig, RunnerKind } from '../../types/config.js';
import type { ResolvedCredential } from '../config.js';
import { requiredSkillsForRoute } from './route-skills.js';

export class DefaultAgentRoutingPolicy implements AgentRoutingPolicy {
  private readonly config: AiConfig;

  constructor(config: AiConfig) {
    this.config = config;
  }

  private profileNameFor(route: AgentRoute): string | undefined {
    if (route.role) {
      const roleKey = `${route.task}:${route.role}`;
      const roleProfileName = this.config.routing[roleKey];
      if (roleProfileName) return roleProfileName;
    }
    return this.config.routing[route.task];
  }

  resolve(route: AgentRoute): AgentProfile {
    const profileName = this.profileNameFor(route);
    if (!profileName) {
      if (route.role) {
        throw new Error(`No routing entry for task '${route.task}' or role key '${route.task}:${route.role}'`);
      }
      throw new Error(`No routing entry for task '${route.task}'`);
    }
    const profile = this.config.profiles.find(p => p.name === profileName)!;
    const endpoint = this.config.endpoints.find(e => e.name === profile.endpoint)!;
    const credential = this.config.credentials.find(c => c.name === endpoint.credential) as ResolvedCredential | undefined;
    return buildAgentProfile(profile, endpoint, credential, route);
  }

  resolveOptional(route: AgentRoute): AgentProfile | null {
    const profileName = this.profileNameFor(route);
    if (!profileName) return null;
    const profile = this.config.profiles.find(p => p.name === profileName);
    if (!profile) return null;
    const endpoint = this.config.endpoints.find(e => e.name === profile.endpoint)!;
    const credential = this.config.credentials.find(c => c.name === endpoint.credential) as ResolvedCredential | undefined;
    return buildAgentProfile(profile, endpoint, credential, route);
  }
}

function buildAgentProfile(
  profile: ProfileConfig,
  endpoint: EndpointConfig,
  credential: ResolvedCredential | undefined,
  route: AgentRoute,
): AgentProfile {
  const anthropicBetaHeaderFilter = betaHeaderFilterForEndpoint(endpoint);
  return {
    id: profile.name,
    provider: runnerToProvider(profile.runner),
    model: profile.model,
    effort: profile.anthropic?.effort as AgentEffort | undefined,
    thinking: profile.anthropic?.thinking as AgentThinking | undefined,
    required_skills: requiredSkillsForRoute(route),
    plugins: profile.plugins,
    api_key: credential?.resolvedValue,
    base_url: endpoint.base_url,
    ...(anthropicBetaHeaderFilter ? { anthropic_beta_header_filter: anthropicBetaHeaderFilter } : {}),
  };
}

function betaHeaderFilterForEndpoint(endpoint: EndpointConfig): AgentProfile['anthropic_beta_header_filter'] | undefined {
  const strip = endpoint.anthropic_beta_header_filter?.strip
    .map(value => value.trim())
    .filter(value => value.length > 0) ?? [];
  return strip.length > 0 ? { strip } : undefined;
}

function runnerToProvider(runner: RunnerKind): string {
  switch (runner) {
    case 'anthropic_direct': return 'anthropic';
    case 'openai_direct': return 'openai';
    case 'claude_agent_sdk': return 'claude_agent_sdk';
    case 'openai_agent_sdk': return 'openai_agent_sdk';
  }
}

export function agentProfileSummary(profile: Pick<AgentProfile, 'id' | 'provider' | 'model'>): AgentProfileSummary {
  return {
    profile: profile.id,
    provider: profile.provider,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
  };
}
