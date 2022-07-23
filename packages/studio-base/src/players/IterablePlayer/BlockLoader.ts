// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { simplify } from "intervals-fn";
import { isEqual } from "lodash";

import { Condvar } from "@foxglove/den/async";
import { filterMap } from "@foxglove/den/collection";
import Log from "@foxglove/log";
import { Time, subtract as subtractTimes, toNanoSec, add, fromNanoSec } from "@foxglove/rostime";
import { MessageEvent } from "@foxglove/studio";
import PlayerProblemManager from "@foxglove/studio-base/players/PlayerProblemManager";
import { MessageBlock, Progress } from "@foxglove/studio-base/players/types";

import { IIterableSource } from "./IIterableSource";

const log = Log.getLogger(__filename);

type BlockLoaderArgs = {
  cacheSizeBytes: number;
  source: IIterableSource;
  start: Time;
  end: Time;
  maxBlocks: number;
  minBlockDurationNs: number;
  problemManager: PlayerProblemManager;
};

// A BlockSpan is a continuous set of blocks and topics to load for those blocks
type BlockSpan = {
  beginId: number;
  endId: number;
  topics: Set<string>;
};

type Blocks = (MessageBlock | undefined)[];

type LoadArgs = {
  progress: (progress: Progress) => void;
};

/**
 * BlockLoader manages loading blocks from a source. Blocks are fixed time span containers for messages.
 */
export class BlockLoader {
  private source: IIterableSource;
  private blocks: Blocks = [];
  private start: Time;
  private end: Time;
  private blockDurationNanos: number;
  private topics: Set<string> = new Set();
  private maxCacheSize: number = 0;
  private activeBlockId: number = 0;
  private problemManager: PlayerProblemManager;
  private stopped: boolean = false;
  private activeChangeCondvar: Condvar = new Condvar();

  constructor(args: BlockLoaderArgs) {
    this.source = args.source;
    this.start = args.start;
    this.end = args.end;
    this.maxCacheSize = args.cacheSizeBytes;
    this.problemManager = args.problemManager;

    const totalNs = Number(toNanoSec(subtractTimes(this.end, this.start))) + 1; // +1 since times are inclusive.
    if (totalNs > Number.MAX_SAFE_INTEGER * 0.9) {
      throw new Error("Time range is too long to be supported");
    }

    this.blockDurationNanos = Math.ceil(
      Math.max(args.minBlockDurationNs, totalNs / args.maxBlocks),
    );

    const blockCount = Math.ceil(totalNs / this.blockDurationNanos);

    log.debug(`Block count: ${blockCount}`);
    this.blocks = Array.from({ length: blockCount });
  }

  setActiveTime(time: Time): void {
    const startTime = subtractTimes(subtractTimes(time, this.start), { sec: 1, nsec: 0 });
    const startNs = Math.max(0, Number(toNanoSec(startTime)));
    const beginBlockId = Math.floor(startNs / this.blockDurationNanos);

    if (beginBlockId === this.activeBlockId) {
      return;
    }

    console.log("blockid chagnged", beginBlockId);
    this.activeBlockId = beginBlockId;
    this.activeChangeCondvar.notifyAll();
  }

  setTopics(topics: Set<string>): void {
    if (isEqual(topics, this.topics)) {
      return;
    }

    this.topics = topics;
    this.activeChangeCondvar.notifyAll();
  }

  async stopLoading(): Promise<void> {
    this.stopped = true;
    this.activeChangeCondvar.notifyAll();
  }

