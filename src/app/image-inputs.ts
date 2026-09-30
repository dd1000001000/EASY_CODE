import path from "node:path";
import type { ImageAttachment, SessionState } from "../core/types.js";
import { translate } from "../i18n/catalog.js";
import { readLanguage } from "../i18n/language.js";
import {
  ImageStore,
  MAX_IMAGES_PER_MODEL_REQUEST,
  assertThreadImageNumberAvailable,
  nextThreadImageNumber,
  validateImageAttachmentCollection,
  type ClipboardImageReader,
} from "../images/index.js";
import { requireVisionModel, validateProviderImageAttachments } from "../models/catalog.js";
import { ThreadDocumentService, ThreadResourceStore, type ThreadResourceAttachment } from "../resources/index.js";
import { type EasyCodeStorage } from "../storage/database.js";
import type { AppInteractionPort } from "../ui/interaction-port.js";
import { WorkspaceManager } from "../workspace/manager.js";

/** Live state and callbacks supplied by EasyCodeApp. */
export interface AppImageInputsContext {
  readonly clipboardImageReader: ClipboardImageReader;
  readonly imageStore: ImageStore;
  pendingImages: ImageAttachment[];
  readonly state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly terminal: AppInteractionPort;
  readonly workspace: WorkspaceManager;
  readonly threadDocumentService: ThreadDocumentService;
  readonly threadResourceStore: ThreadResourceStore;
}

export class AppImageInputs {
  constructor(private readonly ctx: AppImageInputsContext) {}

  requireCurrentModelVision(): void {
    requireVisionModel(this.ctx.state.provider, this.ctx.state.model);
  }

  async captureClipboardImage(
    index: number,
    currentImages: readonly ImageAttachment[] = this.ctx.pendingImages,
    signal?: AbortSignal,
  ): Promise<ImageAttachment> {
    this.requireCurrentModelVision();
    if (currentImages.length >= MAX_IMAGES_PER_MODEL_REQUEST) {
      throw new Error(`A task can contain at most ${MAX_IMAGES_PER_MODEL_REQUEST} images.`);
    }
    assertThreadImageNumberAvailable(index);
    const data = await this.ctx.clipboardImageReader.readImage(signal);
    const attachment = await this.ctx.imageStore.importBuffer(
      this.ctx.state.threadId,
      `Image #${index}`,
      data,
      "clipboard",
    );
    try {
      validateImageAttachmentCollection([...currentImages, attachment]);
      validateProviderImageAttachments(this.ctx.state.provider, [attachment]);
      return attachment;
    } catch (error) {
      await this.ctx.imageStore.remove(this.ctx.state.threadId, attachment).catch(() => undefined);
      throw error;
    }
  }

  async queueImagePath(rawPath: string, announce: boolean): Promise<ImageAttachment> {
    if (this.ctx.pendingImages.length >= MAX_IMAGES_PER_MODEL_REQUEST) {
      throw new Error(`A task can contain at most ${MAX_IMAGES_PER_MODEL_REQUEST} images.`);
    }
    let normalized = rawPath.trim();
    if (
      normalized.length >= 2 &&
      ((normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'")))
    ) {
      normalized = normalized.slice(1, -1);
    }
    if (!normalized) throw new Error("Image path must not be empty.");
    const absolutePath = path.isAbsolute(normalized) ? normalized : path.resolve(this.ctx.workspace.root, normalized);
    const imageNumber = nextThreadImageNumber(this.ctx.state.messages, this.ctx.pendingImages);
    assertThreadImageNumberAvailable(imageNumber);
    const attachment = await this.ctx.imageStore.importFile(
      this.ctx.state.threadId,
      `Image #${imageNumber}`,
      absolutePath,
      path.basename(normalized),
    );
    try {
      validateImageAttachmentCollection([...this.ctx.pendingImages, attachment]);
      validateProviderImageAttachments(this.ctx.state.provider, [attachment]);
    } catch (error) {
      await this.ctx.imageStore.remove(this.ctx.state.threadId, attachment).catch(() => undefined);
      throw error;
    }
    this.ctx.pendingImages.push(attachment);
    if (announce) {
      this.ctx.terminal.success(
        translate(readLanguage(this.ctx.storage), "cli.queuedImageFile", {
          label: attachment.label,
          width: attachment.width,
          height: attachment.height,
          mediaType: attachment.mediaType,
        }),
      );
    }
    return attachment;
  }

  async discardImages(images: readonly ImageAttachment[]): Promise<void> {
    await Promise.all(
      images.map((image) => this.ctx.imageStore.remove(this.ctx.state.threadId, image).catch(() => undefined)),
    );
  }

  async clearPendingImages(): Promise<void> {
    const images = this.ctx.pendingImages;
    this.ctx.pendingImages = [];
    await this.discardImages(images);
  }

  nextHostedImageLabel(stagedCount = 0): string {
    const number = nextThreadImageNumber(this.ctx.state.messages, this.ctx.pendingImages) + stagedCount;
    assertThreadImageNumberAvailable(number);
    return `Image #${number}`;
  }

  async importHostedImage(data: Buffer, label: string, sourceName?: string): Promise<ImageAttachment> {
    this.requireCurrentModelVision();
    const image = await this.ctx.imageStore.importBuffer(this.ctx.state.threadId, label, data, sourceName);
    try {
      validateProviderImageAttachments(this.ctx.state.provider, [image]);
      return image;
    } catch (error) {
      await this.ctx.imageStore.remove(this.ctx.state.threadId, image).catch(() => undefined);
      throw error;
    }
  }

  discardHostedImage(image: ImageAttachment): Promise<void> {
    return this.ctx.imageStore.remove(this.ctx.state.threadId, image);
  }

  async importHostedDocument(data: Buffer, filename: string, mediaType: string): Promise<ThreadResourceAttachment> {
    return this.ctx.threadDocumentService.import({
      threadId: this.ctx.state.threadId,
      filename,
      mediaType,
      data,
    });
  }

  hostedDocumentMaxBytes(): number {
    return this.ctx.threadDocumentService.maxBytes;
  }

  discardHostedResource(resource: ThreadResourceAttachment): Promise<void> {
    return this.ctx.threadResourceStore.remove(this.ctx.state.threadId, resource.id);
  }
}
