import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotionImplementationFeedbackPage } from '../../../src/adapters/notion/implementation-feedback-page.js';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';
import type { ImplementationReviewInput } from '../../../src/types/impl-feedback-page.js';
import type { GateReviewExchange, ImplementationReviewExchange } from '../../../src/types/ai.js';

const nullDest = { write: () => {} };

function makeReviewExchange(overrides: Partial<ImplementationReviewExchange> = {}): ImplementationReviewExchange {
  return {
    id: 'ex-1',
    phase: 'initial',
    created_at: '2026-05-13T00:00:00Z',
    implementation_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' },
    review_profile: { profile: 'review-agent', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' },
    review_status: 'no_findings',
    review_summary: 'All good.',
    findings: [],
    responses: [],
    requires_human_retest: false,
    ...overrides,
  };
}

function makeNotionClient(overrides: Partial<{
  pagesCreate: ReturnType<typeof vi.fn>;
  blocksChildrenList: ReturnType<typeof vi.fn>;
  pagesGetMarkdown: ReturnType<typeof vi.fn>;
  pagesUpdateMarkdown: ReturnType<typeof vi.fn>;
  pagesUpdateProperties: ReturnType<typeof vi.fn>;
}> = {}): NotionClient {
  return {
    pages: {
      create: overrides.pagesCreate ?? vi.fn().mockResolvedValue({ id: 'new-page-id' }),
      getMarkdown: overrides.pagesGetMarkdown ?? vi.fn().mockResolvedValue(''),
      updateMarkdown: overrides.pagesUpdateMarkdown ?? vi.fn().mockResolvedValue(undefined),
      updateProperties: overrides.pagesUpdateProperties ?? vi.fn().mockResolvedValue(undefined),
    },
    blocks: {
      children: {
        list: overrides.blocksChildrenList ?? vi.fn().mockResolvedValue({ results: [] }),
      },
    },
    comments: {
      list: vi.fn().mockResolvedValue({ results: [] }),
      create: vi.fn().mockResolvedValue({}),
    },
    users: {
      me: vi.fn().mockResolvedValue({ id: 'bot-id' }),
    },
    databases: {
      retrieve: vi.fn().mockResolvedValue({ data_sources: [{ id: 'ds-testing-guides-id', name: 'Testing Guides' }] }),
    },
  } as unknown as NotionClient;
}

function makeReviewInput(overrides: Partial<ImplementationReviewInput> = {}): ImplementationReviewInput {
  return {
    artifact_ref: 'spec-page-id',
    artifact_url: 'https://notion.so/spec',
    title: 'Setup wizard',
    workspace_path: '/ws/test-workspace',
    branch: 'spec/test-branch',
    summary: 'sum',
    testing_instructions: 'test',
    ...overrides,
  };
}

// Helper: build a Notion to-do block
function makeTodoBlock(id: string, text: string, checked: boolean, children: unknown[] = []) {
  return {
    id,
    type: 'to_do',
    has_children: children.length > 0,
    to_do: {
      rich_text: [{ plain_text: text }],
      checked,
    },
    _children: children, // test helper, not Notion API
  };
}

// Helper: build a paragraph block (sub-bullet)
function makeParagraphBlock(text: string) {
  return {
    id: `para-${Math.random()}`,
    type: 'paragraph',
    paragraph: {
      rich_text: [{ plain_text: text }],
    },
  };
}

// Mock blocksChildrenList that returns different results for page vs. block children calls
function makeBlocksChildrenListFn(
  pageBlocks: unknown[],
  childrenByBlockId: Record<string, unknown[]> = {},
) {
  return vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
    if (childrenByBlockId[block_id]) {
      return { results: childrenByBlockId[block_id] };
    }
    return { results: pageBlocks };
  });
}

