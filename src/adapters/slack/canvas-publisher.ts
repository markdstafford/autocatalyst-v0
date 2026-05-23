// src/adapters/slack/canvas-publisher.ts
import { readFileSync } from 'node:fs';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import { titleFromArtifactPath, type ArtifactPublication, type ArtifactPublisher } from '../../types/publisher.js';
import type { ConversationRef } from '../../types/channel.js';
import type { Artifact } from '../../types/artifact.js';

interface CanvasPublisherOptions {
  logDestination?: pino.DestinationStream;
}

export class SlackCanvasPublisher implements ArtifactPublisher {
  private readonly app: App;
  private readonly logger: pino.Logger;
  private workspaceUrl: string | undefined;
  private teamId: string | undefined;

  constructor(app: App, options?: CanvasPublisherOptions) {
    this.app = app;
    this.logger = createLogger('canvas-publisher', { destination: options?.logDestination });
  }

  private async resolveWorkspace(): Promise<void> {
    if (this.workspaceUrl && this.teamId) return;
    const auth = await this.app.client.auth.test();
    this.workspaceUrl = (auth.url as string).replace(/\/$/, '');
    this.teamId = auth.team_id as string;
  }

  private canvasUrl(canvas_id: string): string {
    return `${this.workspaceUrl}/docs/${this.teamId}/${canvas_id}`;
  }

  async createArtifact(conversation: ConversationRef, artifact: Artifact): Promise<ArtifactPublication> {
    await this.resolveWorkspace();
    const channel_id = conversation.channel_id;
    const spec_path = artifact.local_path;
    const content = readFileSync(spec_path, 'utf-8');
    const title = titleFromArtifactPath(spec_path);

    // Create the canvas
    const createResult = await (this.app.client as unknown as {
      canvases: {
        create: (args: { title?: string; document_content: { type: string; markdown: string } }) => Promise<{ canvas_id: string }>;
        access: { set: (args: { canvas_id: string; access_level: string; channel_ids: string[] }) => Promise<void> };
      }
    }).canvases.create({
      title,
      document_content: { type: 'markdown', markdown: content },
    });
    const canvas_id = createResult.canvas_id;

    // Grant write access to the channel so members can comment
    await (this.app.client as unknown as {
      canvases: { access: { set: (args: { canvas_id: string; access_level: string; channel_ids: string[] }) => Promise<void> } }
    }).canvases.access.set({
      canvas_id,
      access_level: 'write',
      channel_ids: [channel_id],
    });

    const url = this.canvasUrl(canvas_id);
    this.logger.info({ event: 'canvas.created', channel_id, canvas_id }, 'Canvas created');
    return { id: canvas_id, url, label: 'View spec' };
  }

  async updateArtifact(canvas_id: string, artifact: Artifact, page_content?: string): Promise<void> {
    const content = page_content ?? readFileSync(artifact.local_path, 'utf-8');

    await (this.app.client as unknown as {
      canvases: { edit: (args: { canvas_id: string; changes: Array<{ operation: string; document_content: { type: string; markdown: string } }> }) => Promise<void> }
    }).canvases.edit({
      canvas_id,
      changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: content } }],
    });

    this.logger.info({ event: 'canvas.updated', canvas_id }, 'Canvas updated');
  }
}
