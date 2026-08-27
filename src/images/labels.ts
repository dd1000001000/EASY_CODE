import type { ChatMessage, ImageAttachment } from "../core/types.js";

const IMAGE_LABEL = /^Image #([1-9][0-9]{0,2})$/u;
export const MAX_THREAD_IMAGE_NUMBER = 999;

export function imageLabelNumber(image: Pick<ImageAttachment, "label">): number {
  const match = IMAGE_LABEL.exec(image.label);
  if (!match) throw new Error(`Invalid image label: ${image.label}`);
  return Number.parseInt(match[1] ?? "", 10);
}

/**
 * Return the next thread-wide image number so labels remain unambiguous after
 * resume. `MAX_THREAD_IMAGE_NUMBER + 1` is a valid exhausted-state sentinel;
 * callers must enforce the limit only when they are about to create an image.
 */
export function nextThreadImageNumber(
  messages: readonly ChatMessage[],
  pending: readonly ImageAttachment[] = [],
): number {
  let maximum = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const image of message.images ?? []) {
      maximum = Math.max(maximum, imageLabelNumber(image));
    }
  }
  for (const image of pending) {
    maximum = Math.max(maximum, imageLabelNumber(image));
  }
  return maximum + 1;
}

export function assertThreadImageNumberAvailable(imageNumber: number): void {
  if (!Number.isInteger(imageNumber) || imageNumber < 1) {
    throw new Error("Image number must be a positive integer.");
  }
  if (imageNumber > MAX_THREAD_IMAGE_NUMBER) {
    throw new Error("This thread has reached the 999 image attachment limit.");
  }
}
