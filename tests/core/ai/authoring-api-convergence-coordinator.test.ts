import { describe, it, expect, vi } from 'vitest';
import { AuthoringApiConvergenceCoordinator } from '../../../src/core/ai/authoring-api-convergence-coordinator.js';
import type { AuthoringApiConvergenceCoordinatorDeps } from '../../../src/core/ai/authoring-api-convergence-coordinator.js';
import type { AgentProfile, AgentRoute, GateReviewExchange } from '../../../src/types/ai.js';
import type { Run } from '../../../src/types/runs.js';

const WORKING_DIR = '/ws/test';

const proposerProfile: AgentProfile = {
  id: 'artifact-agent',
  provider: 'anthropic_agent_sdk',
  model: 'claude-sonnet-4-6',
};
const criticProfile: AgentProfile = {
  id: 'review-agent',
  provider: 'anthropic_agent_sdk',
  model: 'claude-opus-4-5',
};

const routingPolicy = {
  resolve: (route: AgentRoute): AgentProfile => {
    if (route.task === 'artifact.api.propose') return proposerProfile;
    if (route.task === 'artifact.api.critique') return criticProfile;
    if (route.task === 'artifact.create') return proposerProfile;
    if (route.task === 'spec.review') return criticProfile;
    throw new Error(`Unexpected route: ${route.task}`);
  },
  resolveOptional: (route: AgentRoute): AgentProfile | null => {
    try {
      return routingPolicy.resolve(route);
    } catch {
      return null;
    }
  },
};

const validArtifact = {
  files: [{ path: 'src/example.ts', purpose: 'main module', exports: ['foo'] }],
  public_api: [
    {
      symbol: 'foo',
      signature: 'export function foo(): void',
      parameters: [],
      returns: 'void',
      errors: [],
    },
  ],
  types: [],
  notes: '',
};

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'implementing',
    workspace_path: WORKING_DIR,
    branch: 'spec/req-001',
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 1,
    pr_url: undefined,
    last_impl_result: undefined,
    review_exchanges: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunner() {
  return {
    run: vi.fn().mockReturnValue((async function* () {
      yield { type: 'assistant', content: [] };
    })()),
  };
}

