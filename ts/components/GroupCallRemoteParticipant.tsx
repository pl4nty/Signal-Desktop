// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, ReactNode } from 'react';
import React, {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
} from 'react';
import classNames from 'classnames';
import { noop } from 'lodash';
import type { VideoFrameSource } from '@signalapp/ringrtc';
import type { GroupCallRemoteParticipantType } from '../types/Calling';
import type { LocalizerType } from '../types/Util';
import { AvatarColors } from '../types/Colors';
import { CallBackgroundBlur } from './CallBackgroundBlur';
import {
  CallingAudioIndicator,
  SPEAKING_LINGER_MS,
} from './CallingAudioIndicator';
import { Avatar, AvatarSize } from './Avatar';
import { ConfirmationDialog } from './ConfirmationDialog';
import { I18n } from './I18n';
import { ContactName } from './conversation/ContactName';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { MAX_FRAME_HEIGHT, MAX_FRAME_WIDTH } from '../calling/constants';
import { useValueAtFixedRate } from '../hooks/useValueAtFixedRate';
import { Theme } from '../util/theme';
import { isOlderThan } from '../util/timestamp';
import type { CallingImageDataCache } from './CallManager';
import { usePrevious } from '../hooks/usePrevious';

const MAX_TIME_TO_SHOW_STALE_VIDEO_FRAMES = 10000;
const MAX_TIME_TO_SHOW_STALE_SCREENSHARE_FRAMES = 60000;
const DELAY_TO_SHOW_MISSING_MEDIA_KEYS = 5000;

type BasePropsType = {
  getFrameBuffer: () => Buffer;
  getGroupCallVideoFrameSource: (demuxId: number) => VideoFrameSource;
  i18n: LocalizerType;
  imageDataCache: React.RefObject<CallingImageDataCache>;
  isActiveSpeakerInSpeakerView: boolean;
  isCallReconnecting: boolean;
  onClickRaisedHand?: () => void;
  onVisibilityChanged?: (demuxId: number, isVisible: boolean) => unknown;
  remoteParticipant: GroupCallRemoteParticipantType;
  remoteParticipantsCount: number;
};

type InPipPropsType = {
  isInPip: true;
};

type InOverflowAreaPropsType = {
  height: number;
  isInPip?: false;
  audioLevel: number;
  width: number;
};

type InGridPropsType = InOverflowAreaPropsType & {
  left: number;
  top: number;
};

export type PropsType = BasePropsType &
  (InPipPropsType | InOverflowAreaPropsType | InGridPropsType);