  async startLoading(args: LoadArgs): Promise<void> {
    log.debug("Start loading process");
    this.stopped = false;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (!this.stopped) {
      const activeBlockId = this.activeBlockId;
      const topics = this.topics;

      // fimxe
      // topics have changed, loading will bail
      // now we see that our active block id hs the topic we want
      // because make it was from a prior load
      // but the blocks after active don't have that topic
      // so if we bail because active has it ... we won't fetch those blocks
      //
      const cachedBlock = this.blocks[activeBlockId];
      if (cachedBlock) {
        // if has all topics
        // then we wait

        const blockTopics = Object.keys(cachedBlock.messagesByTopic);

        const topicsToFetch = new Set(topics);
        for (const topic of blockTopics) {
          topicsToFetch.delete(topic);
        }
        if (topicsToFetch.size === 0) {
          await this.activeChangeCondvar.wait();

          continue;
        }
      }

      // fixme - we are constantly recomputing spans because the blocks are small
      // and we are playing data
      // but when we are playing, we don't actually need to re-compute the spans because
      // they haven't changed
      // all that changes are the blocks we need to load vs evict

      // Load around the active block id, if the active block id changes then bail
      await this.load({ progress: args.progress });

      // fixme
      // when load has finished, we still get notified even tho there's nothing to do!!
      // when the block we seek to is < existing, then we might need to load again
      // actually - as we move forward, we might need to load because we can evict another block
      // this is actually a disaster scenario? we are going to _fetch_ a tiny request worth of data
      // because we will only be able to purge a tiny amount
      // starting at the activeBlockId, and going until when?
      // we don't actually know if we can hold more - all we know is we need to fetch the active block id
      // if the active block id is present, then there's nothing else to do?
      // when topics change we bail

      // The active block id is the same as when we started.
      // Wait for it to possibly change.
      if (this.activeBlockId === activeBlockId && this.topics === topics) {
        await this.activeChangeCondvar.wait();
      }
    }
  }

