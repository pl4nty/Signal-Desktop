// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChangeEvent } from 'react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Index, IndexRange, ListRowProps } from 'react-virtualized';
import { InfiniteLoader, List } from 'react-virtualized';
import classNames from 'classnames';
import type { LocalizerType } from '../types/I18N';
import { ListTile } from './ListTile';
import { Avatar, AvatarSize } from './Avatar';
import { SearchInput } from './SearchInput';
import type {
  CallHistoryFilterOptions,
  CallHistoryGroup,
  CallHistoryPagination,
} from '../types/CallDisposition';
import {
  CallHistoryFilterStatus,
  CallDirection,
  CallType,
  DirectCallStatus,
  GroupCallStatus,
  isSameCallHistoryGroup,
} from '../types/CallDisposition';
import { formatDateTimeShort, isMoreRecentThan } from '../util/timestamp';
import type { ConversationType } from '../state/ducks/conversations';
import * as log from '../logging/log';
import { refMerger } from '../util/refMerger';
import { drop } from '../util/drop';
import { strictAssert } from '../util/assert';
import { UserText } from './UserText';
import { I18n } from './I18n';
import { NavSidebarSearchHeader } from './NavSidebar';
import { SizeObserver } from '../hooks/useSizeObserver';
import {
  formatCallHistoryGroup,
  getCallIdFromEra,
} from '../util/callDisposition';
import { CallsNewCallButton } from './CallsNewCall';
import { Tooltip, TooltipPlacement } from './Tooltip';
import { Theme } from '../util/theme';
import type { CallingConversationType } from '../types/Calling';
import { CallMode } from '../types/Calling';
import type { CallLinkType } from '../types/CallLink';
import {
  callLinkToConversation,
  getPlaceholderCallLinkConversation,
} from '../util/callLinks';
import type { CallsTabSelectedView } from './CallsTab';
import type { CallStateType } from '../state/selectors/calling';
import {
  isGroupOrAdhocCallMode,
  isGroupOrAdhocCallState,
} from '../util/isGroupOrAdhocCall';
import { isAnybodyInGroupCall } from '../state/ducks/callingHelpers';
import type {
  ActiveCallStateType,
  PeekNotConnectedGroupCallType,
} from '../state/ducks/calling';
import { DAY, MINUTE, SECOND } from '../util/durations';
import { ConfirmationDialog } from './ConfirmationDialog';

