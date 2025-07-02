import { Canvas as CanvasModel } from '../../generated/client';
import { Canvas, Entity, EntityType, CanvasNode } from '@refly/openapi-schema';
import { CanvasNodeFilter } from '@refly/canvas-common';
import { pick } from '../../utils';

export interface SyncCanvasEntityJobData {
  canvasId: string;
}

export interface DeleteCanvasNodesJobData {
  entities: Entity[];
}

export interface AutoNameCanvasJobData {
  uid: string;
  canvasId: string;
}

export interface DeleteCanvasJobData {
  uid: string;
  canvasId: string;
  deleteAllFiles: boolean;
}

export interface VerifyNodeAdditionJobData {
  uid: string;
  canvasId: string;
  node: CanvasNode;
  connectTo?: CanvasNodeFilter[];
  attempt: number;
  maxAttempts: number;
}

export interface CanvasContentItem {
  id: string;
  title: string;
  type: EntityType;
  content?: string;
  contentPreview?: string;
  inputIds?: string[];
}

export function canvasPO2DTO(canvas: CanvasModel & { minimapUrl?: string }): Canvas {
  return {
    ...pick(canvas, ['canvasId', 'title', 'minimapUrl', 'minimapStorageKey']),
    createdAt: canvas.createdAt.toJSON(),
    updatedAt: canvas.updatedAt.toJSON(),
  };
}
