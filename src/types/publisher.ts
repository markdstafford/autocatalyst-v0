import { basename } from 'path';
import type { ConversationRef } from './channel.js';
import type { Artifact } from './artifact.js';

export type ArtifactPublicationStatus =
  | 'drafting'
  | 'waiting_on_feedback'
  | 'approved'
  | 'complete'
  | 'superseded';

export interface ArtifactPublisher {
  createArtifact(conversation: ConversationRef, artifact: Artifact): Promise<ArtifactPublication>;
  updateArtifact(publication_ref: string, artifact: Artifact, page_content?: string): Promise<void>;
  updateStatus?(publication_ref: string, status: ArtifactPublicationStatus): Promise<void>;
  setIssueLink?(publication_ref: string, issue_url: string): Promise<void>;
}

export interface ArtifactPublication {
  id: string;
  url?: string;
  provider?: string;
  label?: string;
}

export interface ArtifactCommentAnchor {
  id: string;
  text: string;
}

export interface ArtifactCommentAnchorCodec {
  extract(content: string): ArtifactCommentAnchor[];
  promptInstructions(anchors: ArtifactCommentAnchor[]): string[];
  preserve(revisedContent: string, anchors: ArtifactCommentAnchor[]): string;
  strip(content: string): string;
}

export interface ArtifactContentSource {
  getContent(publication_ref: string, stripHtml?: boolean): Promise<string>;
}

export function titleFromArtifactPath(artifact_path: string): string {
  const slug = basename(artifact_path, '.md')
    .replace(/^(feature|enhancement)-/, '')
    .replace(/-/g, ' ');
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