export const GroupCallRemoteParticipant: React.FC<PropsType> = React.memo(
  function GroupCallRemoteParticipantInner(props) {
    const {
      getFrameBuffer,
      getGroupCallVideoFrameSource,
      imageDataCache,
      i18n,
      onClickRaisedHand,
      onVisibilityChanged,
      remoteParticipantsCount,
      isActiveSpeakerInSpeakerView,
      isCallReconnecting,
    } = props;

    const {
      acceptedMessageRequest,
      addedTime,
      avatarPath,
      color,
      demuxId,
      hasRemoteAudio,
      hasRemoteVideo,
      isHandRaised,
      isBlocked,
      isMe,
      mediaKeysReceived,
      profileName,
      sharedGroupNames,
      sharingScreen,
      title,
      videoAspectRatio,
    } = props.remoteParticipant;

    const isSpeaking = useValueAtFixedRate(
      !props.isInPip ? props.audioLevel > 0 : false,
      SPEAKING_LINGER_MS
    );
    const previousSharingScreen = usePrevious(sharingScreen, sharingScreen);

    const isImageDataCached =
      sharingScreen && imageDataCache.current?.has(demuxId);
    const [hasReceivedVideoRecently, setHasReceivedVideoRecently] =
      useState(isImageDataCached);
    const [isWide, setIsWide] = useState<boolean>(
      videoAspectRatio ? videoAspectRatio >= 1 : true
    );
    const [showErrorDialog, setShowErrorDialog] = useState(false);

    // We have some state (`hasReceivedVideoRecently`) and this ref. We can't have a
    //   single state value like `lastReceivedVideoAt` because (1) it won't automatically
    //   trigger a re-render after the video has become stale (2) it would cause a full
    //   re-render of the component for every frame, which is way too often.
    //
    // Alternatively, we could create a timeout that's reset every time we get a video
    //   frame (perhaps using a debounce function), but that becomes harder to clean up
    //   when the component unmounts.
    const lastReceivedVideoAt = useRef(-Infinity);
    const remoteVideoRef = useRef<HTMLCanvasElement | null>(null);
    const canvasContextRef = useRef<CanvasRenderingContext2D | null>(null);
    const imageDataRef = useRef<ImageData | null>(null);

    const [intersectionRef, intersectionObserverEntry] =
      useIntersectionObserver();
    const isVisible = intersectionObserverEntry
      ? intersectionObserverEntry.isIntersecting
      : true;

    useEffect(() => {
      onVisibilityChanged?.(demuxId, isVisible);
    }, [demuxId, isVisible, onVisibilityChanged]);

    useEffect(() => {
      if (sharingScreen !== previousSharingScreen) {
        imageDataCache.current?.delete(demuxId);
      }
    }, [demuxId, imageDataCache, previousSharingScreen, sharingScreen]);

    const wantsToShowVideo = hasRemoteVideo && !isBlocked && isVisible;
    const hasVideoToShow = wantsToShowVideo && hasReceivedVideoRecently;
    const showMissingMediaKeys = Boolean(
      !mediaKeysReceived &&
        addedTime &&
        isOlderThan(addedTime, DELAY_TO_SHOW_MISSING_MEDIA_KEYS)
    );

    const videoFrameSource = useMemo(
      () => getGroupCallVideoFrameSource(demuxId),
      [getGroupCallVideoFrameSource, demuxId]
    );

    const renderVideoFrame = useCallback(() => {
      const frameAge = Date.now() - lastReceivedVideoAt.current;
      const maxFrameAge = sharingScreen
        ? MAX_TIME_TO_SHOW_STALE_SCREENSHARE_FRAMES
        : MAX_TIME_TO_SHOW_STALE_VIDEO_FRAMES;
      if (frameAge > maxFrameAge) {
        // We consider that we have received video recently from a remote participant if
        // we have received it recently relative to the last time we had a connection. If
        // we lost their video due to our reconnecting, we still want to show the last
        // frame of video (blurred out) until we have reconnected.
        if (!isCallReconnecting) {
          setHasReceivedVideoRecently(false);
        }
      }

      const canvasEl = remoteVideoRef.current;
      if (!canvasEl) {
        return;
      }

      const canvasContext = canvasContextRef.current;
      if (!canvasContext) {
        return;
      }

      // This frame buffer is shared by all participants, so it may contain pixel data
      //   for other participants, or pixel data from a previous frame. That's why we
      //   return early and use the `frameWidth` and `frameHeight`.
      let frameWidth: number | undefined;
      let frameHeight: number | undefined;
      let imageData = imageDataRef.current;

      const frameBuffer = getFrameBuffer();
      const frameDimensions = videoFrameSource.receiveVideoFrame(
        frameBuffer,
        MAX_FRAME_WIDTH,
        MAX_FRAME_HEIGHT
      );
      if (frameDimensions) {
        [frameWidth, frameHeight] = frameDimensions;

        if (
          frameWidth < 2 ||
          frameHeight < 2 ||
          frameWidth > MAX_FRAME_WIDTH ||
          frameHeight > MAX_FRAME_HEIGHT
        ) {
          return;
        }

        if (
          imageData?.width !== frameWidth ||
          imageData?.height !== frameHeight
        ) {
          imageData = new ImageData(frameWidth, frameHeight);
          imageDataRef.current = imageData;
        }
        imageData.data.set(
          frameBuffer.subarray(0, frameWidth * frameHeight * 4)
        );

        // Screen share is at a slow FPS so updates slowly if we PiP then restore.
        // Cache the image data so we can quickly show the most recent frame.
        if (sharingScreen) {
          imageDataCache.current?.set(demuxId, imageData);
        }
      } else if (sharingScreen && !imageData) {
        // Try to use the screenshare cache the first time we show
        const cachedImageData = imageDataCache.current?.get(demuxId);
        if (cachedImageData) {
          frameWidth = cachedImageData.width;
          frameHeight = cachedImageData.height;
          imageDataRef.current = cachedImageData;
          imageData = cachedImageData;
        }
      }

      if (!frameWidth || !frameHeight || !imageData) {
        return;
      }

      canvasEl.width = frameWidth;
      canvasEl.height = frameHeight;
      canvasContext.putImageData(imageData, 0, 0);
      lastReceivedVideoAt.current = Date.now();

      setHasReceivedVideoRecently(true);
      setIsWide(frameWidth > frameHeight);
    }, [
      demuxId,
      imageDataCache,
      isCallReconnecting,
      sharingScreen,
      videoFrameSource,
      getFrameBuffer,
    ]);

    useEffect(() => {
      if (!hasRemoteVideo) {
        setHasReceivedVideoRecently(false);
      }
    }, [hasRemoteVideo]);

    useEffect(() => {
      if (!hasRemoteVideo || !isVisible) {
        return noop;
      }

      let rafId = requestAnimationFrame(tick);

      function tick() {
        renderVideoFrame();
        rafId = requestAnimationFrame(tick);
      }

      return () => {
        cancelAnimationFrame(rafId);
      };
    }, [hasRemoteVideo, isVisible, renderVideoFrame, videoFrameSource]);

    let canvasStyles: CSSProperties;
    let containerStyles: CSSProperties;

    // If our `width` and `height` props don't match the canvas's aspect ratio, we want to
    //   fill the container. This can happen when RingRTC gives us an inaccurate
    //   `videoAspectRatio`, or if the container is an unexpected size.
    if (isWide) {
      canvasStyles = { width: '100%' };
    } else {
      canvasStyles = { height: '100%' };
    }

    let avatarSize: number;
    let footerInfoElement: ReactNode;

    if (props.isInPip) {
      containerStyles = canvasStyles;
      avatarSize = AvatarSize.FORTY_EIGHT;
    } else {
      const { width, height } = props;
      const shorterDimension = Math.min(width, height);

      if (shorterDimension >= 180) {
        avatarSize = AvatarSize.NINETY_SIX;
      } else {
        avatarSize = AvatarSize.FORTY_EIGHT;
      }

      containerStyles = {
        height,
        width,
      };

      if ('top' in props) {
        containerStyles.position = 'absolute';
        containerStyles.insetInlineStart = `${props.left}px`;
        containerStyles.top = `${props.top}px`;
      }

      const nameElement = (
        <ContactName
          module="module-ongoing-call__group-call-remote-participant__info__contact-name"
          title={title}
        />
      );

      if (isHandRaised) {
        footerInfoElement = (
          <button
            className="module-ongoing-call__group-call-remote-participant__info module-ongoing-call__group-call-remote-participant__info--clickable"
            onClick={onClickRaisedHand}
            type="button"
          >
            <div className="CallingStatusIndicator CallingStatusIndicator--HandRaised" />
            {nameElement}
          </button>
        );
      } else {
        footerInfoElement = (
          <div className="module-ongoing-call__group-call-remote-participant__info">
            {nameElement}
          </div>
        );
      }
    }

    let noVideoNode: ReactNode;
    if (!hasVideoToShow) {
      const showDialogButton = (
        <button
          type="button"
          className="module-ongoing-call__group-call-remote-participant__more-info"
          onClick={() => {
            setShowErrorDialog(true);
          }}
        >
          {i18n('icu:moreInfo')}
        </button>
      );
      if (isBlocked) {
        noVideoNode = (
          <>
            <i className="module-ongoing-call__group-call-remote-participant__error-icon module-ongoing-call__group-call-remote-participant__error-icon--blocked" />
            {showDialogButton}
          </>
        );
      } else if (showMissingMediaKeys) {
        noVideoNode = (
          <>
            <i className="module-ongoing-call__group-call-remote-participant__error-icon module-ongoing-call__group-call-remote-participant__error-icon--missing-media-keys" />
            <div className="module-ongoing-call__group-call-remote-participant__error">
              {i18n('icu:calling__missing-media-keys', { name: title })}
            </div>
            {showDialogButton}
          </>
        );
      } else {
        noVideoNode = (
          <Avatar
            acceptedMessageRequest={acceptedMessageRequest}
            avatarPath={avatarPath}
            badge={undefined}
            color={color || AvatarColors[0]}
            noteToSelf={false}
            conversationType="direct"
            i18n={i18n}
            isMe={isMe}
            profileName={profileName}
            title={title}
            sharedGroupNames={sharedGroupNames}
            size={avatarSize}
          />
        );
      }
    }

    // Error dialog maintains state, so if you have it open and the underlying
    // error changes or resolves, you can keep reading the same dialog info.
    const [errorDialogTitle, setErrorDialogTitle] = useState<ReactNode | null>(
      null
    );
    const [errorDialogBody, setErrorDialogBody] = useState<string>('');
    useEffect(() => {
      if (hasVideoToShow || showErrorDialog) {
        return;
      }

      if (isBlocked) {
        setErrorDialogTitle(
          <div className="module-ongoing-call__group-call-remote-participant__more-info-modal-title">
            <I18n
              i18n={i18n}
              id="icu:calling__you-have-blocked"
              components={{
                name: <ContactName key="name" title={title} />,
              }}
            />
          </div>
        );
        setErrorDialogBody(i18n('icu:calling__block-info'));
      } else if (showMissingMediaKeys) {
        setErrorDialogTitle(
          <div className="module-ongoing-call__group-call-remote-participant__more-info-modal-title">
            <I18n
              i18n={i18n}
              id="icu:calling__missing-media-keys"
              components={{
                name: <ContactName key="name" title={title} />,
              }}
            />
          </div>
        );
        setErrorDialogBody(i18n('icu:calling__missing-media-keys-info'));
      } else {
        setErrorDialogTitle(null);
        setErrorDialogBody('');
      }
    }, [
      hasVideoToShow,
      i18n,
      isBlocked,
      showErrorDialog,
      showMissingMediaKeys,
      title,
    ]);

    return (
      <>
        {showErrorDialog && (
          <ConfirmationDialog
            dialogName="GroupCallRemoteParticipant.blockInfo"
            cancelText={i18n('icu:ok')}
            i18n={i18n}
            onClose={() => setShowErrorDialog(false)}
            theme={Theme.Dark}
            title={errorDialogTitle}
          >
            {errorDialogBody}
          </ConfirmationDialog>
        )}

        <div
          className={classNames(
            'module-ongoing-call__group-call-remote-participant',
            isSpeaking &&
              !isActiveSpeakerInSpeakerView &&
              remoteParticipantsCount > 1 &&
              'module-ongoing-call__group-call-remote-participant--speaking',
            isHandRaised &&
              'module-ongoing-call__group-call-remote-participant--hand-raised'
          )}
          ref={intersectionRef}
          style={containerStyles}
        >
          {!props.isInPip && (
            <>
              <CallingAudioIndicator
                hasAudio={hasRemoteAudio}
                audioLevel={props.audioLevel}
                shouldShowSpeaking={isSpeaking}
              />
              <div className="module-ongoing-call__group-call-remote-participant__footer">
                {footerInfoElement}
              </div>
            </>
          )}
          {wantsToShowVideo && (
            <canvas
              className={classNames(
                'module-ongoing-call__group-call-remote-participant__remote-video',
                isCallReconnecting &&
                  'module-ongoing-call__group-call-remote-participant__remote-video--reconnecting'
              )}
              style={{
                ...canvasStyles,
                // If we want to show video but don't have any yet, we still render the
                //   canvas invisibly. This lets us render frame data immediately without
                //   having to juggle anything.
                ...(hasVideoToShow ? {} : { display: 'none' }),
              }}
              ref={canvasEl => {
                remoteVideoRef.current = canvasEl;
                if (canvasEl) {
                  canvasContextRef.current = canvasEl.getContext('2d');
                } else {
                  canvasContextRef.current = null;
                }
              }}
            />
          )}
          {noVideoNode && (
            <CallBackgroundBlur
              avatarPath={avatarPath}
              className="module-ongoing-call__group-call-remote-participant-background"
            >
              {noVideoNode}
            </CallBackgroundBlur>
          )}
        </div>
      </>
    );
  }
);
