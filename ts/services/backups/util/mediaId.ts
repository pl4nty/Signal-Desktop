// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as Bytes from '../../../Bytes';
import { getBackupKey } from '../crypto';
import type { AttachmentType } from '../../../types/Attachment';
import { deriveMediaIdFromMediaName } from '../../../Crypto';
import { strictAssert } from '../../../util/assert';

export function getMediaIdFromMediaName(mediaName: string): {
  string: string;
  bytes: Uint8Array;
} {
  const mediaIdBytes = deriveMediaIdFromMediaName(getBackupKey(), mediaName);
  return {
    string: Bytes.toBase64url(mediaIdBytes),
    bytes: mediaIdBytes,
  };
}

export function getMediaIdForAttachment(attachment: AttachmentType): {
  string: string;
  bytes: Uint8Array;
} {
  const mediaName = getMediaNameForAttachment(attachment);
  return getMediaIdFromMediaName(mediaName);
}

export function getMediaNameForAttachment(attachment: AttachmentType): string {
  if (attachment.backupLocator) {
    return attachment.backupLocator.mediaName;
  }
  strictAssert(attachment.digest, 'Digest must be present');
  return attachment.digest;
}

export function getBytesFromMediaIdString(mediaId: string): Uint8Array {
  return Bytes.fromBase64url(mediaId);
}

export type GetBackupCdnInfoType = (
  mediaId: string
) => Promise<
  { isInBackupTier: true; cdnNumber: number } | { isInBackupTier: false }
>;

export const getBackupCdnInfo: GetBackupCdnInfoType = async (
  mediaId: string
) => {
  const savedInfo = await window.Signal.Data.getBackupCdnObjectMetadata(
    mediaId
  );
  if (!savedInfo) {
    return { isInBackupTier: false };
  }

  return { isInBackupTier: true, cdnNumber: savedInfo.cdnNumber };
};