  private async load(args: { progress: LoadArgs["progress"] }): Promise<void> {
    const topics = this.topics;

    let progress = this.calculateProgress(topics);

    // Ignore changing the blocks if the topic list is empty
    if (topics.size === 0) {
      return;
    }

    // Block caching works on the assumption that when seeking, the user wants to look at some
    // data before and after the current time.
    //
    // When we start to load blocks, we start at 1 second before _time_ and load to the end.
    // Then we load from the start to 1 second before.
    //
    // Given the following blocks and a load start time within block "5":
    // [1, 2, 3, 4, 5, 6, 7, 8, 9]
    //
    // The block load order is:
    // 4, 5, 6, 7, 8, 9, 1, 2, 3
    //
    // When we need to evict, we evict backwards from the load blocks, so we evict: 3, 2, 1, 9, etc

    const beginBlockId = this.activeBlockId;
    const startBlockId = 0;
    const endBlockId = this.blocks.length - 1;

    const computeSpans = (startIdx: number, endIdx: number) => {
      const spans: BlockSpan[] = [];

      let activeSpan: BlockSpan | undefined;
      for (let i = startIdx; i < endIdx; ++i) {
        // compute the topics this block needs
        const existingBlock = this.blocks[i];
        const blockTopics = existingBlock ? Object.keys(existingBlock.messagesByTopic) : [];

        const topicsToFetch = new Set(topics);
        for (const topic of blockTopics) {
          topicsToFetch.delete(topic);
        }

        if (!activeSpan) {
          activeSpan = {
            beginId: i,
            endId: i,
            topics: topicsToFetch,
          };
          continue;
        }

        // If the topics of the active span equal the topics to fetch, grow the span
        if (isEqual(activeSpan.topics, topicsToFetch)) {
          activeSpan.endId = i;
          continue;
        }

        spans.push(activeSpan);
        activeSpan = {
          beginId: i,
          endId: i,
          topics: topicsToFetch,
        };
      }
      if (activeSpan) {
        spans.push(activeSpan);
      }

      return spans;
    };

    // fixme
    // we have a bunch of block
    // [0, 1, 2, 3, 4]
    // At any time, we have a activeBlockId which is the block we are "viewing"
    //
    // [0, 1, 2, 3, 4]
    //        ^
    // we evict by going backwards from begin block (wrap around until back to begin block)
    //
    // when the begin block changes...
    // we scan from begin block forwards - till when? till currentBlockId
    // cause thats when we've filled until
    // if there are any gaps, then we need to bail cause we will need to backfill

    // When the list of topics changes, we want to avoid loading topics if the block already has the
    // topic. Create spans of blocks based on which topics are needed. This allows us reduce
    // overhead by making longer more continuous requests.
    const blockSpans: BlockSpan[] = [];

    // The load order is from [beginBlock to endBlock], then [startBlock, beginBlock)
    blockSpans.push(...computeSpans(beginBlockId, endBlockId + 1));
    blockSpans.push(...computeSpans(startBlockId, beginBlockId));

    log.debug("spans", blockSpans);

    // The evict queue has the block ids that we can evict once we've reached our memory bounds.
    const evictQueue: number[] = [];
    for (let i = beginBlockId; i <= endBlockId; ++i) {
      evictQueue.push(i);
    }
    for (let i = startBlockId; i < beginBlockId; ++i) {
      evictQueue.push(i);
    }
    evictQueue.reverse();

    let totalBlockSizeBytes = this.cacheSize();

    // Load all the spans, each span is a separate iterator because it requires different topics
    for (const span of blockSpans) {
      // No need to load spans with no topics
      if (span.topics.size === 0) {
        continue;
      }

      const iteratorStartTime = this.blockIdToStartTime(span.beginId);
      const iteratorEndTime = this.blockIdToEndTime(span.endId);

      const iterator = this.source.messageIterator({
        topics: Array.from(span.topics),
        start: iteratorStartTime,
        end: iteratorEndTime,
      });

      let messagesByTopic: Record<string, MessageEvent<unknown>[]> = {};
      // Set all topic arrays to empty to indicate we've read this topic
      for (const topic of span.topics) {
        messagesByTopic[topic] = [];
      }

      let currentBlockId = span.beginId;

      let sizeInBytes = 0;
      for await (const iterResult of iterator) {
        if (iterResult.problem) {
          this.problemManager.addProblem(`connid-${iterResult.connectionId}`, iterResult.problem);
          continue;
        }

        const messageBlockId = this.timeToBlockId(iterResult.msgEvent.receiveTime);

        // Message is for a different block.
        // 1. Close out the current block.
        // 2. Fill in any block gaps.
        // 3. start a new block.
        if (messageBlockId !== currentBlockId) {
          // Close out the current block with the aggregated messages. Fill any blocks between
          // current and the new block with empty topic arrays. We can use empty arrays because we
          // know these blocks have no messages since messages arrive in time order.
          for (let i = currentBlockId; i < messageBlockId; ++i) {
            const existingBlock = this.blocks[i];

            this.blocks[i] = {
              messagesByTopic: {
                ...existingBlock?.messagesByTopic,
                ...messagesByTopic,
              },
              sizeInBytes: sizeInBytes + (existingBlock?.sizeInBytes ?? 0),
            };

            messagesByTopic = {};
            // Set all topic arrays to empty to indicate we've read this topic
            for (const topic of span.topics) {
              messagesByTopic[topic] = [];
            }
          }

          progress = this.calculateProgress(topics);

          // Set the new block to the id of our latest message
          currentBlockId = messageBlockId;

          // fixme - we don't necesarily need to bail here
          // we only need to do what?
          // re-order the list of what we should be fetching
          // make sure all the blocks after our desired block are present
          // if they are, then we can continue doing what we were
          // if topics changes?

          // If the topics have changed we have to re-compute the spans, so we
          // bail this loading instance.
          if (topics !== this.topics) {
            log.debug("topics changed, aborting load instance");
            return;
          }

          // When the active block id changes, we need to check whether the active block
          // is loaded through where we are loading (or the end if active block is after currentBlockId)

          if (beginBlockId !== this.activeBlockId) {
            const endId =
              this.activeBlockId <= currentBlockId ? currentBlockId : this.blocks.length - 1;

            // The active block is the one we are loading, so we keep going
            if (this.activeBlockId !== currentBlockId) {
              for (let idx = this.activeBlockId; idx < endId; ++idx) {
                const checkBlock = this.blocks[idx];

                const blockTopics = checkBlock ? Object.keys(checkBlock.messagesByTopic) : [];

                const topicsToFetch = new Set(topics);
                for (const topic of blockTopics) {
                  topicsToFetch.delete(topic);
                }
                if (topicsToFetch.size > 0) {
                  log.debug("active block changed, aborting load instance");
                  return;
                }
              }
            }
          }
        }

        const msgTopic = iterResult.msgEvent.topic;
        const events = messagesByTopic[msgTopic];

        const problemKey = `unexpected-topic-${msgTopic}`;
        if (!events) {
          this.problemManager.addProblem(problemKey, {
            severity: "error",
            message: `Received a messaged on an unexpected topic: ${msgTopic}.`,
          });

          continue;
        }
        this.problemManager.removeProblem(problemKey);

        const messageSizeInBytes = iterResult.msgEvent.sizeInBytes;
        sizeInBytes += messageSizeInBytes;

        // Adding this message will exceed the cache size
        // Evict blocks until we have enough size for the message
        while (
          evictQueue.length > 0 &&
          totalBlockSizeBytes + messageSizeInBytes > this.maxCacheSize
        ) {
          const evictId = evictQueue.pop();
          if (evictId != undefined) {
            const lastBlock = this.blocks[evictId];
            this.blocks[evictId] = undefined;
            if (lastBlock) {
              totalBlockSizeBytes -= lastBlock.sizeInBytes;
              totalBlockSizeBytes = Math.max(0, totalBlockSizeBytes);
            }
          }
        }

        totalBlockSizeBytes += messageSizeInBytes;
        events.push(iterResult.msgEvent);

        args.progress(progress);
      }

      // Close out the current block with the aggregated messages. Fill any blocks between
      // current and the new block with empty topic arrays. We can use empty arrays because we
      // know these blocks have no messages since messages arrive in time order.
      for (let i = currentBlockId; i <= span.endId; ++i) {
        const existingBlock = this.blocks[i];

        this.blocks[i] = {
          messagesByTopic: {
            ...existingBlock?.messagesByTopic,
            ...messagesByTopic,
          },
          sizeInBytes: sizeInBytes + (existingBlock?.sizeInBytes ?? 0),
        };

        messagesByTopic = {};
        // Set all topic arrays to empty to indicate we've read this topic
        for (const topic of span.topics) {
          messagesByTopic[topic] = [];
        }
      }

      progress = this.calculateProgress(topics);
    }

    args.progress(progress);
  }