describe('NotionImplementationFeedbackPage — create', () => {
  it('creates a page with data_source_id parent (not database_id or page_id)', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ summary: 'the summary', testing_instructions: 'run npm test' }));

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds-testing-guides-id' });
    expect(createCall.parent.page_id).toBeUndefined();
    expect(createCall.parent.database_id).toBeUndefined();
  });

  it('returns the page_id', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.create(makeReviewInput());

    expect(result).toEqual({ id: 'new-page-id', url: 'https://notion.so/newpageid', label: 'View testing guide' });
  });

  it('sets Title to "Testing guide: {spec_title}"', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput());

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Title'].title[0].text.content).toBe('Testing guide: Setup wizard');
  });

  it('sets Spec relation to spec_page_id', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ artifact_ref: 'spec-page-abc' }));

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Spec'].relation).toEqual([{ id: 'spec-page-abc' }]);
  });

  it('sets Status to "Not started"', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput());

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Status'].status.name).toBe('Not started');
  });

  it('includes spec link bookmark in page children', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ artifact_url: 'https://notion.so/spec-url' }));

    const createCall = pagesCreate.mock.calls[0][0];
    const bookmarkBlock = createCall.children.find(
      (b: { type: string }) => b.type === 'bookmark',
    );
    expect(bookmarkBlock?.bookmark?.url).toBe('https://notion.so/spec-url');
  });

  it('spec_title with special characters passes through verbatim', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ title: 'API: v2/beta' }));

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Title'].title[0].text.content).toBe('Testing guide: API: v2/beta');
  });

  it('throws when pages.create rejects', async () => {
    const pagesCreate = vi.fn().mockRejectedValue(new Error('Notion error'));
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await expect(
      page.create(makeReviewInput()),
    ).rejects.toThrow('Notion error');
  });

  it('emits notion_testing_guide.created log event', async () => {
    const records: Record<string, unknown>[] = [];
    const logDest = {
      write(msg: string) {
        try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', {
      logDestination: logDest as unknown as import('pino').DestinationStream,
    });

    await page.create(makeReviewInput());

    expect(records.find(r => r['event'] === 'notion_testing_guide.created')).toBeDefined();
  });

  it('writes Workspace heading before Summary heading', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput());

    const children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> } }> =
      pagesCreate.mock.calls[0][0].children;
    const headingTexts = children
      .filter(b => b.type === 'heading_2')
      .map(b => b.heading_2!.rich_text[0].text.content);
    const workspaceIdx = headingTexts.indexOf('Workspace');
    const summaryIdx = headingTexts.indexOf('Summary');
    expect(workspaceIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThan(workspaceIdx);
  });

  it('writes workspace_path and branch in that order after Workspace heading', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({
      workspace_path: '/my/workspace',
      branch: 'spec/abc123',
    }));

    const children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> }; paragraph?: { rich_text: Array<{ text: { content: string } }> } }> =
      pagesCreate.mock.calls[0][0].children;
    const workspaceHeadingIdx = children.findIndex(
      b => b.type === 'heading_2' && b.heading_2!.rich_text[0].text.content === 'Workspace',
    );
    const workspaceParagraph = children[workspaceHeadingIdx + 1];
    const branchParagraph = children[workspaceHeadingIdx + 2];
    expect(workspaceParagraph?.paragraph?.rich_text[0].text.content).toContain('/my/workspace');
    expect(branchParagraph?.paragraph?.rich_text[0].text.content).toContain('spec/abc123');
  });

  it('renders Changes and Confirm as bulleted_list_item blocks from review_summary', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({
      review_summary: {
        changes: ['Added config loader', 'Wired provider'],
        confirm: ['Provider is used', 'Old runs work'],
      },
    }));

    const children: Array<{ type: string; bulleted_list_item?: { rich_text: Array<{ text: { content: string } }> } }> =
      pagesCreate.mock.calls[0][0].children;
    const bulletTexts = children
      .filter(b => b.type === 'bulleted_list_item')
      .map(b => b.bulleted_list_item!.rich_text[0].text.content);
    expect(bulletTexts).toContain('Added config loader');
    expect(bulletTexts).toContain('Wired provider');
    expect(bulletTexts).toContain('Provider is used');
    expect(bulletTexts).toContain('Old runs work');
  });

  it('renders testing_steps as Notion to_do blocks', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({
      testing_steps: ['cd /workspace', 'npm install', 'npm test'],
    }));

    const children: Array<{ type: string; to_do?: { rich_text: Array<{ text: { content: string } }>; checked: boolean } }> =
      pagesCreate.mock.calls[0][0].children;
    const allTodos = children.filter(b => b.type === 'to_do');
    const todoTexts = allTodos.map(b => b.to_do!.rich_text[0].text.content);
    expect(todoTexts).toContain('cd /workspace');
    expect(todoTexts).toContain('npm install');
    expect(todoTexts).toContain('npm test');
    allTodos.filter(b => ['cd /workspace', 'npm install', 'npm test'].includes(b.to_do!.rich_text[0].text.content))
      .forEach(b => expect(b.to_do!.checked).toBe(false));
  });

  it('renders an Additional steps heading with a placeholder to_do item', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput());

    const children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> }; to_do?: { rich_text: Array<{ text: { content: string } }>; checked: boolean } }> =
      pagesCreate.mock.calls[0][0].children;
    const additionalStepsIdx = children.findIndex(
      b => b.type === 'heading_2' && b.heading_2!.rich_text[0].text.content === 'Additional steps',
    );
    expect(additionalStepsIdx).toBeGreaterThanOrEqual(0);
    const placeholder = children[additionalStepsIdx + 1];
    expect(placeholder?.type).toBe('to_do');
    expect(placeholder?.to_do!.rich_text[0].text.content).toBe('Add any extra testing steps here.');
    expect(placeholder?.to_do!.checked).toBe(false);
  });

  it('returns label "View testing guide" as part of the published review result', async () => {
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });
    const result = await page.create(makeReviewInput());
    expect(result.label).toBe('View testing guide');
  });

  it('falls back to legacy summary as single Changes bullet and fixed Confirm bullet', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({
      review_summary: undefined,
      summary: 'Legacy summary text',
      testing_steps: undefined,
      testing_instructions: 'Step one\nStep two',
    }));

    const children: Array<{ type: string; bulleted_list_item?: { rich_text: Array<{ text: { content: string } }> }; to_do?: { rich_text: Array<{ text: { content: string } }>; checked: boolean } }> =
      pagesCreate.mock.calls[0][0].children;
    const bulletTexts = children
      .filter(b => b.type === 'bulleted_list_item')
      .map(b => b.bulleted_list_item!.rich_text[0].text.content);
    expect(bulletTexts).toContain('Legacy summary text');
    expect(bulletTexts).toContain('Confirm the implemented behavior matches the approved spec.');

    const todoTexts = children
      .filter(b => b.type === 'to_do')
      .map(b => b.to_do!.rich_text[0].text.content);
    expect(todoTexts).toContain('Step one');
    expect(todoTexts).toContain('Step two');
  });
});

