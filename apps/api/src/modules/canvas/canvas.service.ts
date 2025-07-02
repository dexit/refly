import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as Y from 'yjs';
import pLimit from 'p-limit';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../common/prisma.service';
import { MiscService } from '../misc/misc.service';
import { CollabService } from '../collab/collab.service';
import { CodeArtifactService } from '../code-artifact/code-artifact.service';
import { FULLTEXT_SEARCH, FulltextSearchService } from '../common/fulltext-search';
import { CanvasNotFoundError, ParamsError, StorageQuotaExceeded } from '@refly/errors';
import {
  AutoNameCanvasRequest,
  DeleteCanvasRequest,
  DuplicateCanvasRequest,
  Entity,
  EntityType,
  ListCanvasesData,
  RawCanvasData,
  UpsertCanvasRequest,
  User,
  CanvasNode,
  SkillContext,
  ActionResult,
} from '@refly/openapi-schema';
import { Prisma, Canvas as CanvasModel } from '../../generated/client';
import { genCanvasID } from '@refly/utils';
import { DeleteKnowledgeEntityJobData } from '../knowledge/knowledge.dto';
import {
  QUEUE_DELETE_KNOWLEDGE_ENTITY,
  QUEUE_POST_DELETE_CANVAS,
  QUEUE_VERIFY_NODE_ADDITION,
} from '../../utils/const';
import {
  AutoNameCanvasJobData,
  DeleteCanvasJobData,
  VerifyNodeAdditionJobData,
} from './canvas.dto';
import { streamToBuffer } from '../../utils';
import { SubscriptionService } from '../subscription/subscription.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ActionService } from '../action/action.service';
import { generateCanvasTitle } from './canvas-title-generator';
import { CanvasContentItem } from './canvas.dto';
import { RedisService } from '../common/redis.service';
import { ObjectStorageService, OSS_INTERNAL } from '../common/object-storage';
import { ProviderService } from '../provider/provider.service';
import { isDesktop } from '../../utils/runtime';
import { CanvasNodeFilter, prepareAddNode } from '@refly/canvas-common';

@Injectable()
export class CanvasService {
  private logger = new Logger(CanvasService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private collabService: CollabService,
    private miscService: MiscService,
    private actionService: ActionService,
    private knowledgeService: KnowledgeService,
    private providerService: ProviderService,
    private codeArtifactService: CodeArtifactService,
    private subscriptionService: SubscriptionService,
    @Inject(OSS_INTERNAL) private oss: ObjectStorageService,
    @Inject(FULLTEXT_SEARCH) private fts: FulltextSearchService,
    @Optional()
    @InjectQueue(QUEUE_DELETE_KNOWLEDGE_ENTITY)
    private deleteKnowledgeQueue?: Queue<DeleteKnowledgeEntityJobData>,
    @Optional()
    @InjectQueue(QUEUE_POST_DELETE_CANVAS)
    private postDeleteCanvasQueue?: Queue<DeleteCanvasJobData>,
    @Optional()
    @InjectQueue(QUEUE_VERIFY_NODE_ADDITION)
    private verifyNodeAdditionQueue?: Queue<VerifyNodeAdditionJobData>,
  ) {}

