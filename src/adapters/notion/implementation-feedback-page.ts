import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import { redactSecrets } from '../../core/journal/redaction.js';
import type { NotionClient } from './notion-client.js';
import type {
  FeedbackItem,
  ImplementationReviewInput,
  ImplementationReviewPublisher,
  ImplementationReviewStatus,
  PublishedImplementationReview,
} from '../../types/impl-feedback-page.js';
import type { GateReviewExchange, ImplementationReviewExchange } from '../../types/ai.js';
export type {
  FeedbackItem,
  ImplementationReviewInput,
  ImplementationReviewPublisher,
  ImplementationReviewStatus,
  PublishedImplementationReview,
} from '../../types/impl-feedback-page.js';

function renderAiReviewMarkdown(exchanges: ImplementationReviewExchange[]): string {
  const lines: string[] = [];
  for (const ex of exchanges) {
    const phaseTitle = ex.phase === 'initial' ? 'Initial review' : 'Final review';
    lines.push(`### ${phaseTitle}`);
    lines.push('');
    lines.push(`Implementation model: \`${ex.implementation_profile.profile}\` (\`${ex.implementation_profile.model ?? ex.implementation_profile.provider}\`, \`${ex.implementation_profile.provider}\`)`);
    lines.push(`Review model: \`${ex.review_profile.profile}\` (\`${ex.review_profile.model ?? ex.review_profile.provider}\`, \`${ex.review_profile.provider}\`)`);
    lines.push(`Review status: ${ex.review_status}`);
    lines.push('');
    lines.push('#### Review findings');
    lines.push('');
    if (ex.findings.length === 0) {
      lines.push('- No blocking or informational findings.');
    } else {
      for (const finding of ex.findings) {
        const response = ex.responses.find(r => r.id === finding.id);
        lines.push(`- [x] [${finding.id}] ${redactSecrets(finding.finding)}`);
        if (response) {
          const label = response.disposition === 'fixed' ? 'Fixed' : 'Declined';
          lines.push(`  ${label} — ${redactSecrets(response.response)}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildAiReviewBlocks(exchanges: ImplementationReviewExchange[]): unknown[] {
  const blocks: unknown[] = [];
  for (const ex of exchanges) {
    const phaseTitle = ex.phase === 'initial' ? 'Initial review' : 'Final review';
    blocks.push({ type: 'heading_3', heading_3: { rich_text: [{ text: { content: phaseTitle } }] } });
    blocks.push({ type: 'paragraph', paragraph: { rich_text: [{ text: { content: `Implementation model: \`${ex.implementation_profile.profile}\`` } }] } });
    blocks.push({ type: 'paragraph', paragraph: { rich_text: [{ text: { content: `Review model: \`${ex.review_profile.profile}\`` } }] } });
    blocks.push({ type: 'paragraph', paragraph: { rich_text: [{ text: { content: `Review status: ${ex.review_status}` } }] } });
    if (ex.findings.length === 0) {
      blocks.push({ type: 'to_do', to_do: { rich_text: [{ text: { content: 'No blocking or informational findings.' } }], checked: false } });
    } else {
      for (const finding of ex.findings) {
        const response = ex.responses.find(r => r.id === finding.id);
        blocks.push({ type: 'to_do', to_do: { rich_text: [{ text: { content: `[${finding.id}] ${redactSecrets(finding.finding)}` } }], checked: Boolean(response) } });
      }
    }
  }
  return blocks;
}

function gateTitle(gate: string): string {
  return gate === 'initial' ? 'Initial review' : gate === 'final' ? 'Final review' : `${gate} review`;
}