describe('NotionImplementationFeedbackPage — readFeedback', () => {
  it('returns empty array when page has no blocks', async () => {
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toEqual([]);
  });

  it('returns unchecked to-do item with resolved: false', async () => {
    const feedbackHeading = { id: 'h-feedback', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } };
    const todoBlock = makeTodoBlock('block-1', 'Fix the bug', false);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([feedbackHeading, todoBlock]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('block-1');
    expect(result[0].text).toBe('Fix the bug');
    expect(result[0].resolved).toBe(false);
  });

  it('returns checked to-do item with resolved: true', async () => {
    const feedbackHeading = { id: 'h-feedback', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } };
    const todoBlock = makeTodoBlock('block-2', 'Already done', true);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([feedbackHeading, todoBlock]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result[0].resolved).toBe(true);
  });

  it('returns sub-bullets in conversation array', async () => {
    const para1 = makeParagraphBlock('Comment A');
    const para2 = makeParagraphBlock('Comment B');
    const todoBlock = makeTodoBlock('block-3', 'The item', false, [para1, para2]);
    const feedbackHeading = { id: 'h-feedback', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } };

    const blocksChildrenList = vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === 'page-id') return { results: [feedbackHeading, todoBlock] };
      if (block_id === 'block-3') return { results: [para1, para2] };
      return { results: [] };
    });

    const client = makeNotionClient({ blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result[0].conversation).toEqual(['Comment A', 'Comment B']);
  });

  it('returns multiple to-do items in document order', async () => {
    const feedbackHeading = { id: 'h-feedback', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } };
    const block1 = makeTodoBlock('b1', 'First', false);
    const block2 = makeTodoBlock('b2', 'Second', true);
    const block3 = makeTodoBlock('b3', 'Third', false);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([feedbackHeading, block1, block2, block3]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('First');
    expect(result[1].text).toBe('Second');
    expect(result[2].text).toBe('Third');
  });

  it('ignores non-to-do blocks', async () => {
    const heading = { id: 'h1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } };
    const paragraph = { id: 'p1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Some text' }] } };
    const todo = makeTodoBlock('t1', 'Actual feedback', false);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([heading, paragraph, todo]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Actual feedback');
  });

  it('ignores to_do blocks under Testing instructions heading', async () => {
    const blocks = [
      { id: 'h-testing', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Testing instructions' }] } },
      makeTodoBlock('t-testing-1', 'npm install', false),
      makeTodoBlock('t-testing-2', 'npm test', false),
      { id: 'h-feedback', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } },
      makeTodoBlock('f-1', 'Real feedback item', false),
    ];
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn(blocks),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f-1');
    expect(result[0].text).toBe('Real feedback item');
  });

  it('ignores to_do blocks under Additional steps heading', async () => {
    const blocks = [
      { id: 'h-add', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Additional steps' }] } },
      makeTodoBlock('a-1', 'Reviewer step', false),
      { id: 'h-feedback', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } },
      makeTodoBlock('f-1', 'Real feedback', false),
    ];
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn(blocks),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Real feedback');
  });

  it('returns all to_do blocks in Feedback section with correct resolved values', async () => {
    const blocks = [
      { id: 'h-testing', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Testing instructions' }] } },
      makeTodoBlock('t-1', 'Testing step', true),
      { id: 'h-feedback', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } },
      makeTodoBlock('f-1', 'Unchecked feedback', false),
      makeTodoBlock('f-2', 'Checked feedback', true),
    ];
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn(blocks),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'f-1', resolved: false });
    expect(result[1]).toMatchObject({ id: 'f-2', resolved: true });
  });
});

