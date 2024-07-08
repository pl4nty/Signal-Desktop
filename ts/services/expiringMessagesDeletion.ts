// Copyright 2016 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { batch } from 'react-redux';
import { debounce } from 'lodash';

import { clearTimeoutIfNecessary } from '../util/clearTimeoutIfNecessary';
import { sleep } from '../util/sleep';
import { SECOND } from '../util/durations';
import * as Errors from '../types/errors';
import * as log from '../logging/log';

import type { MessageModel } from '../models/messages';
import type { SingleProtoJobQueue } from '../jobs/singleProtoJobQueue';

class ExpiringMessagesDeletionService {
  public update: typeof this.checkExpiringMessages;

  private timeout?: ReturnType<typeof setTimeout>;

  constructor(private readonly singleProtoJobQueue: SingleProtoJobQueue) {
    this.update = debounce(this.checkExpiringMessages, 1000);
  }

  private async destroyExpiredMessages() {
    try {
      window.SignalContext.log.info(
        'destroyExpiredMessages: Loading messages...'
      );
      const messages = await window.Signal.Data.getExpiredMessages();
      window.SignalContext.log.info(
        `destroyExpiredMessages: found ${messages.length} messages to expire`
      );

      const messageIds: Array<string> = [];
      const inMemoryMessages: Array<MessageModel> = [];

      messages.forEach(dbMessage => {
        const message = window.MessageCache.__DEPRECATED$register(
          dbMessage.id,
          dbMessage,
          'destroyExpiredMessages'
        );
        messageIds.push(message.id);
        inMemoryMessages.push(message);
      });

      await window.Signal.Data.removeMessages(messageIds, {
        singleProtoJobQueue: this.singleProtoJobQueue,
      });

      batch(() => {
        inMemoryMessages.forEach(message => {
          window.SignalContext.log.info('Message expired', {
            sentAt: message.get('sent_at'),
          });

          // We do this to update the UI, if this message is being displayed somewhere
          message.trigger('expired');
          window.reduxActions.conversations.messageExpired(message.id);
        });
      });
    } catch (error) {
      window.SignalContext.log.error(
        'destroyExpiredMessages: Error deleting expired messages',
        Errors.toLogFormat(error)
      );
      window.SignalContext.log.info(
        'destroyExpiredMessages: Waiting 30 seconds before trying again'
      );
      await sleep(30 * SECOND);
    }

    window.SignalContext.log.info(
      'destroyExpiredMessages: done, scheduling another check'
    );
    void this.update();
  }

  private async checkExpiringMessages() {
    window.SignalContext.log.info(
      'checkExpiringMessages: checking for expiring messages'
    );

    const soonestExpiry = await window.Signal.Data.getSoonestMessageExpiry();
    if (!soonestExpiry) {
      window.SignalContext.log.info(
        'checkExpiringMessages: found no messages to expire'
      );
      return;
    }

    let wait = soonestExpiry - Date.now();

    // In the past
    if (wait < 0) {
      wait = 0;
    }

    // Too far in the future, since it's limited to a 32-bit value
    if (wait > 2147483647) {
      wait = 2147483647;
    }

    window.SignalContext.log.info(
      `checkExpiringMessages: next message expires ${new Date(
        soonestExpiry
      ).toISOString()}; waiting ${wait} ms before clearing`
    );

    clearTimeoutIfNecessary(this.timeout);
    this.timeout = setTimeout(this.destroyExpiredMessages.bind(this), wait);
  }
}

// Because this service is used inside of Client.ts, it can't directly reference
//   SingleProtoJobQueue. Instead of direct access, it is provided once on startup.
export function initialize(singleProtoJobQueue: SingleProtoJobQueue): void {
  if (instance) {
    log.warn('Expiring Messages Deletion service is already initialized!');
    return;
  }
  instance = new ExpiringMessagesDeletionService(singleProtoJobQueue);
}

export async function update(): Promise<void> {
  if (!instance) {
    throw new Error('Expiring Messages Deletion service not yet initialized!');
  }
  await instance.update();
}

let instance: ExpiringMessagesDeletionService;
