// tests/adapters/slack/canvas-publisher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { App } from '@slack/bolt';
import { SlackCanvasPublisher } from '../../../src/adapters/slack/canvas-publisher.js';
import type { ConversationRef } from '../../../src/types/channel.js';
import type { Artifact } from '../../../src/types/artifact.js';

const nullDest = { write: () => {} };

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cp-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeSpecFile(content = '# My Spec\n\nsome content'): string {
  const path = join(tempDir, 'feature-test.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeConversation(): ConversationRef {
  return { provider: 'slack', channel_id: 'C123', conversation_id: '100.0' };
}

function makeArtifact(localPath: string): Artifact {
  return { kind: 'feature_spec', local_path: localPath, status: 'drafting' };
}

function makeMockApp(canvasId = 'CANVAS001') {
  return {
    client: {
      auth: {
        test: vi.fn().mockResolvedValue({ url: 'https://testworkspace.slack.com/', team_id: 'T123' }),
      },
      canvases: {
        create: vi.fn().mockResolvedValue({ canvas_id: canvasId }),
        edit: vi.fn().mockResolvedValue({}),
        access: {
          set: vi.fn().mockResolvedValue({}),
        },
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe('ArtifactPublisher.createArtifact', () => {
  it('calls canvases.create with spec file content', async () => {
    const mock = makeMockApp();
    const specPath = makeSpecFile('# My Spec\n\ncontent');
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await cp.createArtifact(makeConversation(), makeArtifact(specPath));

    expect(mock.client.canvases.create).toHaveBeenCalledWith(
      expect.objectContaining({
        document_content: expect.objectContaining({ markdown: expect.stringContaining('# My Spec') }),
      }),
    );
  });

  it('returns a canvas publication url without posting to the channel', async () => {
    const mock = makeMockApp('CANVAS999');
    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    const result = await cp.createArtifact(makeConversation(), makeArtifact(specPath));

    expect(result).toEqual({
      id: 'CANVAS999',
      url: 'https://testworkspace.slack.com/docs/T123/CANVAS999',
      label: 'View spec',
    });
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('does not post a channel notification after creating the canvas', async () => {
    const order: string[] = [];
    const mock = makeMockApp();
    mock.client.canvases.create.mockImplementation(async () => {
      order.push('canvas.create');
      return { canvas_id: 'C1' };
    });

    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });
    await cp.createArtifact(makeConversation(), makeArtifact(specPath));

    expect(order).toEqual(['canvas.create']);
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns canvas publication metadata from canvases.create response', async () => {
    const mock = makeMockApp('CANVAS_XYZ');
    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    const result = await cp.createArtifact(makeConversation(), makeArtifact(specPath));

    expect(result).toEqual({
      id: 'CANVAS_XYZ',
      url: 'https://testworkspace.slack.com/docs/T123/CANVAS_XYZ',
      label: 'View spec',
    });
  });

  it('returns label "View spec" as part of the publication result', async () => {
    const mock = makeMockApp('CANVAS_LABEL');
    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });
    const result = await cp.createArtifact(makeConversation(), makeArtifact(specPath));
    expect(result.label).toBe('View spec');
  });

  it('throws if canvases.create rejects; postMessage is not called', async () => {
    const mock = makeMockApp();
    mock.client.canvases.create.mockRejectedValue(new Error('canvas API error'));

    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await expect(cp.createArtifact(makeConversation(), makeArtifact(specPath))).rejects.toThrow('canvas API error');
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('ArtifactPublisher.updateArtifact', () => {
  it('calls canvases.edit with canvas_id and updated spec content', async () => {
    const mock = makeMockApp();
    const specPath = makeSpecFile('# Revised Spec\n\nnew content');
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await cp.updateArtifact('CANVAS001', makeArtifact(specPath));

    expect(mock.client.canvases.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas_id: 'CANVAS001',
        changes: expect.arrayContaining([
          expect.objectContaining({
            document_content: expect.objectContaining({ markdown: expect.stringContaining('# Revised Spec') }),
          }),
        ]),
      }),
    );
  });

  it('throws if canvases.edit rejects', async () => {
    const mock = makeMockApp();
    mock.client.canvases.edit.mockRejectedValue(new Error('edit failed'));

    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await expect(cp.updateArtifact('CANVAS001', makeArtifact(specPath))).rejects.toThrow('edit failed');
  });
});