describe('NotionImplementationFeedbackPage — update', () => {
  it('replaces summary when provided', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '# Implementation',
      '',
      '## Summary',
      '',
      'Old summary.',
      '',
      '## Testing instructions',
      '',
      'Old instructions.',
      '',
      '## Feedback',
      '',
    ].join('\n'));
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', { summary: 'New summary text.' });

    expect(pagesUpdateMarkdown).toHaveBeenCalledOnce();
    const updatedMarkdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updatedMarkdown).toContain('New summary text.');
    expect(updatedMarkdown).not.toContain('Old summary.');
  });

  it('leaves summary unchanged when not provided', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '# Implementation',
      '',
      '## Summary',
      '',
      'Existing summary.',
      '',
    ].join('\n'));
    const blocksChildrenList = vi.fn().mockResolvedValue({ results: [] });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      resolved_items: [],
    });

    if (pagesUpdateMarkdown.mock.calls.length > 0) {
      const updatedMarkdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
      expect(updatedMarkdown).toContain('Existing summary.');
    }
  });

  it('marks resolved items as checked with resolution comment sub-bullet', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '# Implementation',
      '',
      '## Summary',
      '',
      'Summary.',
      '',
      '## Testing instructions',
      '',
      'Test.',
      '',
      '## Feedback',
      '',
      '- [ ] Fix the bug',
      '',
    ].join('\n'));
    const blocksChildrenList = vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === 'page-id') {
        return {
          results: [makeTodoBlock('todo-1', 'Fix the bug', false)],
        };
      }
      return { results: [] };
    });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      resolved_items: [{ id: 'todo-1', resolution_comment: 'Fixed the config validator' }],
    });

    expect(pagesUpdateMarkdown).toHaveBeenCalledOnce();
    const updatedMarkdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updatedMarkdown).toContain('[x]');
    expect(updatedMarkdown).toContain('Fixed the config validator');
    expect(updatedMarkdown).toContain('✓');
  });

  it('throws when update API rejects', async () => {
    const pagesGetMarkdown = vi.fn().mockResolvedValue('# Page\n\n## Summary\n\nText.\n');
    const pagesUpdateMarkdown = vi.fn().mockRejectedValue(new Error('API error'));
    const blocksChildrenList = vi.fn().mockResolvedValue({ results: [] });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await expect(page.update('page-id', { summary: 'New summary' })).rejects.toThrow();
  });

  it('replaces Summary with structured Changes and Confirm when review_summary is provided', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '## Workspace',
      '',
      'Workspace: `/ws`',
      '',
      '## Summary',
      '',
      '### Changes',
      '',
      '- Old change',
      '',
      '### Confirm',
      '',
      '- Old confirm',
      '',
      '## Testing instructions',
      '',
      '- [ ] npm test',
      '',
      '## Feedback',
      '',
    ].join('\n'));
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      review_summary: {
        changes: ['New change A', 'New change B'],
        confirm: ['Confirm X', 'Confirm Y'],
      },
    });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updated).toContain('New change A');
    expect(updated).toContain('New change B');
    expect(updated).toContain('Confirm X');
    expect(updated).toContain('Confirm Y');
    expect(updated).not.toContain('Old change');
    expect(updated).not.toContain('Old confirm');
    expect(updated).toContain('## Testing instructions');
    expect(updated).toContain('npm test');
    expect(updated).toContain('## Feedback');
  });

  it('appends new testing steps without removing or unchecking existing items', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '## Testing instructions',
      '',
      '- [x] cd /workspace',
      '- [ ] npm install',
      '',
      '## Additional steps',
      '',
      '- [ ] Add any extra testing steps here.',
      '',
      '## Feedback',
      '',
    ].join('\n'));
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      testing_steps: ['npm test', 'Check the logs'],
    });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updated).toContain('- [x] cd /workspace');
    expect(updated).toContain('- [ ] npm install');
    expect(updated).toContain('npm test');
    expect(updated).toContain('Check the logs');
    expect(updated).toContain('## Additional steps');
    expect(updated).toContain('Add any extra testing steps here.');
    expect(updated).toContain('## Feedback');
  });

  it('does not append a testing step whose text matches an existing step (case-insensitive)', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '## Testing instructions',
      '',
      '- [ ] npm install',
      '- [x] npm test',
      '',
      '## Feedback',
      '',
    ].join('\n'));
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      testing_steps: ['npm install', 'NPM TEST', 'New unique step'],
    });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/npm install/gi) ?? []).length).toBe(1);
    expect((updated.match(/npm test/gi) ?? []).length).toBe(1);
    expect(updated).toContain('New unique step');
  });

  it('does not modify Additional steps section when appending testing steps', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '## Testing instructions',
      '',
      '- [ ] npm test',
      '',
      '## Additional steps',
      '',
      '- [ ] My custom step',
      '',
      '## Feedback',
      '',
    ].join('\n'));
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      testing_steps: ['New step'],
    });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updated).toContain('## Additional steps');
    expect(updated).toContain('My custom step');
    const newStepIdx = updated.indexOf('New step');
    const additionalStepsIdx = updated.indexOf('## Additional steps');
    expect(newStepIdx).toBeLessThan(additionalStepsIdx);
  });

  it('resolves feedback items only within the Feedback section (not testing instructions)', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '## Testing instructions',
      '',
      '- [ ] Run the feature',
      '',
      '## Feedback',
      '',
      '- [ ] Run the feature',
      '',
    ].join('\n'));
    const blocksChildrenList = vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === 'page-id') {
        return {
          results: [
            makeTodoBlock('feedback-todo-id', 'Run the feature', false),
          ],
        };
      }
      return { results: [] };
    });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      resolved_items: [{ id: 'feedback-todo-id', resolution_comment: 'Fixed' }],
    });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    const checkedCount = (updated.match(/- \[x\] Run the feature/g) ?? []).length;
    const uncheckedCount = (updated.match(/- \[ \] Run the feature/g) ?? []).length;
    expect(checkedCount).toBe(1);
    expect(uncheckedCount).toBe(1);
  });

  it('does not duplicate resolution comment when called twice with same item', async () => {
    const pageMarkdownAfterFirst = [
      '## Feedback',
      '',
      '- [x] Fix the bug',
      '  - ✓ Fixed via config',
      '',
    ].join('\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue(pageMarkdownAfterFirst);
    const blocksChildrenList = vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === 'page-id') {
        return { results: [makeTodoBlock('todo-1', 'Fix the bug', true)] };
      }
      return { results: [] };
    });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.update('page-id', {
      resolved_items: [{ id: 'todo-1', resolution_comment: 'Fixed via config' }],
    });

    if (pagesUpdateMarkdown.mock.calls.length > 0) {
      const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
      expect((updated.match(/✓ Fixed via config/g) ?? []).length).toBe(1);
    }
  });

  it('emits implementation.feedback_resolved log after resolving items', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { try { logs.push(JSON.parse(line)); } catch { /* ignore */ } } };
    const pagesGetMarkdown = vi.fn().mockResolvedValue('## Feedback\n\n- [ ] Fix it\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const blocksChildrenList = vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === 'page-id') {
        return { results: [makeTodoBlock('t1', 'Fix it', false)] };
      }
      return { results: [] };
    });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

    await page.update('page-id', { resolved_items: [{ id: 't1', resolution_comment: 'Done' }] });

    expect((logs as Array<Record<string, unknown>>).find(l => l['event'] === 'implementation.feedback_resolved')).toBeDefined();
  });

  it('emits implementation.testing_steps_appended log when new steps are added', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { try { logs.push(JSON.parse(line)); } catch { /* ignore */ } } };
    const pagesGetMarkdown = vi.fn().mockResolvedValue('## Testing instructions\n\n- [ ] Step 1\n\n## Feedback\n\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({
      pagesGetMarkdown,
      pagesUpdateMarkdown,
      blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

    await page.update('page-id', { testing_steps: ['Step 2', 'Step 1'] }); // Step 1 is duplicate

    const appended = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'implementation.testing_steps_appended');
    expect(appended).toBeDefined();
    expect(appended?.['appended_count']).toBe(1);
    expect(appended?.['skipped_count']).toBe(1);
  });
});