  /// ---- private

  private calculateProgress(topics: Set<string>): Progress {
    const fullyLoadedFractionRanges = simplify(
      filterMap(this.blocks, (thisBlock, blockIndex) => {
        if (!thisBlock) {
          return;
        }

        for (const topic of topics) {
          if (!thisBlock.messagesByTopic[topic]) {
            return;
          }
        }

        return {
          start: blockIndex,
          end: blockIndex + 1,
        };
      }),
    );

    return {
      fullyLoadedFractionRanges: fullyLoadedFractionRanges.map((range) => ({
        // Convert block ranges into fractions.
        start: range.start / this.blocks.length,
        end: range.end / this.blocks.length,
      })),
      messageCache: {
        blocks: this.blocks.slice(),
        startTime: this.start,
      },
    };
  }

  private cacheSize(): number {
    return this.blocks.reduce((prev, block) => {
      if (!block) {
        return prev;
      }

      return prev + block.sizeInBytes;
    }, 0);
  }

  // Convert a time to a blockId. Return -1 if the time cannot be converted to a valid block id
  private timeToBlockId(stamp: Time): number {
    const startNs = toNanoSec(this.start);
    const stampNs = toNanoSec(stamp);
    const offset = stampNs - startNs;
    if (offset < 0) {
      return -1;
    }

    return Number(offset / BigInt(this.blockDurationNanos));
  }

  private blockIdToStartTime(id: number): Time {
    return add(this.start, fromNanoSec(BigInt(id) * BigInt(this.blockDurationNanos)));
  }

  // The end time of a block is the start time of the next block minus 1 nanosecond
  private blockIdToEndTime(id: number): Time {
    return add(this.start, fromNanoSec(BigInt(id + 1) * BigInt(this.blockDurationNanos) - 1n));
  }
}