function Timestamp({
  i18n,
  timestamp,
}: {
  i18n: LocalizerType;
  timestamp: number;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  const dateTime = useMemo(() => {
    return new Date(timestamp).toISOString();
  }, [timestamp]);

  const formatted = useMemo(() => {
    void now; // Use this as a dep so we update
    return formatDateTimeShort(i18n, timestamp);
  }, [i18n, timestamp, now]);

  return <time dateTime={dateTime}>{formatted}</time>;
}

type SearchResults = Readonly<{
  count: number;
  items: ReadonlyArray<CallHistoryGroup>;
}>;

type SearchState = Readonly<{
  state: 'init' | 'pending' | 'rejected' | 'fulfilled';
  // Note these fields shouldnt be updated until the search is fulfilled or rejected.
  options: null | { query: string; status: CallHistoryFilterStatus };
  results: null | SearchResults;
}>;

const defaultInitState: SearchState = {
  state: 'init',
  options: null,
  results: null,
};

const defaultPendingState: SearchState = {
  state: 'pending',
  options: null,
  results: {
    count: 100,
    items: [],
  },
};

type CallsListProps = Readonly<{
  activeCall: ActiveCallStateType | undefined;
  canCreateCallLinks: boolean;
  getCallHistoryGroupsCount: (
    options: CallHistoryFilterOptions
  ) => Promise<number>;
  getCallHistoryGroups: (
    options: CallHistoryFilterOptions,
    pagination: CallHistoryPagination
  ) => Promise<Array<CallHistoryGroup>>;
  callHistoryEdition: number;
  getAdhocCall: (roomId: string) => CallStateType | undefined;
  getCall: (id: string) => CallStateType | undefined;
  getCallLink: (id: string) => CallLinkType | undefined;
  getConversation: (id: string) => ConversationType | void;
  hangUpActiveCall: (reason: string) => void;
  i18n: LocalizerType;
  selectedCallHistoryGroup: CallHistoryGroup | null;
  onCreateCallLink: () => void;
  onOutgoingAudioCallInConversation: (conversationId: string) => void;
  onOutgoingVideoCallInConversation: (conversationId: string) => void;
  onChangeCallsTabSelectedView: (selectedView: CallsTabSelectedView) => void;
  peekNotConnectedGroupCall: (options: PeekNotConnectedGroupCallType) => void;
  startCallLinkLobbyByRoomId: (roomId: string) => void;
  togglePip: () => void;
}>;

const CALL_LIST_ITEM_ROW_HEIGHT = 62;
const INACTIVE_CALL_LINKS_TO_PEEK = 10;
const INACTIVE_CALL_LINK_AGE_THRESHOLD = 10 * DAY;
const INACTIVE_CALL_LINK_PEEK_INTERVAL = 5 * MINUTE;
const PEEK_BATCH_COUNT = 10;
const PEEK_QUEUE_INTERVAL = 30 * SECOND;

function isSameOptions(
  a: CallHistoryFilterOptions,
  b: CallHistoryFilterOptions
) {
  return a.query === b.query && a.status === b.status;
}

type SpecialRows = 'CreateCallLink' | 'EmptyState';
type Row = CallHistoryGroup | SpecialRows;

export function CallsList({
  activeCall,
  canCreateCallLinks,
  getCallHistoryGroupsCount,
  getCallHistoryGroups,
  callHistoryEdition,
  getAdhocCall,
  getCall,
  getCallLink,
  getConversation,
  hangUpActiveCall,
  i18n,
  selectedCallHistoryGroup,
  onCreateCallLink,
  onOutgoingAudioCallInConversation,
  onOutgoingVideoCallInConversation,
  onChangeCallsTabSelectedView,
  peekNotConnectedGroupCall,
  startCallLinkLobbyByRoomId,
  togglePip,
}: CallsListProps): JSX.Element {
  const infiniteLoaderRef = useRef<InfiniteLoader>(null);
  const listRef = useRef<List>(null);
  const [queryInput, setQueryInput] = useState('');
  const [statusInput, setStatusInput] = useState(CallHistoryFilterStatus.All);
  const [searchState, setSearchState] = useState(defaultInitState);
  const [isLeaveCallDialogVisible, setIsLeaveCallDialogVisible] =
    useState(false);

  const prevOptionsRef = useRef<CallHistoryFilterOptions | null>(null);

  const getCallHistoryGroupsCountRef = useRef(getCallHistoryGroupsCount);
  const getCallHistoryGroupsRef = useRef(getCallHistoryGroups);

  const searchStateQuery = searchState.options?.query ?? '';
  const searchStateStatus =
    searchState.options?.status ?? CallHistoryFilterStatus.All;
  const searchFiltering =
    searchStateQuery !== '' ||
    searchStateStatus !== CallHistoryFilterStatus.All;
  const searchPending = searchState.state === 'pending';

  const rows = useMemo(() => {
    let results: ReadonlyArray<Row> = searchState.results?.items ?? [];
    if (results.length === 0) {
      results = ['EmptyState'];
    }
    if (!searchFiltering && canCreateCallLinks) {
      results = ['CreateCallLink', ...results];
    }
    return results;
  }, [searchState.results?.items, searchFiltering, canCreateCallLinks]);

  const rowCount = rows.length;

  const searchStateItemsRef = useRef<ReadonlyArray<CallHistoryGroup> | null>(
    null
  );
  const peekQueueRef = useRef<Set<string>>(new Set());
  const peekQueueArgsRef = useRef<Map<string, PeekNotConnectedGroupCallType>>(
    new Map()
  );
  const inactiveCallLinksPeekedAtRef = useRef<Map<string, number>>(new Map());
  const peekQueueTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (peekQueueTimerRef.current != null) {
        clearInterval(peekQueueTimerRef.current);
        peekQueueTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    getCallHistoryGroupsCountRef.current = getCallHistoryGroupsCount;
    getCallHistoryGroupsRef.current = getCallHistoryGroups;
  }, [getCallHistoryGroupsCount, getCallHistoryGroups]);

  const getConversationForItem = useCallback(
    (item: CallHistoryGroup | null): CallingConversationType | null => {
      if (!item) {
        return null;
      }

      const isAdhoc = item?.type === CallType.Adhoc;
      if (isAdhoc) {
        const callLink = isAdhoc ? getCallLink(item.peerId) : null;
        if (callLink) {
          return callLinkToConversation(callLink, i18n);
        }
        return getPlaceholderCallLinkConversation(item.peerId, i18n);
      }

      return getConversation(item.peerId) ?? null;
    },
    [getCallLink, getConversation, i18n]
  );

  const getCallByPeerId = useCallback(
    ({
      mode,
      peerId,
    }: {
      mode: CallMode | undefined;
      peerId: string | undefined;
    }): CallStateType | undefined => {
      if (!peerId || !mode) {
        return;
      }

      if (mode === CallMode.Adhoc) {
        return getAdhocCall(peerId);
      }

      const conversation = getConversation(peerId);
      if (!conversation) {
        return;
      }

      return getCall(conversation.id);
    },
    [getAdhocCall, getCall, getConversation]
  );

  const getIsCallActive = useCallback(
    ({
      callHistoryGroup,
    }: {
      callHistoryGroup: CallHistoryGroup | null;
    }): boolean => {
      if (!callHistoryGroup) {
        return false;
      }

      const { mode, peerId } = callHistoryGroup;
      const call = getCallByPeerId({ mode, peerId });
      if (!call) {
        return false;
      }

      if (isGroupOrAdhocCallState(call)) {
        if (!isAnybodyInGroupCall(call.peekInfo)) {
          return false;
        }

        if (mode === CallMode.Group) {
          const eraId = call.peekInfo?.eraId;
          if (!eraId) {
            return false;
          }

          const callId = getCallIdFromEra(eraId);
          return callHistoryGroup.children.some(
            groupItem => groupItem.callId === callId
          );
        }

        return true;
      }

      // Direct is not supported currently
      return false;
    },
    [getCallByPeerId]
  );

  const getIsInCall = useCallback(
    ({
      activeCallConversationId,
      callHistoryGroup,
      conversation,
      isActive,
    }: {
      activeCallConversationId: string | undefined;
      callHistoryGroup: CallHistoryGroup | null;
      conversation: CallingConversationType | null;
      isActive: boolean;
    }): boolean => {
      if (!callHistoryGroup) {
        return false;
      }

      const { mode, peerId } = callHistoryGroup;

      if (mode === CallMode.Adhoc) {
        return peerId === activeCallConversationId;
      }

      // Not supported currently
      if (mode === CallMode.Direct) {
        return false;
      }

      // Group
      return Boolean(
        isActive &&
          conversation &&
          conversation?.id === activeCallConversationId
      );
    },
    []
  );

  // If the call is already enqueued then this is a no op.
  const maybeEnqueueCallPeek = useCallback((item: CallHistoryGroup): void => {
    const { mode: callMode, peerId } = item;
    const queue = peekQueueRef.current;
    if (queue.has(peerId)) {
      return;
    }

    if (isGroupOrAdhocCallMode(callMode)) {
      peekQueueArgsRef.current.set(peerId, {
        callMode,
        conversationId: peerId,
      });
      queue.add(peerId);
    } else {
      log.error(`Trying to peek unsupported call mode ${callMode}`);
    }
  }, []);

  // Get the oldest inserted peerIds by iterating the Set in insertion order.
  const getPeerIdsToPeek = useCallback((): ReadonlyArray<string> => {
    const peerIds: Array<string> = [];
    for (const peerId of peekQueueRef.current) {
      peerIds.push(peerId);
      if (peerIds.length === PEEK_BATCH_COUNT) {
        return peerIds;
      }
    }

    return peerIds;
  }, []);

  const doCallPeeks = useCallback((): void => {
    const peerIds = getPeerIdsToPeek();
    for (const peerId of peerIds) {
      const peekArgs = peekQueueArgsRef.current.get(peerId);
      if (peekArgs) {
        inactiveCallLinksPeekedAtRef.current.set(peerId, new Date().getTime());
        peekNotConnectedGroupCall(peekArgs);
      }

      peekQueueRef.current.delete(peerId);
      peekQueueArgsRef.current.delete(peerId);
    }
  }, [getPeerIdsToPeek, peekNotConnectedGroupCall]);

  const enqueueCallPeeks = useCallback(
    (callItems: ReadonlyArray<CallHistoryGroup>, isFirstRun: boolean): void => {
      let peekCount = 0;
      let inactiveCallLinksToPeek = 0;
      for (const item of callItems) {
        const { mode } = item;
        if (isGroupOrAdhocCallMode(mode)) {
          const isActive = getIsCallActive({ callHistoryGroup: item });

          if (isActive) {
            // Don't peek if you're already in the call.
            const activeCallConversationId = activeCall?.conversationId;
            if (activeCallConversationId) {
              const conversation = getConversationForItem(item);
              const isInCall = getIsInCall({
                activeCallConversationId,
                callHistoryGroup: item,
                conversation,
                isActive,
              });
              if (isInCall) {
                continue;
              }
            }

            maybeEnqueueCallPeek(item);
            peekCount += 1;
            continue;
          }

          if (
            mode === CallMode.Adhoc &&
            isFirstRun &&
            inactiveCallLinksToPeek < INACTIVE_CALL_LINKS_TO_PEEK &&
            isMoreRecentThan(item.timestamp, INACTIVE_CALL_LINK_AGE_THRESHOLD)
          ) {
            const peekedAt = inactiveCallLinksPeekedAtRef.current.get(
              item.peerId
            );
            if (
              peekedAt &&
              isMoreRecentThan(peekedAt, INACTIVE_CALL_LINK_PEEK_INTERVAL)
            ) {
              continue;
            }

            maybeEnqueueCallPeek(item);
            inactiveCallLinksToPeek += 1;
            peekCount += 1;
          }
        }
      }

      if (peekCount === 0) {
        return;
      }
      log.info(`Found ${peekCount} calls to peek.`);

      if (peekQueueTimerRef.current != null) {
        return;
      }

      log.info('Starting background call peek.');
      peekQueueTimerRef.current = setInterval(() => {
        if (searchStateItemsRef.current) {
          enqueueCallPeeks(searchStateItemsRef.current, false);
        }

        if (peekQueueRef.current.size > 0) {
          doCallPeeks();
        }
      }, PEEK_QUEUE_INTERVAL);

      doCallPeeks();
    },
    [
      activeCall?.conversationId,
      doCallPeeks,
      getConversationForItem,
      getIsCallActive,
      getIsInCall,
      maybeEnqueueCallPeek,
    ]
  );

  useEffect(() => {
    const controller = new AbortController();

    async function search() {
      const options: CallHistoryFilterOptions = {
        query: queryInput.toLowerCase().normalize().trim(),
        status: statusInput,
      };

      let timer = setTimeout(() => {
        setSearchState(prevSearchState => {
          if (prevSearchState.state === 'init') {
            return defaultPendingState;
          }
          return prevSearchState;
        });
        timer = setTimeout(() => {
          // Show loading indicator after a delay
          setSearchState(defaultPendingState);
        }, 300);
      }, 50);

      let results: SearchResults | null = null;

      try {
        const [count, items] = await Promise.all([
          getCallHistoryGroupsCountRef.current(options),
          getCallHistoryGroupsRef.current(options, {
            offset: 0,
            limit: 100, // preloaded rows
          }),
        ]);
        results = { count, items };
      } catch (error) {
        log.error('CallsList#fetchTotal error fetching', error);
      }

      // Clear the loading indicator timeout
      clearTimeout(timer);

      // Ignore old requests
      if (controller.signal.aborted) {
        return;
      }

      if (results) {
        enqueueCallPeeks(results.items, true);
        searchStateItemsRef.current = results.items;
      }

      // Only commit the new search state once the results are ready
      setSearchState({
        state: results == null ? 'rejected' : 'fulfilled',
        options,
        results,
      });

      const isUpdatingSameSearch =
        prevOptionsRef.current != null &&
        isSameOptions(options, prevOptionsRef.current);

      // Commit only at the end in case the search was aborted.
      prevOptionsRef.current = options;

      // Only reset the scroll position to the top when the user has changed the
      // search parameters
      if (!isUpdatingSameSearch) {
        infiniteLoaderRef.current?.resetLoadMoreRowsCache(true);
        listRef.current?.scrollToPosition(0);
      }
    }

    drop(search());

    return () => {
      controller.abort();
    };
  }, [queryInput, statusInput, callHistoryEdition, enqueueCallPeeks]);

  const loadMoreRows = useCallback(
    async (props: IndexRange) => {
      const { state, options } = searchState;
      if (state !== 'fulfilled') {
        return;
      }
      strictAssert(
        options != null,
        'options should never be null when status is fulfilled'
      );

      let { startIndex, stopIndex } = props;

      if (startIndex > stopIndex) {
        // flip
        [startIndex, stopIndex] = [stopIndex, startIndex];
      }

      const offset = startIndex;
      const limit = stopIndex - startIndex + 1;

      try {
        const groups = await getCallHistoryGroupsRef.current(options, {
          offset,
          limit,
        });

        if (searchState.options !== options) {
          return;
        }

        enqueueCallPeeks(groups, false);

        setSearchState(prevSearchState => {
          strictAssert(
            prevSearchState.results != null,
            'results should never be null here'
          );
          const newItems = prevSearchState.results.items.slice();
          newItems.splice(startIndex, stopIndex, ...groups);
          searchStateItemsRef.current = newItems;
          return {
            ...prevSearchState,
            results: {
              ...prevSearchState.results,
              items: newItems,
            },
          };
        });
      } catch (error) {
        log.error('CallsList#loadMoreRows error fetching', error);
      }
    },
    [enqueueCallPeeks, searchState]
  );

  const isRowLoaded = useCallback(
    (props: Index) => {
      return searchState.results?.items[props.index] != null;
    },
    [searchState]
  );

  const rowHeight = useCallback(
    ({ index }: Index) => {
      const item = rows.at(index) ?? null;

      if (item === 'EmptyState') {
        // arbitary large number so the empty state can be as big as it wants,
        // scrolling should always be locked when the list is empty
        return 9999;
      }

      return CALL_LIST_ITEM_ROW_HEIGHT;
    },
    [rows]
  );

  const rowRenderer = useCallback(
    ({ key, index, style }: ListRowProps) => {
      const item = rows.at(index) ?? null;

      if (item === 'CreateCallLink') {
        return (
          <div key={key} style={style}>
            <ListTile
              moduleClassName="CallsList__ItemTile"
              title={
                <span className="CallsList__ItemTitle">
                  {i18n('icu:CallsList__CreateCallLink')}
                </span>
              }
              leading={
                <Avatar
                  acceptedMessageRequest
                  conversationType="callLink"
                  i18n={i18n}
                  isMe={false}
                  title=""
                  sharedGroupNames={[]}
                  size={AvatarSize.THIRTY_SIX}
                  badge={undefined}
                  className="CallsList__ItemAvatar"
                />
              }
              onClick={onCreateCallLink}
            />
          </div>
        );
      }

      if (item === 'EmptyState') {
        return (
          <div key={key} className="CallsList__EmptyState" style={style}>
            {searchStateQuery === '' ? (
              i18n('icu:CallsList__EmptyState--noQuery')
            ) : (
              <I18n
                i18n={i18n}
                id="icu:CallsList__EmptyState--hasQuery"
                components={{
                  query: <UserText text={searchStateQuery} />,
                }}
              />
            )}
          </div>
        );
      }

      const conversation = getConversationForItem(item);
      const activeCallConversationId = activeCall?.conversationId;

      const isActive = getIsCallActive({
        callHistoryGroup: item,
      });
      const isInCall = getIsInCall({
        activeCallConversationId,
        callHistoryGroup: item,
        conversation,
        isActive,
      });

      const isAdhoc = item?.type === CallType.Adhoc;
      const isCallButtonVisible = Boolean(
        !isAdhoc || (isAdhoc && getCallLink(item.peerId))
      );
      const isActiveVisible = Boolean(isCallButtonVisible && item && isActive);

      if (searchPending || item == null || conversation == null) {
        return (
          <div key={key} style={style}>
            <ListTile
              moduleClassName="CallsList__ItemTile"
              leading={<div className="CallsList__LoadingAvatar" />}
              title={
                <span className="CallsList__LoadingText CallsList__LoadingText--title" />
              }
              subtitleMaxLines={1}
              subtitle={
                <span className="CallsList__LoadingText CallsList__LoadingText--subtitle" />
              }
            />
          </div>
        );
      }

      const isSelected =
        selectedCallHistoryGroup != null &&
        isSameCallHistoryGroup(item, selectedCallHistoryGroup);

      const wasMissed =
        item.direction === CallDirection.Incoming &&
        (item.status === DirectCallStatus.Missed ||
          item.status === GroupCallStatus.Missed);

      let statusText;
      if (wasMissed) {
        statusText = i18n('icu:CallsList__ItemCallInfo--Missed');
      } else if (isAdhoc) {
        statusText = i18n('icu:CallsList__ItemCallInfo--CallLink');
      } else if (item.type === CallType.Group) {
        statusText = i18n('icu:CallsList__ItemCallInfo--GroupCall');
      } else if (item.direction === CallDirection.Outgoing) {
        statusText = i18n('icu:CallsList__ItemCallInfo--Outgoing');
      } else if (item.direction === CallDirection.Incoming) {
        statusText = i18n('icu:CallsList__ItemCallInfo--Incoming');
      } else {
        strictAssert(false, 'Cannot format call');
      }

      return (
        <div
          key={key}
          style={style}
          data-type={item.type}
          className={classNames('CallsList__Item', {
            'CallsList__Item--selected': isSelected,
            'CallsList__Item--missed': wasMissed,
          })}
        >
          <ListTile
            moduleClassName="CallsList__ItemTile"
            aria-selected={isSelected}
            leading={
              <Avatar
                acceptedMessageRequest
                avatarPath={conversation.avatarPath}
                color={conversation.color}
                conversationType={conversation.type}
                i18n={i18n}
                isMe={false}
                title={conversation.title}
                sharedGroupNames={[]}
                size={AvatarSize.THIRTY_SIX}
                badge={undefined}
                className="CallsList__ItemAvatar"
              />
            }
            trailing={
              isCallButtonVisible ? (
                <CallsNewCallButton
                  callType={item.type}
                  isActive={isActiveVisible}
                  isInCall={isInCall}
                  isEnabled={isInCall || !activeCall}
                  onClick={() => {
                    if (isInCall) {
                      togglePip();
                    } else if (activeCall) {
                      if (isActiveVisible) {
                        setIsLeaveCallDialogVisible(true);
                      }
                    } else if (isAdhoc) {
                      startCallLinkLobbyByRoomId(item.peerId);
                    } else if (conversation) {
                      if (item.type === CallType.Audio) {
                        onOutgoingAudioCallInConversation(conversation.id);
                      } else {
                        onOutgoingVideoCallInConversation(conversation.id);
                      }
                    }
                  }}
                  i18n={i18n}
                />
              ) : undefined
            }
            title={
              <span
                className="CallsList__ItemTitle"
                data-call={formatCallHistoryGroup(item)}
              >
                <UserText text={conversation.title} />
              </span>
            }
            subtitleMaxLines={1}
            subtitle={
              <span className="CallsList__ItemCallInfo">
                {item.children.length > 1 ? `(${item.children.length}) ` : ''}
                {statusText} &middot;{' '}
                {isActiveVisible ? (
                  i18n('icu:CallsList__ItemCallInfo--Active')
                ) : (
                  <Timestamp i18n={i18n} timestamp={item.timestamp} />
                )}
              </span>
            }
            onClick={() => {
              if (isAdhoc) {
                onChangeCallsTabSelectedView({
                  type: 'callLink',
                  roomId: item.peerId,
                  callHistoryGroup: item,
                });
                return;
              }

              if (conversation == null) {
                return;
              }
              onChangeCallsTabSelectedView({
                type: 'conversation',
                conversationId: conversation.id,
                callHistoryGroup: item,
              });
            }}
          />
        </div>
      );
    },
    [
      activeCall,
      rows,
      searchStateQuery,
      searchPending,
      getCallLink,
      getConversationForItem,
      getIsCallActive,
      getIsInCall,
      selectedCallHistoryGroup,
      onChangeCallsTabSelectedView,
      onCreateCallLink,
      onOutgoingAudioCallInConversation,
      onOutgoingVideoCallInConversation,
      startCallLinkLobbyByRoomId,
      togglePip,
      i18n,
    ]
  );

  const handleSearchInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setQueryInput(event.target.value);
    },
    []
  );

  const handleSearchInputClear = useCallback(() => {
    setQueryInput('');
  }, []);

  const handleStatusToggle = useCallback(() => {
    setStatusInput(prevStatus => {
      return prevStatus === CallHistoryFilterStatus.All
        ? CallHistoryFilterStatus.Missed
        : CallHistoryFilterStatus.All;
    });
  }, []);

  return (
    <>
      {isLeaveCallDialogVisible && (
        <ConfirmationDialog
          dialogName="GroupCallRemoteParticipant.blockInfo"
          cancelText={i18n('icu:cancel')}
          i18n={i18n}
          onClose={() => {
            setIsLeaveCallDialogVisible(false);
          }}
          title={i18n('icu:CallsList__LeaveCallDialogTitle')}
          actions={[
            {
              text: i18n('icu:CallsList__LeaveCallDialogButton--leave'),
              style: 'affirmative',
              action: () => {
                hangUpActiveCall(
                  'Calls Tab leave active call to join different call'
                );
              },
            },
          ]}
        >
          {i18n('icu:CallsList__LeaveCallDialogBody')}
        </ConfirmationDialog>
      )}

      <NavSidebarSearchHeader>
        <SearchInput
          i18n={i18n}
          placeholder={i18n('icu:CallsList__SearchInputPlaceholder')}
          onChange={handleSearchInputChange}
          onClear={handleSearchInputClear}
          value={queryInput}
        />
        <Tooltip
          direction={TooltipPlacement.Bottom}
          content={i18n('icu:CallsList__ToggleFilterByMissedLabel')}
          theme={Theme.Dark}
          delay={600}
        >
          <button
            className={classNames('CallsList__ToggleFilterByMissed', {
              'CallsList__ToggleFilterByMissed--pressed':
                statusInput === CallHistoryFilterStatus.Missed,
            })}
            type="button"
            aria-pressed={statusInput === CallHistoryFilterStatus.Missed}
            aria-roledescription={i18n(
              'icu:CallsList__ToggleFilterByMissed__RoleDescription'
            )}
            onClick={handleStatusToggle}
          >
            <span className="CallsList__ToggleFilterByMissedLabel">
              {i18n('icu:CallsList__ToggleFilterByMissedLabel')}
            </span>
          </button>
        </Tooltip>
      </NavSidebarSearchHeader>

      <SizeObserver>
        {(ref, size) => {
          return (
            <div className="CallsList__ListContainer" ref={ref}>
              {size != null && (
                <InfiniteLoader
                  ref={infiniteLoaderRef}
                  isRowLoaded={isRowLoaded}
                  loadMoreRows={loadMoreRows}
                  rowCount={rowCount}
                  minimumBatchSize={100}
                  threshold={30}
                >
                  {({ onRowsRendered, registerChild }) => {
                    return (
                      <List
                        className={classNames('CallsList__List', {
                          'CallsList__List--disableScrolling':
                            searchState.results == null ||
                            searchState.results.count === 0,
                        })}
                        ref={refMerger(listRef, registerChild)}
                        width={size.width}
                        height={size.height}
                        rowCount={rowCount}
                        rowHeight={rowHeight}
                        rowRenderer={rowRenderer}
                        onRowsRendered={onRowsRendered}
                      />
                    );
                  }}
                </InfiniteLoader>
              )}
            </div>
          );
        }}
      </SizeObserver>
    </>
  );
}