describe('NotionImplementationFeedbackPage — logging', () => {
  it('emits notion_testing_guide.created on successful create', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

    await page.create(makeReviewInput({ artifact_url: 'https://url', title: 'Test title', summary: 'Summary', testing_instructions: 'Test' }));

    const created = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'notion_testing_guide.created');
    expect(created).toBeDefined();
  });

  it('emits implementation.feedback_read on successful readFeedback', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

    await page.readFeedback('page-id');

    const read = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'implementation.feedback_read');
    expect(read).toBeDefined();
  });

  it('emits implementation.feedback_updated on successful update', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const pagesGetMarkdown = vi.fn().mockResolvedValue('# Page\n\n## Summary\n\nText.\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const blocksChildrenList = vi.fn().mockResolvedValue({ results: [] });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

    await page.update('page-id', { summary: 'New summary' });

    const updated = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'implementation.feedback_updated');
    expect(updated).toBeDefined();
  });
});

describe('NotionImplementationFeedbackPage — updateStatus', () => {
  it('calls pages.updateProperties with Status payload', async () => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.updateStatus!('page-tg-id', 'in_progress');

    expect(pagesUpdateProperties).toHaveBeenCalledWith('page-tg-id', {
      Status: { status: { name: 'In progress' } },
    });
  });

  it.each([
    ['not_started', 'Not started'],
    ['in_progress', 'In progress'],
    ['waiting_on_feedback', 'Waiting on feedback'],
    ['approved', 'Approved'],
  ] as const)('maps status "%s" to Notion label "%s"', async (status, notionLabel) => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.updateStatus!('page-id', status);

    expect(pagesUpdateProperties.mock.calls[0][1]['Status'].status.name).toBe(notionLabel);
  });

  it('throws if pages.updateProperties rejects', async () => {
    const pagesUpdateProperties = vi.fn().mockRejectedValue(new Error('API error'));
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await expect(page.updateStatus!('page-id', 'approved')).rejects.toThrow('API error');
  });

  it('logs notion_testing_guide.status_updated event', async () => {
    const records: Record<string, unknown>[] = [];
    const logDest = {
      write(msg: string) {
        try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', {
      logDestination: logDest as unknown as import('pino').DestinationStream,
    });

    await page.updateStatus!('page-id', 'approved');

    expect(records.find(r => r['event'] === 'notion_testing_guide.status_updated')).toBeDefined();
  });
});

describe('NotionImplementationFeedbackPage — setPRLink', () => {
  it('calls pages.updateProperties with PR link payload', async () => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.setPRLink!('page-tg-id', 'https://example.test/org/repo/pull/42');

    expect(pagesUpdateProperties).toHaveBeenCalledWith('page-tg-id', {
      'PR link': { url: 'https://example.test/org/repo/pull/42' },
    });
  });

  it('passes pr_url through verbatim', async () => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    const url = 'https://example.test/org/repo/pull/99?special=true&x=1';
    await page.setPRLink!('page-id', url);

    expect(pagesUpdateProperties.mock.calls[0][1]['PR link'].url).toBe(url);
  });

  it('throws if pages.updateProperties rejects', async () => {
    const pagesUpdateProperties = vi.fn().mockRejectedValue(new Error('API error'));
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await expect(page.setPRLink!('page-id', 'https://example.com/pr')).rejects.toThrow('API error');
  });

  it('logs notion_testing_guide.pr_link_set event', async () => {
    const records: Record<string, unknown>[] = [];
    const logDest = {
      write(msg: string) {
        try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', {
      logDestination: logDest as unknown as import('pino').DestinationStream,
    });

    await page.setPRLink!('page-id', 'https://example.test/org/repo/pull/1');

    expect(records.find(r => r['event'] === 'notion_testing_guide.pr_link_set')).toBeDefined();
  });
});

describe('Human review section naming', () => {
  it('new testing guides use "Human review" heading instead of "Feedback"', async () => {
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });
    await page.create(makeReviewInput());
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> } }> };
    const headings = createCall.children.filter(b => b.type === 'heading_2').map(b => b.heading_2!.rich_text[0].text.content);
    expect(headings).toContain('Human review');
    expect(headings).not.toContain('Feedback');
  });

  it('readFeedback recognizes "Human review" heading', async () => {
    const client = makeNotionClient({
      blocksChildrenList: vi.fn().mockResolvedValue({
        results: [
          { id: 'h1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Human review' }] } },
          { id: 'todo-1', type: 'to_do', has_children: false, to_do: { rich_text: [{ plain_text: 'Test this.' }], checked: false } },
        ],
      }),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });
    const items = await page.readFeedback('page-id');
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Test this.');
  });
});