function makeDeps(overrides: Partial<AuthoringApiConvergenceCoordinatorDeps> = {}): AuthoringApiConvergenceCoordinatorDeps {
  return {
    runner: makeRunner() as never,
    routingPolicy,
    policy: { enabled: true, max_rounds: 5, allow_same_model: false },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    readFile: vi.fn().mockResolvedValue(JSON.stringify(validArtifact)),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeArtifactReadFile(critiqueResult: object) {
  return async (path: string, _enc: 'utf-8'): Promise<string> => {
    if (path.includes('authoring-api-artifact.json')) {
      return JSON.stringify(validArtifact);
    }
    if (path.includes('authoring-api-critique-result.json')) {
      return JSON.stringify(critiqueResult);
    }
    // Spec file
    return '# Feature\n\n## Task list\n';
  };
}

describe('AuthoringApiConvergenceCoordinator', () => {
  describe('converges when critic returns no_findings', () => {
    it('returns { artifact, markdown, converged: true }', async () => {
      const deps = makeDeps({
        readFile: makeArtifactReadFile({ status: 'no_findings', summary: 'Looks good', findings: [] }),
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.run({
        run,
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        captureFeedback: vi.fn(),
      });
      expect(result.converged).toBe(true);
      expect(result.markdown).toContain('## Converged API');
      expect(result.artifact).toBeDefined();
    });

    it('writes one GateReviewExchange with gate: api and converged: true', async () => {
      const deps = makeDeps({
        readFile: makeArtifactReadFile({ status: 'no_findings', summary: 'Clean', findings: [] }),
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const run = makeRun();
      const capturedExchanges: unknown[] = [];

      await coordinator.run({
        run,
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        captureFeedback: (exchange: GateReviewExchange) => capturedExchanges.push(exchange),
      });

      expect(capturedExchanges).toHaveLength(1);
      expect((capturedExchanges[0] as GateReviewExchange).gate).toBe('api');
      expect((capturedExchanges[0] as GateReviewExchange).converged).toBe(true);
    });

    it('appends gate_exchange to run.gate_exchanges', async () => {
      const deps = makeDeps({
        readFile: makeArtifactReadFile({ status: 'no_findings', summary: 'Clean', findings: [] }),
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const run = makeRun();

      await coordinator.run({
        run,
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
      });

      expect(run.gate_exchanges).toHaveLength(1);
      expect(run.gate_exchanges![0]!.gate).toBe('api');
      expect(run.gate_exchanges![0]!.converged).toBe(true);
    });
  });

  describe('on findings, runs proposer revision with role proposer then critic round 2', () => {
    it('converges on round 2 when critic returns findings in round 1 and no_findings in round 2', async () => {
      let critiqueCallCount = 0;
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) {
          return JSON.stringify(validArtifact);
        }
        if (path.includes('authoring-api-critique-result.json')) {
          critiqueCallCount++;
          if (critiqueCallCount === 1) {
            return JSON.stringify({
              status: 'findings',
              summary: 'Round 1 issues',
              findings: [{ id: 'API-1', severity: 'warning', category: 'api', finding: 'Missing error handling.' }],
            });
          }
          return JSON.stringify({ status: 'no_findings', summary: 'All clear', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockReturnValue((async function* () {
          yield { type: 'assistant', content: [] };
        })()),
      };

      const deps = makeDeps({ readFile, runner: runner as never });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.run({
        run,
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
      });

      expect(result.converged).toBe(true);
      // runner.run called: proposer (round 1), critic (round 1), proposer revise, critic (round 2)
      expect(runner.run).toHaveBeenCalledTimes(4);
    });

    it('calls proposer revision with role proposer', async () => {
      let critiqueCallCount = 0;
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) {
          return JSON.stringify(validArtifact);
        }
        if (path.includes('authoring-api-critique-result.json')) {
          critiqueCallCount++;
          if (critiqueCallCount === 1) {
            return JSON.stringify({
              status: 'findings',
              summary: 'Issues found',
              findings: [{ id: 'API-1', severity: 'warning', category: 'api', finding: 'Problem.' }],
            });
          }
          return JSON.stringify({ status: 'no_findings', summary: 'Clean', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const capturedRequests: Array<{ route: AgentRoute }> = [];
      const runner = {
        run: vi.fn().mockImplementation((req: { route: AgentRoute }) => {
          capturedRequests.push(req);
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({ readFile, runner: runner as never });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);

      await coordinator.run({
        run: makeRun(),
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
      });

      // Third call should be the revision (proposer, role proposer)
      const revisionCall = capturedRequests[2];
      expect(revisionCall).toBeDefined();
      expect(revisionCall!.route.task).toBe('artifact.api.propose');
      expect(revisionCall!.route.role).toBe('proposer');
    });
  });

  describe('at max rounds, returns non-converged without failing', () => {
    it('returns { converged: false, non_convergence_reason: max_rounds } at max_rounds=1 with findings', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) {
          return JSON.stringify(validArtifact);
        }
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({
            status: 'findings',
            summary: 'Still blocked',
            findings: [{ id: 'API-1', severity: 'blocker', category: 'api', finding: 'Critical issue.' }],
          });
        }
        return '# Feature\n\n## Task list\n';
      };

      const deps = makeDeps({
        readFile,
        policy: { enabled: true, max_rounds: 1, allow_same_model: false },
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.run({
        run,
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
      });

      expect(result.converged).toBe(false);
      expect(result.non_convergence_reason).toBe('max_rounds');
    });

    it('does NOT throw when max rounds is reached', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) {
          return JSON.stringify(validArtifact);
        }
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({
            status: 'findings',
            summary: 'Blockers remain',
            findings: [{ id: 'API-1', severity: 'blocker', category: 'api', finding: 'Still blocked.' }],
          });
        }
        return '# Feature\n\n## Task list\n';
      };

      const deps = makeDeps({
        readFile,
        policy: { enabled: true, max_rounds: 1, allow_same_model: false },
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);

      await expect(
        coordinator.run({
          run: makeRun(),
          artifact_path: '/ws/spec.md',
          working_directory: WORKING_DIR,
        }),
      ).resolves.not.toThrow();
    });

    it('emits a gate exchange with converged: false at max rounds', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) {
          return JSON.stringify(validArtifact);
        }
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({
            status: 'findings',
            summary: 'Cap reached',
            findings: [{ id: 'API-1', severity: 'warning', category: 'api', finding: 'Issue.' }],
          });
        }
        return '# Feature\n\n## Task list\n';
      };

      const deps = makeDeps({
        readFile,
        policy: { enabled: true, max_rounds: 1, allow_same_model: false },
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const run = makeRun();
      const capturedExchanges: GateReviewExchange[] = [];

      await coordinator.run({
        run,
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        captureFeedback: (exchange: GateReviewExchange) => capturedExchanges.push(exchange),
      });

      expect(capturedExchanges).toHaveLength(1);
      expect(capturedExchanges[0]!.converged).toBe(false);
      expect(capturedExchanges[0]!.non_convergence_reason).toBe('max_rounds');
    });
  });

  describe('rejects same proposer/critic profile ID unless allow_same_model: true', () => {
    it('throws with message mentioning allow_same_model when profiles share the same ID', async () => {
      const sameProfile: AgentProfile = {
        id: 'same-agent',
        provider: 'anthropic_agent_sdk',
        model: 'claude-sonnet-4-6',
      };

      const sameRoutingPolicy = {
        resolve: (_route: AgentRoute): AgentProfile => sameProfile,
        resolveOptional: (_route: AgentRoute): AgentProfile | null => sameProfile,
      };

      const deps = makeDeps({
        routingPolicy: sameRoutingPolicy,
        policy: { enabled: true, max_rounds: 5, allow_same_model: false },
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);

      await expect(
        coordinator.run({
          run: makeRun(),
          artifact_path: '/ws/spec.md',
          working_directory: WORKING_DIR,
        }),
      ).rejects.toThrow(/allow_same_model/);
    });

    it('does not throw when same profile ID and allow_same_model: true', async () => {
      const sameProfile: AgentProfile = {
        id: 'same-agent',
        provider: 'anthropic_agent_sdk',
        model: 'claude-sonnet-4-6',
      };

      const sameRoutingPolicy = {
        resolve: (_route: AgentRoute): AgentProfile => sameProfile,
        resolveOptional: (_route: AgentRoute): AgentProfile | null => sameProfile,
      };

      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) return JSON.stringify(validArtifact);
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({ status: 'no_findings', summary: 'OK', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const deps = makeDeps({
        routingPolicy: sameRoutingPolicy,
        policy: { enabled: true, max_rounds: 5, allow_same_model: true },
        readFile,
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);

      await expect(
        coordinator.run({
          run: makeRun(),
          artifact_path: '/ws/spec.md',
          working_directory: WORKING_DIR,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('invalid proposer JSON consumes a round', () => {
    it('at max_rounds=1 with invalid artifact JSON, throws error', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) {
          return 'this is not valid json { broken }';
        }
        return '# Feature\n\n## Task list\n';
      };

      const deps = makeDeps({
        readFile,
        policy: { enabled: true, max_rounds: 1, allow_same_model: false },
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);

      await expect(
        coordinator.run({
          run: makeRun(),
          artifact_path: '/ws/spec.md',
          working_directory: WORKING_DIR,
        }),
      ).rejects.toThrow();
    });

    it('with max_rounds=2 and invalid JSON on round 1, round is consumed and remaining rounds exhaust without throwing unexpectedly', async () => {
      // When round 1 has invalid artifact JSON, it's consumed via `continue`.
      // Round 2 skips the proposer (round !== 1) and currentArtifact is still null,
      // so it also `continue`s. The loop exits without a result, and the coordinator
      // throws "loop exited unexpectedly". This is the documented behavior for this scenario.
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) {
          return 'bad json';
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({
        readFile,
        runner: runner as never,
        policy: { enabled: true, max_rounds: 2, allow_same_model: false },
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);

      // With invalid JSON on round 1, all rounds are consumed without a valid artifact,
      // and the coordinator throws the "loop exited unexpectedly" sentinel error.
      await expect(
        coordinator.run({
          run: makeRun(),
          artifact_path: '/ws/spec.md',
          working_directory: WORKING_DIR,
        }),
      ).rejects.toThrow();
    });
  });

  describe('captures sessions with gate: api, role, and round', () => {
    it('proposer session has gate: api, role: proposer, round: 1', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) return JSON.stringify(validArtifact);
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({ status: 'no_findings', summary: 'OK', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({ readFile, runner: runner as never });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const capturedSessions: unknown[] = [];

      await coordinator.run({
        run: makeRun(),
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        captureSession: (data) => capturedSessions.push(data),
      });

      const proposerSession = capturedSessions.find(
        (s) => (s as Record<string, unknown>)['role'] === 'proposer',
      ) as Record<string, unknown> | undefined;

      expect(proposerSession).toBeDefined();
      expect(proposerSession!['gate']).toBe('api');
      expect(proposerSession!['role']).toBe('proposer');
      expect(proposerSession!['round']).toBe(1);
    });

    it('critic session has gate: api, role: critic, round: 1', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) return JSON.stringify(validArtifact);
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({ status: 'no_findings', summary: 'OK', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({ readFile, runner: runner as never });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const capturedSessions: unknown[] = [];

      await coordinator.run({
        run: makeRun(),
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        captureSession: (data) => capturedSessions.push(data),
      });

      const criticSession = capturedSessions.find(
        (s) => (s as Record<string, unknown>)['role'] === 'critic',
      ) as Record<string, unknown> | undefined;

      expect(criticSession).toBeDefined();
      expect(criticSession!['gate']).toBe('api');
      expect(criticSession!['role']).toBe('critic');
      expect(criticSession!['round']).toBe(1);
    });

    it('multi-round run captures correct round numbers per session', async () => {
      let critiqueCount = 0;
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) return JSON.stringify(validArtifact);
        if (path.includes('authoring-api-critique-result.json')) {
          critiqueCount++;
          if (critiqueCount === 1) {
            return JSON.stringify({
              status: 'findings',
              summary: 'Round 1 issues',
              findings: [{ id: 'API-1', severity: 'warning', category: 'api', finding: 'Issue.' }],
            });
          }
          return JSON.stringify({ status: 'no_findings', summary: 'Clean', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({ readFile, runner: runner as never });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const capturedSessions: Array<Record<string, unknown>> = [];

      await coordinator.run({
        run: makeRun(),
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        captureSession: (data) => capturedSessions.push(data as Record<string, unknown>),
      });

      // Expect: proposer(round=1), critic(round=1), proposer-revise(round=1), critic(round=2)
      const round1Proposers = capturedSessions.filter((s) => s['role'] === 'proposer' && s['round'] === 1);
      const round1Critics = capturedSessions.filter((s) => s['role'] === 'critic' && s['round'] === 1);
      const round2Critics = capturedSessions.filter((s) => s['role'] === 'critic' && s['round'] === 2);

      expect(round1Proposers.length).toBeGreaterThanOrEqual(1);
      expect(round1Critics).toHaveLength(1);
      expect(round2Critics).toHaveLength(1);
    });
  });

  describe('progress messages are emitted', () => {
    it('emits "API convergence round 1 started — proposer drafting API artifact"', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) return JSON.stringify(validArtifact);
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({ status: 'no_findings', summary: 'OK', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({ readFile, runner: runner as never });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const progressMessages: string[] = [];

      await coordinator.run({
        run: makeRun(),
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        onProgress: async (msg) => { progressMessages.push(msg); },
      });

      expect(progressMessages.some((m) => m.includes('API convergence round 1 started') && m.includes('proposer drafting API artifact'))).toBe(true);
    });

    it('emits "API critic returned N finding(s) — revising API artifact" when findings are present', async () => {
      let critiqueCount = 0;
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) return JSON.stringify(validArtifact);
        if (path.includes('authoring-api-critique-result.json')) {
          critiqueCount++;
          if (critiqueCount === 1) {
            return JSON.stringify({
              status: 'findings',
              summary: 'Issues',
              findings: [{ id: 'API-1', severity: 'warning', category: 'api', finding: 'Issue.' }],
            });
          }
          return JSON.stringify({ status: 'no_findings', summary: 'Clean', findings: [] });
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({ readFile, runner: runner as never });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const progressMessages: string[] = [];

      await coordinator.run({
        run: makeRun(),
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        onProgress: async (msg) => { progressMessages.push(msg); },
      });

      expect(progressMessages.some((m) => m.includes('API critic returned') && m.includes('finding(s)') && m.includes('revising API artifact'))).toBe(true);
    });

    it('emits "API convergence reached round cap — proceeding with current API" at max_rounds', async () => {
      const readFile = async (path: string, _enc: 'utf-8'): Promise<string> => {
        if (path.includes('authoring-api-artifact.json')) return JSON.stringify(validArtifact);
        if (path.includes('authoring-api-critique-result.json')) {
          return JSON.stringify({
            status: 'findings',
            summary: 'Blocked',
            findings: [{ id: 'API-1', severity: 'blocker', category: 'api', finding: 'Still blocked.' }],
          });
        }
        return '# Feature\n\n## Task list\n';
      };

      const runner = {
        run: vi.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'assistant', content: [] };
          })();
        }),
      };

      const deps = makeDeps({
        readFile,
        runner: runner as never,
        policy: { enabled: true, max_rounds: 1, allow_same_model: false },
      });
      const coordinator = new AuthoringApiConvergenceCoordinator(deps);
      const progressMessages: string[] = [];

      await coordinator.run({
        run: makeRun(),
        artifact_path: '/ws/spec.md',
        working_directory: WORKING_DIR,
        onProgress: async (msg) => { progressMessages.push(msg); },
      });

      expect(progressMessages.some((m) => m.includes('API convergence reached round cap') && m.includes('proceeding with current API'))).toBe(true);
    });
  });
});