  async listCanvases(user: User, param: ListCanvasesData['query']) {
    const { page = 1, pageSize = 10, projectId } = param;

    const canvases = await this.prisma.canvas.findMany({
      where: {
        uid: user.uid,
        deletedAt: null,
        projectId: projectId || null,
      },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return canvases.map((canvas) => ({
      ...canvas,
      minimapUrl: canvas.minimapStorageKey
        ? this.miscService.generateFileURL({ storageKey: canvas.minimapStorageKey })
        : undefined,
    }));
  }

  async getCanvasDetail(user: User, canvasId: string) {
    const canvas = await this.prisma.canvas.findFirst({
      where: { canvasId, uid: user.uid, deletedAt: null },
    });

    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    return {
      ...canvas,
      minimapUrl: canvas.minimapStorageKey
        ? this.miscService.generateFileURL({ storageKey: canvas.minimapStorageKey })
        : undefined,
    };
  }

  async getCanvasYDoc(stateStorageKey: string) {
    if (!stateStorageKey) {
      return null;
    }

    try {
      const readable = await this.oss.getObject(stateStorageKey);
      if (!readable) {
        throw new Error('Canvas state not found');
      }

      const state = await streamToBuffer(readable);
      if (!state?.length) {
        throw new Error('Canvas state is empty');
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);

      return doc;
    } catch (error) {
      this.logger.warn(`Error getting canvas YDoc for key ${stateStorageKey}: ${error?.message}`);
      return null;
    }
  }

  async saveCanvasYDoc(stateStorageKey: string, doc: Y.Doc) {
    await this.oss.putObject(stateStorageKey, Buffer.from(Y.encodeStateAsUpdate(doc)));
  }

  async getCanvasRawData(user: User, canvasId: string): Promise<RawCanvasData> {
    const canvas = await this.prisma.canvas.findFirst({
      select: {
        title: true,
        uid: true,
        stateStorageKey: true,
        minimapStorageKey: true,
      },
      where: {
        canvasId,
        uid: user.uid,
        deletedAt: null,
      },
    });

    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    const userPo = await this.prisma.user.findUnique({
      select: {
        name: true,
        nickname: true,
        avatar: true,
      },
      where: { uid: user.uid },
    });

    const doc = await this.getCanvasYDoc(canvas.stateStorageKey);

    return {
      title: canvas.title,
      nodes: doc?.getArray('nodes').toJSON() ?? [],
      edges: doc?.getArray('edges').toJSON() ?? [],
      owner: {
        uid: canvas.uid,
        name: userPo?.name,
        nickname: userPo?.nickname,
        avatar: userPo?.avatar,
      },
      minimapUrl: canvas.minimapStorageKey
        ? this.miscService.generateFileURL({ storageKey: canvas.minimapStorageKey })
        : undefined,
    };
  }

  async duplicateCanvas(
    user: User,
    param: DuplicateCanvasRequest,
    options?: { checkOwnership?: boolean },
  ) {
    const { title, canvasId, projectId, duplicateEntities } = param;

    const canvas = await this.prisma.canvas.findFirst({
      where: { canvasId, deletedAt: null, uid: options?.checkOwnership ? user.uid : undefined },
    });

    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    const doc = new Y.Doc();

    if (canvas.stateStorageKey) {
      const readable = await this.oss.getObject(canvas.stateStorageKey);
      const state = await streamToBuffer(readable);
      Y.applyUpdate(doc, state);
    }

    const nodes: CanvasNode[] = doc.getArray('nodes').toJSON();
    const libEntityNodes = nodes.filter((node) =>
      ['document', 'resource', 'codeArtifact'].includes(node.type),
    );

    // Check storage quota if entities need to be duplicated
    if (duplicateEntities) {
      const { available } = await this.subscriptionService.checkStorageUsage(user);
      if (available < libEntityNodes.length) {
        throw new StorageQuotaExceeded();
      }
    }

    const newCanvasId = genCanvasID();
    const newTitle = title || canvas.title;
    this.logger.log(`Duplicating canvas ${canvasId} to ${newCanvasId} with ${newTitle}`);

    const stateStorageKey = `state/${newCanvasId}`;

    const newCanvas = await this.prisma.canvas.create({
      data: {
        uid: user.uid,
        canvasId: newCanvasId,
        title: newTitle,
        status: 'duplicating',
        stateStorageKey,
        projectId,
      },
    });

    // This is used to trace the replacement of entities
    // Key is the original entity id, value is the duplicated entity id
    const replaceEntityMap: Record<string, string> = {};

    // Duplicate resources and documents if needed
    if (duplicateEntities) {
      const limit = pLimit(5); // Limit concurrent operations

      await Promise.all(
        libEntityNodes.map((node) =>
          limit(async () => {
            const entityType = node.type;
            const { entityId } = node.data;

            // Create new entity based on type
            switch (entityType) {
              case 'document': {
                const doc = await this.knowledgeService.duplicateDocument(user, {
                  docId: entityId,
                  title: node.data?.title,
                });
                if (doc) {
                  node.data.entityId = doc.docId;
                  replaceEntityMap[entityId] = doc.docId;
                }
                break;
              }
              case 'resource': {
                const resource = await this.knowledgeService.duplicateResource(user, {
                  resourceId: entityId,
                  title: node.data?.title,
                });
                if (resource) {
                  node.data.entityId = resource.resourceId;
                  replaceEntityMap[entityId] = resource.resourceId;
                }
                break;
              }
              case 'codeArtifact': {
                const codeArtifact = await this.codeArtifactService.duplicateCodeArtifact(
                  user,
                  entityId,
                );
                if (codeArtifact) {
                  node.data.entityId = codeArtifact.artifactId;
                  replaceEntityMap[entityId] = codeArtifact.artifactId;
                }
                break;
              }
            }
          }),
        ),
      );
    }

    // Action results must be duplicated
    const actionResultIds = nodes
      .filter((node) => node.type === 'skillResponse')
      .map((node) => node.data.entityId);
    await this.actionService.duplicateActionResults(user, {
      sourceResultIds: actionResultIds,
      targetId: newCanvasId,
      targetType: 'canvas',
      replaceEntityMap,
    });

    for (const node of nodes) {
      if (node.type !== 'skillResponse') {
        continue;
      }

      const { entityId, metadata } = node.data;
      if (entityId) {
        node.data.entityId = replaceEntityMap[entityId];
      }
      if (Array.isArray(metadata.contextItems)) {
        metadata.contextItems = metadata.contextItems.map((item) => {
          if (item.entityId && replaceEntityMap[item.entityId]) {
            item.entityId = replaceEntityMap[item.entityId];
          }
          return item;
        });
      }
    }

    if (canvas.uid !== user.uid) {
      await this.miscService.duplicateFilesNoCopy(user, {
        sourceEntityId: canvasId,
        sourceEntityType: 'canvas',
        sourceUid: user.uid,
        targetEntityId: newCanvasId,
        targetEntityType: 'canvas',
      });
    }

    doc.transact(() => {
      doc.getText('title').delete(0, doc.getText('title').length);
      doc.getText('title').insert(0, title);

      doc.getArray('nodes').delete(0, doc.getArray('nodes').length);
      doc.getArray('nodes').insert(0, nodes);
    });

    await this.oss.putObject(stateStorageKey, Buffer.from(Y.encodeStateAsUpdate(doc)));

    // Update canvas status to completed
    await this.prisma.canvas.update({
      where: { canvasId: newCanvasId },
      data: { status: 'ready' },
    });

    await this.prisma.duplicateRecord.create({
      data: {
        uid: user.uid,
        sourceId: canvasId,
        targetId: newCanvasId,
        entityType: 'canvas',
        status: 'finish',
      },
    });

    this.logger.log(`Successfully duplicated canvas ${canvasId} to ${newCanvasId}`);

    return newCanvas;
  }

  async createCanvas(user: User, param: UpsertCanvasRequest) {
    const canvasId = genCanvasID();
    const stateStorageKey = `state/${canvasId}`;
    const canvas = await this.prisma.canvas.create({
      data: {
        uid: user.uid,
        canvasId,
        title: param.title,
        projectId: param.projectId,
        stateStorageKey,
      },
    });

    const ydoc = new Y.Doc();
    ydoc.getText('title').insert(0, param.title);

    await this.saveCanvasYDoc(stateStorageKey, ydoc);

    this.logger.log(`created canvas data: ${JSON.stringify(ydoc.toJSON())}`);

    await this.fts.upsertDocument(user, 'canvas', {
      id: canvas.canvasId,
      title: canvas.title,
      createdAt: canvas.createdAt.toJSON(),
      updatedAt: canvas.updatedAt.toJSON(),
      uid: canvas.uid,
      projectId: canvas.projectId,
    });

    return canvas;
  }

  /**
   * Execute a transaction on a canvas document with automatic connection management
   * @param canvasId - The id of the canvas
   * @param user - The user performing the operation
   * @param canvas - The canvas entity (optional, will be fetched if not provided)
   * @param transaction - The transaction function to execute
   */
  private async executeCanvasTransaction(
    canvasId: string,
    user: User,
    canvas: CanvasModel | null,
    transaction: (doc: Y.Doc) => void | Promise<void>,
  ): Promise<void> {
    const connection = await this.collabService.openDirectConnection(canvasId, {
      user,
      entity: canvas,
      entityType: 'canvas',
    });

    try {
      await connection.document.transact(async () => {
        const result = transaction(connection.document);
        // If the transaction returns a promise, await it
        if (result && typeof result.then === 'function') {
          await result;
        }
      });
    } finally {
      await connection.disconnect();
    }
  }

  /**
   * Apply realtime updates to canvas document
   * @param user - The user who is applying the updates
   * @param canvasId - The id of the canvas to apply the updates to
   * @param tx - The Yjs transaction to apply to the canvas
   */
  async applyUpdatesToCanvasDoc(
    user: User,
    canvasId: string,
    tx: (doc: Y.Doc) => void,
    canvasPo?: CanvasModel,
  ) {
    const canvas =
      canvasPo ||
      (await this.prisma.canvas.findUnique({
        where: { canvasId, uid: user.uid, deletedAt: null },
      }));
    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    await this.executeCanvasTransaction(canvasId, user, canvas, tx);
  }

  /**
   * Add a node to the canvas document
   * @param user - The user who is adding the node
   * @param canvasId - The id of the canvas to add the node to
   * @param node - The node to add
   * @param connectTo - The nodes to connect to
   */
  async addNodeToCanvasDoc(
    user: User,
    canvasId: string,
    node: CanvasNode,
    connectTo?: CanvasNodeFilter[],
  ) {
    await this.applyUpdatesToCanvasDoc(user, canvasId, (doc) => {
      const nodes = doc.getArray('nodes');
      const edges = doc.getArray('edges');

      const { newNode, newEdges } = prepareAddNode({
        node,
        nodes: nodes.toJSON(),
        edges: edges.toJSON(),
        connectTo,
      });

      nodes.push([newNode]);
      edges.push(newEdges);
    });

    // Schedule a delayed verification task to check if the node was actually added
    if (this.verifyNodeAdditionQueue) {
      await this.verifyNodeAdditionQueue.add(
        'verifyNodeAddition',
        {
          uid: user.uid,
          canvasId,
          node,
          connectTo,
          attempt: 1,
          maxAttempts: 3,
        },
        {
          delay: 2000, // Wait 2 seconds before verification
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 1, // Don't retry the verification job itself, retry logic is handled inside
        },
      );
    } else if (isDesktop()) {
      // In desktop mode, schedule verification using setTimeout
      setTimeout(() => {
        this.verifyNodeAdditionFromQueue({
          uid: user.uid,
          canvasId,
          node,
          connectTo,
          attempt: 1,
          maxAttempts: 3,
        }).catch((error) => {
          this.logger.error(`Failed to verify node addition: ${error?.message}`);
        });
      }, 2000);
    }
  }

  /**
   * Check if a node exists in the canvas document
   * @param canvasId - The id of the canvas
   * @param nodeEntityId - The entity id of the node to check
   * @param nodeType - The type of the node to check
   * @returns true if the node exists, false otherwise
   */
  private async nodeExistsInCanvas(
    canvasId: string,
    nodeEntityId: string,
    nodeType: string,
  ): Promise<boolean> {
    try {
      const canvas = await this.prisma.canvas.findUnique({
        where: { canvasId },
      });

      if (!canvas?.stateStorageKey) {
        return false;
      }

      const doc = await this.getCanvasYDoc(canvas.stateStorageKey);
      if (!doc) {
        return false;
      }

      const nodes = doc.getArray('nodes').toJSON();
      return nodes.some(
        (existingNode: any) =>
          existingNode.type === nodeType && existingNode.data?.entityId === nodeEntityId,
      );
    } catch (error) {
      this.logger.warn(`Error checking if node exists in canvas ${canvasId}: ${error?.message}`);
      return false;
    }
  }

  /**
   * Verify if a node was successfully added and retry if not
   * @param jobData - The verification job data
   */
  async verifyNodeAdditionFromQueue(jobData: VerifyNodeAdditionJobData) {
    const { uid, canvasId, node, connectTo, attempt, maxAttempts } = jobData;

    const nodeEntityId = node.data?.entityId || 'unknown';
    const nodeType = node.type;

    this.logger.log(
      `Verifying node addition for canvas ${canvasId}, node ${nodeEntityId} (${nodeType}), attempt ${attempt}/${maxAttempts}`,
    );

    const user = await this.prisma.user.findFirst({ where: { uid } });
    if (!user) {
      this.logger.warn(`User not found for uid ${uid} when verifying node addition`);
      return;
    }

    const canvas = await this.prisma.canvas.findUnique({
      where: { canvasId, uid, deletedAt: null },
    });

    if (!canvas) {
      this.logger.warn(`Canvas ${canvasId} not found when verifying node addition`);
      return;
    }

    // Check if the node exists
    const nodeExists = await this.nodeExistsInCanvas(canvasId, nodeEntityId, nodeType);

    if (!nodeExists) {
      this.logger.warn(
        `Node ${nodeEntityId} (${nodeType}) not found in canvas ${canvasId}, attempt ${attempt}/${maxAttempts}`,
      );

      if (attempt < maxAttempts) {
        // Retry adding the node
        try {
          this.logger.log(
            `Retrying to add node ${nodeEntityId} (${nodeType}) to canvas ${canvasId}`,
          );

          await this.applyUpdatesToCanvasDoc(user, canvasId, (doc) => {
            const nodes = doc.getArray('nodes');
            const edges = doc.getArray('edges');

            const { newNode, newEdges } = prepareAddNode({
              node,
              nodes: nodes.toJSON(),
              edges: edges.toJSON(),
              connectTo,
            });

            nodes.push([newNode]);
            edges.push(newEdges);
          });

          // Schedule another verification for the next attempt
          if (this.verifyNodeAdditionQueue) {
            await this.verifyNodeAdditionQueue.add(
              'verifyNodeAddition',
              {
                uid,
                canvasId,
                node,
                connectTo,
                attempt: attempt + 1,
                maxAttempts,
              },
              {
                delay: 2000 * attempt, // Exponential backoff
                removeOnComplete: true,
                removeOnFail: false,
                attempts: 1,
              },
            );
          } else if (isDesktop()) {
            // In desktop mode, schedule verification using setTimeout
            setTimeout(() => {
              this.verifyNodeAdditionFromQueue({
                uid,
                canvasId,
                node,
                connectTo,
                attempt: attempt + 1,
                maxAttempts,
              }).catch((error) => {
                this.logger.error(`Failed to verify node addition: ${error?.message}`);
              });
            }, 2000 * attempt);
          }
        } catch (error) {
          this.logger.error(
            `Failed to retry adding node ${nodeEntityId} (${nodeType}) to canvas ${canvasId}: ${error?.message}`,
          );
        }
      } else {
        this.logger.error(
          `Failed to add node ${nodeEntityId} (${nodeType}) to canvas ${canvasId} after ${maxAttempts} attempts`,
        );
      }
    } else {
      this.logger.log(
        `Node ${nodeEntityId} (${nodeType}) successfully verified in canvas ${canvasId}`,
      );
    }
  }

  async updateCanvas(user: User, param: UpsertCanvasRequest) {
    const { canvasId, title, minimapStorageKey, projectId } = param;

    const canvas = await this.prisma.canvas.findUnique({
      where: { canvasId, uid: user.uid, deletedAt: null },
    });
    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    const originalMinimap = canvas.minimapStorageKey;
    const updates: Prisma.CanvasUpdateInput = {};

    if (title !== undefined) {
      updates.title = title;
    }
    if (projectId !== undefined) {
      if (projectId) {
        updates.project = { connect: { projectId } };
      } else {
        updates.project = { disconnect: true };
      }
    }
    if (minimapStorageKey !== undefined) {
      const minimapFile = await this.miscService.findFileAndBindEntity(minimapStorageKey, {
        entityId: canvasId,
        entityType: 'canvas',
      });
      if (!minimapFile) {
        throw new ParamsError('Minimap file not found');
      }
      updates.minimapStorageKey = minimapFile.storageKey;
    }

    const updatedCanvas = await this.prisma.canvas.update({
      where: { canvasId, uid: user.uid, deletedAt: null },
      data: updates,
    });

    if (!updatedCanvas) {
      throw new CanvasNotFoundError();
    }

    // Update title in yjs document
    if (title !== undefined) {
      await this.executeCanvasTransaction(canvasId, user, updatedCanvas, (doc) => {
        const titleText = doc.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, param.title);
      });
    }

    // Remove original minimap if it exists
    if (
      originalMinimap &&
      minimapStorageKey !== undefined &&
      minimapStorageKey !== originalMinimap
    ) {
      await this.oss.removeObject(originalMinimap);
    }

    await this.fts.upsertDocument(user, 'canvas', {
      id: updatedCanvas.canvasId,
      title: updatedCanvas.title,
      updatedAt: updatedCanvas.updatedAt.toJSON(),
      uid: updatedCanvas.uid,
      projectId: updatedCanvas.projectId,
    });

    return updatedCanvas;
  }

  async deleteCanvas(user: User, param: DeleteCanvasRequest) {
    const { uid } = user;
    const { canvasId } = param;

    const canvas = await this.prisma.canvas.findFirst({
      where: { canvasId, uid, deletedAt: null },
    });
    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    // Mark the canvas as deleted immediately
    await this.prisma.canvas.update({
      where: { canvasId },
      data: { deletedAt: new Date() },
    });

    // Add canvas deletion to queue for async processing
    if (this.postDeleteCanvasQueue) {
      await this.postDeleteCanvasQueue.add(
        'postDeleteCanvas',
        {
          uid,
          canvasId,
          deleteAllFiles: param.deleteAllFiles,
        },
        {
          jobId: `canvas-cleanup-${canvasId}`,
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      );
    } else if (isDesktop()) {
      // In desktop mode, process deletion directly
      await this.postDeleteCanvas({
        uid,
        canvasId,
        deleteAllFiles: param.deleteAllFiles,
      });
    }
  }

  async postDeleteCanvas(jobData: DeleteCanvasJobData) {
    const { uid, canvasId, deleteAllFiles } = jobData;
    this.logger.log(`Processing canvas cleanup for ${canvasId}, deleteAllFiles: ${deleteAllFiles}`);

    const canvas = await this.prisma.canvas.findFirst({
      where: { canvasId, uid, deletedAt: { not: null } }, // Make sure it's already marked as deleted
    });

    if (!canvas) {
      this.logger.warn(`Canvas ${canvasId} not found or not deleted`);
      return;
    }

    const cleanups: Promise<any>[] = [this.fts.deleteDocument({ uid }, 'canvas', canvas.canvasId)];

    if (canvas.stateStorageKey) {
      cleanups.push(this.oss.removeObject(canvas.stateStorageKey));
    }

    if (canvas.minimapStorageKey) {
      cleanups.push(this.oss.removeObject(canvas.minimapStorageKey));
    }

    if (deleteAllFiles) {
      const relations = await this.prisma.canvasEntityRelation.findMany({
        where: { canvasId, deletedAt: null },
      });
      const entities = relations.map((r) => ({
        entityId: r.entityId,
        entityType: r.entityType as EntityType,
      }));
      this.logger.log(`Entities to be deleted: ${JSON.stringify(entities)}`);

      for (const entity of entities) {
        if (this.deleteKnowledgeQueue) {
          await this.deleteKnowledgeQueue.add(
            'deleteKnowledgeEntity',
            {
              uid: canvas.uid,
              entityId: entity.entityId,
              entityType: entity.entityType,
            },
            {
              jobId: entity.entityId,
              removeOnComplete: true,
              removeOnFail: true,
              attempts: 3,
            },
          );
        }
        // Note: In desktop mode, entity deletion would be handled differently
        // or could be processed synchronously if needed
      }

      // Mark relations as deleted
      await this.prisma.canvasEntityRelation.updateMany({
        where: { canvasId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    try {
      await Promise.all(cleanups);
      this.logger.log(`Successfully cleaned up canvas ${canvasId}`);
    } catch (error) {
      this.logger.error(`Error cleaning up canvas ${canvasId}: ${error?.message}`);
      throw error; // Re-throw to trigger BullMQ retry
    }
  }

  async syncCanvasEntityRelation(canvasId: string) {
    const canvas = await this.prisma.canvas.findUnique({
      where: { canvasId },
    });
    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    const releaseLock = await this.redis.acquireLock(`canvas-entity-relation-lock:${canvasId}`);
    if (!releaseLock) {
      this.logger.warn(`Failed to acquire lock for canvas ${canvasId}`);
      return;
    }

    try {
      const ydoc = new Y.Doc();
      await this.collabService.loadDocument({
        document: ydoc,
        documentName: canvas.canvasId,
        context: {
          user: { uid: canvas.uid },
          entity: canvas,
          entityType: 'canvas',
        },
      });
      const nodes = ydoc.getArray('nodes').toJSON();

      const entities: Entity[] = nodes
        .map((node) => ({
          entityId: node.data?.entityId,
          entityType: node.type,
        }))
        .filter((entity) => entity.entityId && entity.entityType);

      const existingRelations = await this.prisma.canvasEntityRelation.findMany({
        select: { entityId: true },
        where: { canvasId, deletedAt: null },
      });

      // Find relations to be removed (soft delete)
      const entityIds = new Set(entities.map((e) => e.entityId));
      const relationsToRemove = existingRelations.filter(
        (relation) => !entityIds.has(relation.entityId),
      );

      // Find new relations to be created
      const existingEntityIds = new Set(existingRelations.map((r) => r.entityId));
      const relationsToCreate = entities.filter(
        (entity) => !existingEntityIds.has(entity.entityId),
      );

      // Perform bulk operations
      await Promise.all([
        // Soft delete removed relations in bulk
        this.prisma.canvasEntityRelation.updateMany({
          where: {
            canvasId,
            entityId: { in: relationsToRemove.map((r) => r.entityId) },
            deletedAt: null,
          },
          data: { deletedAt: new Date() },
        }),
        // Create new relations in bulk
        this.prisma.canvasEntityRelation.createMany({
          data: relationsToCreate.map((entity) => ({
            canvasId,
            entityId: entity.entityId,
            entityType: entity.entityType,
          })),
        }),
      ]);
    } finally {
      await releaseLock();
    }
  }

  /**
   * Delete entity nodes from all related canvases
   * @param entities
   */
  async deleteEntityNodesFromCanvases(entities: Entity[]) {
    this.logger.log(`Deleting entity nodes from canvases: ${JSON.stringify(entities)}`);

    // Find all canvases that have relations with these entities
    const relations = await this.prisma.canvasEntityRelation.findMany({
      where: {
        entityId: { in: entities.map((e) => e.entityId) },
        entityType: { in: entities.map((e) => e.entityType) },
        deletedAt: null,
      },
      distinct: ['canvasId'],
    });

    const canvasIds = relations.map((r) => r.canvasId);
    if (canvasIds.length === 0) {
      this.logger.log(`No related canvases found for entities: ${JSON.stringify(entities)}`);
      return;
    }
    this.logger.log(`Found related canvases: ${JSON.stringify(canvasIds)}`);

    // Load each canvas and remove the nodes
    const limit = pLimit(3);
    await Promise.all(
      canvasIds.map((canvasId) =>
        limit(async () => {
          const canvas = await this.prisma.canvas.findUnique({
            where: { canvasId },
          });
          if (!canvas) return;

          // Remove nodes matching the entities
          await this.executeCanvasTransaction(canvasId, { uid: canvas.uid }, canvas, (doc) => {
            const nodes = doc.getArray('nodes');
            const toRemove: number[] = [];

            nodes.forEach((node: any, index: number) => {
              const entityId = node?.data?.entityId;
              const entityType = node?.type;

              if (entityId && entityType) {
                const matchingEntity = entities.find(
                  (e) => e.entityId === entityId && e.entityType === entityType,
                );
                if (matchingEntity) {
                  toRemove.push(index);
                }
              }
            });

            // Remove nodes in reverse order to maintain correct indices
            toRemove.reverse();
            for (const index of toRemove) {
              nodes.delete(index, 1);
            }
          });

          // Update relations
          await this.prisma.canvasEntityRelation.updateMany({
            where: {
              canvasId,
              entityId: { in: entities.map((e) => e.entityId) },
              entityType: { in: entities.map((e) => e.entityType) },
              deletedAt: null,
            },
            data: { deletedAt: new Date() },
          });
        }),
      ),
    );
  }

  async getCanvasContentItems(user: User, canvasId: string, needAllNodes = false) {
    const canvas = await this.prisma.canvas.findFirst({
      where: { canvasId, uid: user.uid, deletedAt: null },
    });
    if (!canvas) {
      throw new CanvasNotFoundError();
    }

    const results = await this.prisma.actionResult.findMany({
      select: {
        title: true,
        input: true,
        version: true,
        resultId: true,
        context: true,
        history: true,
      },
      where: { targetId: canvasId, targetType: 'canvas' },
    });

    // Collect content items for title generation
    const contentItems: CanvasContentItem[] = await Promise.all(
      results.map(async (result) => {
        const { resultId, version, title } = result;
        const steps = await this.prisma.actionStep.findMany({
          where: { resultId, version },
        });
        const answer = steps.map((s) => s.content.slice(0, 500)).join('\n');
        const context: SkillContext = JSON.parse(result.context ?? '[]');
        const history: ActionResult[] = JSON.parse(result.history ?? '[]');

        return {
          id: resultId,
          title,
          contentPreview: answer,
          content: steps.map((s) => s.content).join('\n\n'),
          type: 'skillResponse',
          inputIds: [
            ...(context.resources ?? []).map((r) => r.resourceId),
            ...(context.documents ?? []).map((d) => d.docId),
            ...(context.codeArtifacts ?? []).map((d) => d.artifactId),
            ...history.map((h) => h.resultId),
          ],
        } as CanvasContentItem;
      }),
    );

    // If no action results, try to get all entities associated with the canvas
    if (contentItems.length === 0 || needAllNodes) {
      const relations = await this.prisma.canvasEntityRelation.findMany({
        where: { canvasId, entityType: { in: ['resource', 'document'] }, deletedAt: null },
      });

      const [documents, resources] = await Promise.all([
        this.prisma.document.findMany({
          select: { docId: true, title: true, contentPreview: true },
          where: {
            docId: {
              in: relations.filter((r) => r.entityType === 'document').map((r) => r.entityId),
            },
          },
        }),
        this.prisma.resource.findMany({
          select: { resourceId: true, title: true, contentPreview: true },
          where: {
            resourceId: {
              in: relations.filter((r) => r.entityType === 'resource').map((r) => r.entityId),
            },
          },
        }),
      ]);

      contentItems.push(
        ...documents.map((d) => ({
          id: d.docId,
          title: d.title,
          contentPreview: d.contentPreview,
          content: d.contentPreview, // TODO: check if we need to get the whole content
          type: 'document' as const,
        })),
        ...resources.map((r) => ({
          id: r.resourceId,
          title: r.title,
          contentPreview: r.contentPreview,
          content: r.contentPreview, // TODO: check if we need to get the whole content
          type: 'resource' as const,
        })),
      );
    }

    return contentItems;
  }

  async autoNameCanvas(user: User, param: AutoNameCanvasRequest) {
    const { canvasId, directUpdate = false } = param;
    const contentItems = await this.getCanvasContentItems(user, canvasId);

    const defaultModel = await this.providerService.findDefaultProviderItem(
      user,
      'titleGeneration',
    );
    const modelConfig = JSON.parse(defaultModel.config);
    const model = await this.providerService.prepareChatModel(user, modelConfig.modelId);
    this.logger.log(`Using default model for auto naming: ${model.name}`);

    // Use the new structured title generation approach
    const newTitle = await generateCanvasTitle(contentItems, model, this.logger);

    if (directUpdate && newTitle) {
      await this.updateCanvas(user, {
        canvasId,
        title: newTitle,
      });
    }

    return { title: newTitle };
  }

  async autoNameCanvasFromQueue(jobData: AutoNameCanvasJobData) {
    const { uid, canvasId } = jobData;
    const user = await this.prisma.user.findFirst({ where: { uid } });
    if (!user) {
      this.logger.warn(`user not found for uid ${uid} when auto naming canvas: ${canvasId}`);
      return;
    }

    const result = await this.autoNameCanvas(user, { canvasId, directUpdate: true });
    this.logger.log(`Auto named canvas ${canvasId} with title: ${result.title}`);
  }
}