describe('AI review section', () => {
  it('newly created testing guide includes AI review section when review_exchanges provided', async () => {
    const exchange = makeReviewExchange();
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });
    await page.create(makeReviewInput({ review_exchanges: [exchange] }));
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> } }> };
    const headings = createCall.children.filter(b => b.type === 'heading_2').map(b => b.heading_2!.rich_text[0].text.content);
    expect(headings).toContain('AI review');
    // AI review appears after Human review
    const aiIdx = headings.indexOf('AI review');
    const humanIdx = headings.indexOf('Human review');
    expect(aiIdx).toBeGreaterThan(humanIdx);
  });

  it('update replaces only AI review section, leaving Human review content unchanged', async () => {
    const existingMarkdown = `## Summary\n\nOld summary.\n\n## Testing instructions\n\n- [ ] Run tests.\n\n## Additional steps\n\n- [ ] Check.\n\n## Human review\n\n- [ ] Some feedback.\n\n## AI review\n\n### Initial review\n\nOld review content.`;
    const client = makeNotionClient({
      pagesGetMarkdown: vi.fn().mockResolvedValue(existingMarkdown),
    });
    const exchange = makeReviewExchange({
      review_status: 'addressed',
      review_summary: 'Found 1 issue.',
      findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test file.' }],
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });
    await page.update('page-id', { review_exchanges: [exchange] });
    const updateCall = (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mock.calls[0];
    const newMarkdown = updateCall[1].replace_content.new_str as string;
    expect(newMarkdown).toContain('## Human review');
    expect(newMarkdown).toContain('Some feedback.');
    expect(newMarkdown).toContain('INIT-1');
    expect(newMarkdown).toContain('Added test file.');
  });

  it('renders no-findings exchange as "No blocking or informational findings."', async () => {
    const exchange = makeReviewExchange({ review_status: 'no_findings' });
    const client = makeNotionClient({ pagesGetMarkdown: vi.fn().mockResolvedValue('## Human review\n\n') });
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });
    await page.update('page-id', { review_exchanges: [exchange] });
    const newMarkdown = (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mock.calls[0][1].replace_content.new_str as string;
    expect(newMarkdown).toContain('No blocking or informational findings.');
  });

  it('redacts API key values (sk-...) before rendering', async () => {
    const exchange = makeReviewExchange({
      review_status: 'addressed',
      review_summary: 'sk-abcdef1234567890 was found.',
      findings: [{ id: 'INIT-1', severity: 'warning', category: 'security', finding: 'Log includes sk-abcdef1234567890.' }],
      responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Removed sk-abcdef1234567890 from log.' }],
    });
    const client = makeNotionClient({ pagesGetMarkdown: vi.fn().mockResolvedValue('## Human review\n\n') });
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });
    await page.update('page-id', { review_exchanges: [exchange] });
    const newMarkdown = (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mock.calls[0][1].replace_content.new_str as string;
    expect(newMarkdown).not.toContain('sk-abcdef1234567890');
    expect(newMarkdown).toContain('[REDACTED]');
  });

  it('appends AI review at end of page when AI review section is absent', async () => {
    const existingMarkdown = `## Summary\n\nOld summary.\n\n## Human review\n\n- [ ] feedback.\n`;
    const client = makeNotionClient({ pagesGetMarkdown: vi.fn().mockResolvedValue(existingMarkdown) });
    const exchange = makeReviewExchange({ phase: 'final' });
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });
    await page.update('page-id', { review_exchanges: [exchange] });
    const newMarkdown = (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mock.calls[0][1].replace_content.new_str as string;
    expect(newMarkdown).toContain('## AI review');
    expect(newMarkdown.indexOf('## AI review')).toBeGreaterThan(newMarkdown.indexOf('## Summary'));
  });
});