function renderGateReviewMarkdown(exchanges: GateReviewExchange[]): string {
  const lines: string[] = [];
  const gates = [...new Set(exchanges.map(exchange => exchange.gate))];
  for (const gate of gates) {
    const gateExchanges = exchanges.filter(exchange => exchange.gate === gate).sort((a, b) => a.round - b.round);
    const latest = gateExchanges[gateExchanges.length - 1];
    const converged = latest?.converged === true;
    lines.push(`### ${gateTitle(gate)}`);
    lines.push('');
    lines.push(converged ? 'Convergence: converged' : `Convergence: failed (\`${latest?.non_convergence_reason ?? 'max_rounds'}\`)`);
    lines.push(`Rounds: ${gateExchanges.length}`);
    lines.push(`Proposer model: \`${latest?.proposer_profile.profile ?? 'unknown'}\``);
    lines.push(`Critic model: \`${latest?.critic_profile.profile ?? 'unknown'}\``);
    lines.push('');

    if (!converged) {
      lines.push('#### Open findings');
      lines.push('');
      const blockingFindings = latest.findings.filter(finding => finding.severity === 'blocker' || finding.severity === 'warning');
      // Build a map of the last known proposer response per finding ID from prior addressed rounds
      const lastResponseById = new Map<string, (typeof latest.responses)[number]>();
      for (const ex of gateExchanges) {
        for (const r of ex.responses) {
          lastResponseById.set(r.id, r);
        }
      }
      for (const finding of blockingFindings) {
        const response = lastResponseById.get(finding.id);
        lines.push(`- [ ] [${finding.id}] ${redactSecrets(finding.finding)}`);
        if (response) lines.push(`  Last proposer response: ${response.disposition === 'fixed' ? 'Fixed' : response.disposition === 'declined' ? 'Declined' : 'Needs input'} — ${redactSecrets(response.response)}`);
      }
      lines.push('');
      continue;
    }

    for (const exchange of gateExchanges) {
      const blockingFindings = exchange.findings.filter(finding => finding.severity === 'blocker' || finding.severity === 'warning');
      const infoFindings = exchange.findings.filter(finding => finding.severity === 'info');
      lines.push(`#### Round ${exchange.round} — ${exchange.converged ? 'converged' : 'findings'}`);
      lines.push('');
      if (blockingFindings.length === 0 && infoFindings.length === 0) {
        lines.push('- No blocker or warning findings.');
      }
      for (const finding of blockingFindings) {
        const response = exchange.responses.find(item => item.id === finding.id);
        lines.push(`- [x] [${finding.id}] ${redactSecrets(finding.finding)}`);
        if (response) lines.push(`  ${response.disposition === 'fixed' ? 'Fixed' : response.disposition === 'declined' ? 'Declined' : 'Needs input'} — ${redactSecrets(response.response)}`);
      }
      for (const finding of infoFindings) {
        lines.push(`- Note [${finding.id}] ${redactSecrets(finding.finding)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

interface NotionImplementationFeedbackPageOptions {
  logDestination?: pino.DestinationStream;
}

export class NotionImplementationFeedbackPage implements ImplementationReviewPublisher {
  private readonly client: NotionClient;
  private readonly testing_guides_database_id: string;
  private readonly logger: pino.Logger;
  private testingGuidesDataSourceIdPromise: Promise<string> | undefined;

  constructor(
    client: NotionClient,
    testing_guides_database_id: string,
    options?: NotionImplementationFeedbackPageOptions,
  ) {
    this.client = client;
    this.testing_guides_database_id = testing_guides_database_id;
    this.logger = createLogger('implementation-feedback-page', { destination: options?.logDestination });
  }

  private getTestingGuidesDataSourceId(): Promise<string> {
    if (!this.testingGuidesDataSourceIdPromise) {
      this.testingGuidesDataSourceIdPromise = this.client.databases
        .retrieve(this.testing_guides_database_id)
        .then(db => db.data_sources[0].id);
    }
    return this.testingGuidesDataSourceIdPromise;
  }

  async create(input: ImplementationReviewInput): Promise<PublishedImplementationReview> {
    const dataSourceId = await this.getTestingGuidesDataSourceId();

    // Build Changes bullets (structured or legacy fallback)
    const changesBullets: string[] = input.review_summary?.changes?.length
      ? input.review_summary.changes
      : [input.summary || 'See implementation details.'];

    // Build Confirm bullets (structured or legacy fallback)
    const confirmBullets: string[] = input.review_summary?.confirm?.length
      ? input.review_summary.confirm
      : ['Confirm the implemented behavior matches the approved spec.'];

    // Build testing steps (structured or split from legacy testing_instructions)
    const rawSteps: string[] = input.testing_steps?.length
      ? input.testing_steps
      : (input.testing_instructions || '').split('\n').filter(s => s.trim());

    // Prepend cd step if workspace_path is available and no step starts with 'cd '
    const hasWorkspaceStep = rawSteps.some(s => s.trim().startsWith('cd '));
    const testingSteps: string[] = !hasWorkspaceStep && input.workspace_path
      ? [`cd ${input.workspace_path}`, ...rawSteps]
      : rawSteps;

    const response = await this.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: dataSourceId } as never,
      properties: {
        Title: {
          title: [{ text: { content: `Testing guide: ${input.title}` } }],
        },
        Spec: {
          relation: [{ id: input.artifact_ref }],
        },
        Status: {
          status: { name: 'Not started' },
        },
      } as never,
      children: [
        ...(input.artifact_url
          ? [{ type: 'bookmark', bookmark: { url: input.artifact_url } } as never]
          : []),
        // Workspace section
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Workspace' } }] },
        } as never,
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: `Workspace: \`${input.workspace_path}\`` } }] },
        } as never,
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: `Branch: \`${input.branch}\`` } }] },
        } as never,
        // Summary section
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Summary' } }] },
        } as never,
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Changes' } }] },
        } as never,
        ...changesBullets.map(text => ({
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: text } }] },
        } as never)),
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Confirm' } }] },
        } as never,
        ...confirmBullets.map(text => ({
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: text } }] },
        } as never)),
        // Testing instructions section
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Testing instructions' } }] },
        } as never,
        ...testingSteps.map(text => ({
          type: 'to_do',
          to_do: { rich_text: [{ text: { content: text } }], checked: false },
        } as never)),
        // Additional steps section
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Additional steps' } }] },
        } as never,
        {
          type: 'to_do',
          to_do: { rich_text: [{ text: { content: 'Add any extra testing steps here.' } }], checked: false },
        } as never,
        // Human review section
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Human review' } }] },
        } as never,
        ...(input.gate_exchanges?.length
          ? [
              {
                type: 'heading_2',
                heading_2: { rich_text: [{ text: { content: 'AI review' } }] },
              } as never,
              {
                type: 'paragraph',
                paragraph: { rich_text: [{ text: { content: renderGateReviewMarkdown(input.gate_exchanges) } }] },
              } as never,
            ]
          : input.review_exchanges?.length
          ? [
              {
                type: 'heading_2',
                heading_2: { rich_text: [{ text: { content: 'AI review' } }] },
              } as never,
              ...buildAiReviewBlocks(input.review_exchanges) as never[],
            ]
          : []),
      ],
    });

    const page_id = (response as { id: string }).id;
    this.logger.info(
      { event: 'notion_testing_guide.created', page_id, spec_page_id: input.artifact_ref },
      'Testing guide database entry created',
    );
    return {
      id: page_id,
      url: `https://notion.so/${page_id.replace(/-/g, '')}`,
      label: 'View testing guide',
    };
  }

  async readFeedback(page_id: string): Promise<FeedbackItem[]> {
    const blocksResponse = await this.client.blocks.children.list({ block_id: page_id });
    const blocks = blocksResponse.results as Array<{
      id: string;
      type: string;
      has_children?: boolean;
      heading_2?: { rich_text: Array<{ plain_text: string }> };
      to_do?: { rich_text: Array<{ plain_text: string }>; checked: boolean };
      _children?: unknown[];
    }>;

    const feedbackItems: FeedbackItem[] = [];
    let inFeedbackSection = false;

    for (const block of blocks) {
      // Track which section we are in based on heading_2 blocks
      if (block.type === 'heading_2' && block.heading_2) {
        const headingText = block.heading_2.rich_text.map(r => r.plain_text).join('');
        inFeedbackSection = headingText === 'Human review' || headingText === 'Feedback';
        continue;
      }

      // Only collect to_do blocks inside the Feedback section
      if (!inFeedbackSection) continue;
      if (block.type !== 'to_do' || !block.to_do) continue;

      const text = block.to_do.rich_text.map((r: { plain_text: string }) => r.plain_text).join('');
      const resolved = block.to_do.checked;
      const conversation: string[] = [];

      if (block.has_children || (block._children && (block._children as unknown[]).length > 0)) {
        const childResponse = await this.client.blocks.children.list({ block_id: block.id });
        const children = childResponse.results as Array<{
          type: string;
          paragraph?: { rich_text: Array<{ plain_text: string }> };
        }>;
        for (const child of children) {
          if (child.type === 'paragraph' && child.paragraph) {
            const childText = child.paragraph.rich_text.map((r: { plain_text: string }) => r.plain_text).join('');
            if (childText) conversation.push(childText);
          }
        }
      }

      feedbackItems.push({ id: block.id, text, resolved, conversation });
    }

    this.logger.debug(
      { event: 'implementation.feedback_read', page_id, item_count: feedbackItems.length },
      'Feedback read from Notion page',
    );
    return feedbackItems;
  }

  async update(
    page_id: string,
    options: {
      summary?: string;
      review_summary?: {
        changes: string[];
        confirm: string[];
      };
      testing_steps?: string[];
      resolved_items?: Array<{
        id: string;
        resolution_comment: string;
      }>;
      review_exchanges?: ImplementationReviewExchange[];
      gate_exchanges?: GateReviewExchange[];
    },
  ): Promise<void> {
    let markdown = await this.client.pages.getMarkdown(page_id);

    // --- Resolve feedback items (scoped to Feedback section) ---
    if (options.resolved_items && options.resolved_items.length > 0) {
      const resolvedMap = new Map<string, string>();
      for (const item of options.resolved_items) {
        resolvedMap.set(item.id, item.resolution_comment);
      }

      const blocksResponse = await this.client.blocks.children.list({ block_id: page_id });
      const blocks = blocksResponse.results as Array<{
        id: string;
        type: string;
        to_do?: { rich_text: Array<{ plain_text: string }>; checked: boolean };
      }>;

      // Split markdown at Feedback heading to scope replacements
      const feedbackSplit = '\n## Feedback\n';
      const feedbackStartIdx = markdown.indexOf(feedbackSplit);
      let beforeFeedback = feedbackStartIdx === -1
        ? markdown
        : markdown.substring(0, feedbackStartIdx + feedbackSplit.length);
      let feedbackContent = feedbackStartIdx === -1
        ? ''
        : markdown.substring(feedbackStartIdx + feedbackSplit.length);

      if (feedbackStartIdx === -1) {
        this.logger.warn(
          { event: 'implementation.legacy_page_structure', page_id },
          'Page missing Feedback heading; applying resolved items globally',
        );
      }

      for (const block of blocks) {
        if (block.type !== 'to_do' || !block.to_do) continue;
        const resolutionComment = resolvedMap.get(block.id);
        if (!resolutionComment) continue;

        const itemText = block.to_do.rich_text.map((r: { plain_text: string }) => r.plain_text).join('');
        const alreadyCheckedRegex = new RegExp(`^- \\[x\\] ${escapeRegex(itemText)}`, 'm');
        const uncheckedPattern = new RegExp(`(^- \\[ \\] ${escapeRegex(itemText)})`, 'm');
        const targetContent = feedbackStartIdx !== -1 ? feedbackContent : markdown;

        if (!alreadyCheckedRegex.test(targetContent)) {
          const replacement = `- [x] ${itemText}\n  - ✓ ${resolutionComment}`;
          if (feedbackStartIdx !== -1) {
            feedbackContent = feedbackContent.replace(uncheckedPattern, replacement);
          } else {
            markdown = markdown.replace(uncheckedPattern, replacement);
          }
        }
      }

      if (feedbackStartIdx !== -1) {
        markdown = beforeFeedback + feedbackContent;
      }

      this.logger.info(
        { event: 'implementation.feedback_resolved', page_id, resolved_count: options.resolved_items.length },
        'Testing guide checked off resolved feedback items',
      );
    }

    // --- Replace Summary with review_summary or legacy summary ---
    if (options.review_summary) {
      const changesMarkdown = options.review_summary.changes.map(c => `- ${c}`).join('\n');
      const confirmMarkdown = options.review_summary.confirm.map(c => `- ${c}`).join('\n');
      const newSummaryContent = `### Changes\n\n${changesMarkdown}\n\n### Confirm\n\n${confirmMarkdown}\n`;
      const summaryPattern = /(## Summary\n\n?)[\s\S]*?(?=\n## |\n*$)/;
      markdown = markdown.replace(summaryPattern, `$1${newSummaryContent}`);
    } else if (options.summary !== undefined) {
      const summaryPattern = /(## Summary\n\n?)[\s\S]*?(?=\n## |\n*$)/;
      markdown = markdown.replace(summaryPattern, `$1${options.summary}\n`);
    }

    // --- Append new testing steps (deduplicating, before Additional steps / Feedback) ---
    if (options.testing_steps && options.testing_steps.length > 0) {
      const testingInstructionsPattern = /## Testing instructions\n\n([\s\S]*?)(?=\n## (?:Additional steps|Feedback)|$)/;
      const testingMatch = markdown.match(testingInstructionsPattern);
      const existingItemsRaw = testingMatch
        ? (testingMatch[1].match(/^- \[[ x]\] .+/gm) ?? []).map(item => item.replace(/^- \[[ x]\] /, ''))
        : [];
      const existingSet = new Set(existingItemsRaw.map(item => normalizeStep(item).toLowerCase()));
      const existingBaselineCategories = new Set(
        existingItemsRaw
          .map(item => getBaselineCategory(item))
          .filter((c): c is BaselineCategory => c !== null),
      );

      const newSteps = options.testing_steps.filter(step => {
        const normalizedLower = normalizeStep(step).toLowerCase();
        if (existingSet.has(normalizedLower)) return false;
        const category = getBaselineCategory(step);
        if (category !== null && existingBaselineCategories.has(category)) return false;
        return true;
      });
      const skippedCount = options.testing_steps.length - newSteps.length;

      if (newSteps.length > 0) {
        const newStepsMarkdown = newSteps.map(s => `- [ ] ${s}`).join('\n');
        // Insert just before ## Additional steps or ## Feedback (whichever comes first after testing instructions)
        const insertBefore = /(\n## (?:Additional steps|Feedback))/;
        const match = markdown.match(insertBefore);
        if (match && match.index !== undefined) {
          const insertIdx = match.index;
          markdown = markdown.substring(0, insertIdx) + '\n' + newStepsMarkdown + markdown.substring(insertIdx);
        } else {
          markdown += '\n' + newStepsMarkdown;
        }
      }

      this.logger.debug(
        { event: 'implementation.testing_steps_appended', page_id, appended_count: newSteps.length, skipped_count: skippedCount },
        'New testing steps appended to existing Testing instructions list',
      );
    }

    // --- Replace or append AI review section ---
    if (options.gate_exchanges !== undefined) {
      const aiReviewContent = renderGateReviewMarkdown(options.gate_exchanges);
      const aiReviewHeading = '\n## AI review\n';
      const aiReviewPattern = /\n## AI review\n[\s\S]*$/;
      if (aiReviewPattern.test(markdown)) {
        markdown = markdown.replace(aiReviewPattern, `${aiReviewHeading}\n${aiReviewContent}`);
      } else {
        if (!markdown.includes('\n## Human review\n') && !markdown.includes('\n## Feedback\n')) {
          this.logger.warn({ event: 'implementation.missing_human_review', page_id }, 'Page missing Human review section; appending AI review at end');
        }
        markdown = markdown.trimEnd() + `\n\n## AI review\n\n${aiReviewContent}`;
      }
    } else if (options.review_exchanges !== undefined) {
      const aiReviewContent = renderAiReviewMarkdown(options.review_exchanges);
      const aiReviewHeading = '\n## AI review\n';
      const aiReviewPattern = /\n## AI review\n[\s\S]*$/;
      if (aiReviewPattern.test(markdown)) {
        markdown = markdown.replace(aiReviewPattern, `${aiReviewHeading}\n${aiReviewContent}`);
      } else {
        if (!markdown.includes('\n## Human review\n') && !markdown.includes('\n## Feedback\n')) {
          this.logger.warn({ event: 'implementation.missing_human_review', page_id }, 'Page missing Human review section; appending AI review at end');
        }
        markdown = markdown.trimEnd() + `\n\n## AI review\n\n${aiReviewContent}`;
      }
    }

    await this.client.pages.updateMarkdown(page_id, {
      type: 'replace_content',
      replace_content: { new_str: markdown },
    });

    this.logger.info(
      { event: 'implementation.feedback_updated', page_id, resolved_count: options.resolved_items?.length ?? 0 },
      'Implementation feedback page updated',
    );
  }

  async updateStatus(page_id: string, status: ImplementationReviewStatus): Promise<void> {
    await this.client.pages.updateProperties(page_id, {
      Status: { status: { name: testingGuideStatusName(status) } },
    });
    this.logger.info(
      { event: 'notion_testing_guide.status_updated', page_id, status },
      'Testing guide status updated',
    );
  }

  async setPRLink(page_id: string, pr_url: string): Promise<void> {
    await this.client.pages.updateProperties(page_id, {
      'PR link': { url: pr_url },
    });
    this.logger.info(
      { event: 'notion_testing_guide.pr_link_set', page_id, pr_url },
      'Testing guide PR link set',
    );
  }
}

function testingGuideStatusName(status: ImplementationReviewStatus): string {
  const labels: Record<ImplementationReviewStatus, string> = {
    not_started: 'Not started',
    in_progress: 'In progress',
    waiting_on_feedback: 'Waiting on feedback',
    approved: 'Approved',
  };
  return labels[status];
}

function normalizeStep(step: string): string {
  // Trim first so surrounding whitespace doesn't prevent backtick stripping at boundaries
  let s = step.trim();
  // Strip surrounding backticks
  s = s.replace(/^`+|`+$/g, '');
  // Trim again and collapse internal whitespace
  s = s.trim().replace(/\s+/g, ' ');
  // Remove trailing slash from cd paths
  s = s.replace(/^(cd\s+\S.*?)\/$/, '$1');
  return s;
}

type BaselineCategory = 'cd' | 'npm_install' | 'test_command';

function getBaselineCategory(step: string): BaselineCategory | null {
  const s = normalizeStep(step).toLowerCase();
  if (/^cd\s+/.test(s)) return 'cd';
  if (/^(npm\s+ci|npm\s+install|yarn\s+install|pnpm\s+install)\b/.test(s)) return 'npm_install';
  // npm test / yarn test are always generic baseline commands
  if (/^(npm\s+test|yarn\s+test)\b/.test(s)) return 'test_command';
  // npx vitest / npx jest: only singleton when no specific file/path argument is present;
  // commands like `npx vitest run tests/foo.test.ts` are genuinely distinct steps
  if (/^(npx\s+vitest|npx\s+jest)\b/.test(s)) {
    const afterBase = s.replace(/^npx\s+(vitest|jest)\s*(run\s*)?/, '').trim();
    const hasPathArg = /[/\\]|\.test\.|\.spec\./.test(afterBase);
    if (!hasPathArg) return 'test_command';
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