describe('Gate exchange rendering', () => {
  it('renders gate_exchanges grouped by gate and round when creating the testing guide', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    const gate_exchanges: GateReviewExchange[] = [
      {
        id: 'gate-1',
        gate: 'initial',
        round: 1,
        created_at: '2026-06-07T00:00:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk', model: 'gpt-5.5' },
        review_status: 'addressed',
        review_summary: 'One blocker found.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing regression test.' }],
        responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added invalid provider config coverage.' }],
        converged: false,
        requires_human_retest: false,
      },
      {
        id: 'gate-2',
        gate: 'initial',
        round: 2,
        created_at: '2026-06-07T00:01:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk', model: 'gpt-5.5' },
        review_status: 'converged',
        review_summary: 'No blockers remain.',
        findings: [],
        responses: [],
        converged: true,
        requires_human_retest: false,
      },
    ];

    await page.create(makeReviewInput({ gate_exchanges }));

    const createCall = pagesCreate.mock.calls[0][0] as {
      children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> }; paragraph?: { rich_text: Array<{ text: { content: string } }> } }>;
    };

    // Collect all text content from the created blocks
    const allTexts = createCall.children.flatMap(b => {
      if (b.type === 'heading_2') return [b.heading_2!.rich_text[0].text.content];
      if (b.type === 'paragraph') return [b.paragraph!.rich_text[0].text.content];
      return [];
    });

    expect(allTexts).toContain('AI review');
    const combined = allTexts.join('\n');
    expect(combined).toContain('Initial review');
    expect(combined).toContain('Convergence: converged');
    expect(combined).toContain('Rounds: 2');
    expect(combined).toContain('[INIT-1] Missing regression test.');
    expect(combined).toContain('Fixed — Added invalid provider config coverage.');
    expect(combined).toContain('Round 2 — converged');
  });

  it('renders non-converged open findings from gate_exchanges when updating the testing guide', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue('## Human review\n\n');
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    const gate_exchanges: GateReviewExchange[] = [{
      id: 'gate-3',
      gate: 'final',
      round: 2,
      created_at: '2026-06-07T00:02:00.000Z',
      proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
      critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk' },
      review_status: 'non_converged',
      review_summary: 'Security blocker still open.',
      findings: [{ id: 'FINAL-2', severity: 'blocker', category: 'security', finding: 'Token output can appear in logs.' }],
      responses: [{ id: 'FINAL-2', disposition: 'declined', response: 'Only config names are logged.' }],
      converged: false,
      non_convergence_reason: 'max_rounds',
      requires_human_retest: false,
    }];

    await page.update('page-id', { gate_exchanges });

    const markdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(markdown).toContain('### Final review');
    expect(markdown).toContain('Convergence: failed (`max_rounds`)');
    expect(markdown).toContain('#### Open findings');
    expect(markdown).toContain('- [ ] [FINAL-2] Token output can appear in logs.');
    expect(markdown).toContain('Last proposer response: Declined — Only config names are logged.');
  });

  it('redacts secret-like text in gate exchange finding and response text', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue('## Human review\n\n');
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    const gate_exchanges: GateReviewExchange[] = [
      {
        id: 'gate-secret-1',
        gate: 'initial',
        round: 1,
        created_at: '2026-06-07T00:00:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk' },
        review_status: 'addressed',
        review_summary: 'Secret in finding.',
        findings: [{ id: 'INIT-S1', severity: 'blocker', category: 'security', finding: 'Token sk-abc12345678 was logged.' }],
        responses: [{ id: 'INIT-S1', disposition: 'fixed', response: 'Removed key api_key=supersecretvalue from output.' }],
        converged: false,
        requires_human_retest: false,
      },
      {
        id: 'gate-secret-2',
        gate: 'initial',
        round: 2,
        created_at: '2026-06-07T00:01:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk' },
        review_status: 'converged',
        review_summary: 'Resolved.',
        findings: [],
        responses: [],
        converged: true,
        requires_human_retest: false,
      },
    ];

    await page.update('page-id', { gate_exchanges });

    const markdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(markdown).not.toContain('sk-abc12345678');
    expect(markdown).not.toContain('supersecretvalue');
    expect(markdown).toContain('[REDACTED]');
  });

  it('redacts secret-like text in non-converged open finding and last proposer response', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue('## Human review\n\n');
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    const gate_exchanges: GateReviewExchange[] = [
      {
        id: 'gate-nc-1',
        gate: 'final',
        round: 1,
        created_at: '2026-06-07T00:00:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk' },
        review_status: 'addressed',
        review_summary: 'Blocker found.',
        findings: [{ id: 'FINAL-S1', severity: 'blocker', category: 'security', finding: 'Key sk-secretvalue123 exposed.' }],
        responses: [{ id: 'FINAL-S1', disposition: 'declined', response: 'That token api_key=plainvalue is not sensitive.' }],
        converged: false,
        requires_human_retest: false,
      },
      {
        id: 'gate-nc-2',
        gate: 'final',
        round: 2,
        created_at: '2026-06-07T00:01:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk' },
        review_status: 'non_converged',
        review_summary: 'Still blocked.',
        findings: [{ id: 'FINAL-S1', severity: 'blocker', category: 'security', finding: 'Key sk-secretvalue123 still exposed.' }],
        responses: [],
        converged: false,
        non_convergence_reason: 'max_rounds',
        requires_human_retest: false,
      },
    ];

    await page.update('page-id', { gate_exchanges });

    const markdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(markdown).not.toContain('sk-secretvalue123');
    expect(markdown).not.toContain('plainvalue');
    expect(markdown).toContain('[REDACTED]');
    // The last proposer response from round 1 should appear (via lookback)
    expect(markdown).toContain('Last proposer response: Declined');
  });

  it('shows last proposer response from prior round for non-converged open findings when terminal exchange has empty responses', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue('## Human review\n\n');
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    // Round 1 addressed exchange holds the proposer's last response.
    // Round 2 is the terminal non_converged exchange with responses: [] (matches actual coordinator output).
    const gate_exchanges: GateReviewExchange[] = [
      {
        id: 'gate-lb-1',
        gate: 'initial',
        round: 1,
        created_at: '2026-06-07T00:00:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk' },
        review_status: 'addressed',
        review_summary: 'Blocker.',
        findings: [{ id: 'INIT-LB1', severity: 'blocker', category: 'correctness', finding: 'Missing coverage.' }],
        responses: [{ id: 'INIT-LB1', disposition: 'declined', response: 'Not applicable per spec.' }],
        converged: false,
        requires_human_retest: false,
      },
      {
        id: 'gate-lb-2',
        gate: 'initial',
        round: 2,
        created_at: '2026-06-07T00:01:00.000Z',
        proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
        critic_profile: { profile: 'critic-agent', provider: 'openai_agent_sdk' },
        review_status: 'non_converged',
        review_summary: 'Still blocked.',
        findings: [{ id: 'INIT-LB1', severity: 'blocker', category: 'correctness', finding: 'Missing coverage.' }],
        responses: [],
        converged: false,
        non_convergence_reason: 'max_rounds',
        requires_human_retest: false,
      },
    ];

    await page.update('page-id', { gate_exchanges });

    const markdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(markdown).toContain('#### Open findings');
    // The proposer response from round 1 should appear in the open findings section
    expect(markdown).toContain('Last proposer response: Declined — Not applicable per spec.');
  });

  it('continues to render legacy review_exchanges when gate_exchanges are absent', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });
    const exchange = makeReviewExchange({ review_status: 'addressed' });

    await page.create(makeReviewInput({ review_exchanges: [exchange] }));

    const createCall = pagesCreate.mock.calls[0][0] as {
      children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> }; paragraph?: { rich_text: Array<{ text: { content: string } }> } }>;
    };
    const allTexts = createCall.children.flatMap(b => {
      if (b.type === 'heading_2') return [b.heading_2!.rich_text[0].text.content];
      if (b.type === 'paragraph') return [b.paragraph!.rich_text[0].text.content];
      return [];
    });

    // Legacy rendering produces "Review status: addressed" in the blocks
    expect(allTexts.join('\n')).toContain('Review status: addressed');
  });
});

describe('normalizeStep (via update deduplication behavior)', () => {
  // We test normalizeStep indirectly by calling update() with variants that should be treated as duplicates

  function makeUpdateClient(existingSteps: string[]) {
    const existingLines = existingSteps.map(s => `- [ ] ${s}`).join('\n');
    const markdown = [
      '## Testing instructions',
      '',
      existingLines,
      '',
      '## Additional steps',
      '',
      '- [ ] Add any extra testing steps here.',
      '',
      '## Feedback',
      '',
    ].join('\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue(markdown);
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    return { client, pagesUpdateMarkdown };
  }

  it('treats "cd /workspace/" as duplicate of existing "cd /workspace" (trailing slash)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm install']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace/', 'npm install'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/cd \/workspace/g) ?? []).length).toBe(1);
  });

  it('treats "`cd /workspace`" as duplicate of existing "cd /workspace" (backticks)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['`cd /workspace`'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/cd \/workspace/g) ?? []).length).toBe(1);
  });

  it('treats " `cd /workspace` " as duplicate of existing "cd /workspace" (whitespace around backticks)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: [' `cd /workspace` '] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/cd \/workspace/g) ?? []).length).toBe(1);
  });

  it('treats "npm test " as duplicate of existing "npm test" (trailing whitespace)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['npm test']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['npm test '] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/npm test/g) ?? []).length).toBe(1);
  });

  it('skips a new cd step when a different cd step already exists (baseline singleton)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace/project', 'npm install']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    // Agent returns a slightly different path (e.g., trailing slash variant)
    await page.update('page-id', { testing_steps: ['cd /workspace/project/', 'npm install', 'npm test'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // cd step should appear only once
    expect((updated.match(/cd\s+\/workspace/g) ?? []).length).toBe(1);
    // npm install should appear only once
    expect((updated.match(/npm install/g) ?? []).length).toBe(1);
    // npm test is new, should be appended
    expect(updated).toContain('npm test');
  });

  it('skips npm install when an equivalent npm ci step already exists (same baseline category)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm ci']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace', 'npm install', 'npm test'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // Neither npm install nor duplicate npm ci should appear
    const installCount = (updated.match(/npm\s+(install|ci)/g) ?? []).length;
    expect(installCount).toBe(1);
    // npm test is new
    expect(updated).toContain('npm test');
  });

  it('feedback update with no genuinely new steps leaves the Testing instructions section unchanged', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm install', 'npm test']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace', 'npm install', 'npm test'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/cd \/workspace/g) ?? []).length).toBe(1);
    expect((updated.match(/npm install/g) ?? []).length).toBe(1);
    expect((updated.match(/npm test/g) ?? []).length).toBe(1);
  });

  it('feedback update with only baseline boilerplate appends nothing new', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm install']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace/', 'npm install'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // The Testing instructions section should have exactly the original two steps
    const todoMatches = updated.match(/^- \[[ x]\] /gm) ?? [];
    // 2 testing instruction todos + 1 Additional steps placeholder
    expect(todoMatches.length).toBe(3);
  });

  it('appends a file-specific vitest command even when a different file-specific vitest command already exists', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient([
      'cd /workspace',
      'npx vitest run tests/foo.test.ts',
    ]);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['npx vitest run tests/bar.test.ts'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updated).toContain('npx vitest run tests/bar.test.ts');
    // The original file-specific command is still present
    expect(updated).toContain('npx vitest run tests/foo.test.ts');
  });

  it('treats generic "npx vitest run" as a singleton (no file-path args)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['npx vitest run']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['npx vitest'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // Both are generic test_command singletons — new one should be suppressed
    const vitestMatches = updated.match(/npx vitest/g) ?? [];
    expect(vitestMatches.length).toBe(1);
  });

  it('appends one new round-specific test step while preserving existing checked to-dos', async () => {
    const markdown = [
      '## Testing instructions',
      '',
      '- [x] cd /workspace',
      '- [x] npm install',
      '- [ ] npm test',
      '',
      '## Additional steps',
      '',
      '- [ ] Add any extra testing steps here.',
      '',
      '## Feedback',
      '',
    ].join('\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue(markdown);
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', {
      testing_steps: ['cd /workspace', 'npm install', 'npm test', 'Open http://localhost:3000 and verify the widget appears'],
    });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // Checked steps preserved
    expect(updated).toContain('- [x] cd /workspace');
    expect(updated).toContain('- [x] npm install');
    // npm test already present, not duplicated
    expect((updated.match(/npm test/g) ?? []).length).toBe(1);
    // New step appended
    expect(updated).toContain('Open http://localhost:3000 and verify the widget appears');
    // New step is before Additional steps
    const newStepIdx = updated.indexOf('Open http://localhost:3000');
    const additionalIdx = updated.indexOf('## Additional steps');
    expect(newStepIdx).toBeLessThan(additionalIdx);
  });
});
