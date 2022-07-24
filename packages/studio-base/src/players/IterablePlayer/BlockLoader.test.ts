// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { compare } from "@foxglove/rostime";
import { MessageEvent } from "@foxglove/studio";
import PlayerProblemManager from "@foxglove/studio-base/players/PlayerProblemManager";

import { BlockLoader } from "./BlockLoader";
import {
  IIterableSource,
  Initalization,
  MessageIteratorArgs,
  IteratorResult,
  GetBackfillMessagesArgs,
} from "./IIterableSource";

class TestSource implements IIterableSource {
  async initialize(): Promise<Initalization> {
    return {
      start: { sec: 0, nsec: 0 },
      end: { sec: 10, nsec: 0 },
      topics: [],
      topicStats: new Map(),
      problems: [],
      profile: undefined,
      datatypes: new Map(),
      publishersByTopic: new Map(),
    };
  }

  async *messageIterator(
    _args: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {}

  async getBackfillMessages(_args: GetBackfillMessagesArgs): Promise<MessageEvent<unknown>[]> {
    return [];
  }
}

describe("BlockLoader", () => {
  it("should make an empty block loader", async () => {
    const loader = new BlockLoader({
      maxBlocks: 4,
      cacheSizeBytes: 1,
      minBlockDurationNs: 1,
      source: new TestSource(),
      start: { sec: 0, nsec: 0 },
      end: { sec: 2, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    await loader.startLoading({
      progress: async (progress) => {
        expect(progress).toEqual({
          fullyLoadedFractionRanges: [],
          messageCache: {
            blocks: [undefined, undefined, undefined, undefined],
            startTime: { sec: 0, nsec: 0 },
          },
        });
        await loader.stopLoading();
      },
    });

    expect.assertions(1);
  });

  it("should load the source into blocks", async () => {
    const source = new TestSource();

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 1,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent<unknown>[] = [];
    for (let i = 0; i < 5; ++i) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 0,
      });
    }

    source.messageIterator = async function* messageIterator(
      _args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (let i = 0; i < msgEvents.length; ++i) {
        const msgEvent = msgEvents[i]!;
        yield {
          msgEvent,
          problem: undefined,
          connectionId: undefined,
        };
      }
    };

    loader.setTopics(new Set("a"));
    let count = 0;
    await loader.startLoading({
      progress: async (progress) => {
        if (++count < 4) {
          return;
        }

        expect(progress).toEqual({
          fullyLoadedFractionRanges: [
            {
              start: 0,
              end: 1,
            },
          ],
          messageCache: {
            blocks: [
              {
                messagesByTopic: {
                  a: [msgEvents[0], msgEvents[1]],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [msgEvents[2], msgEvents[3]],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [msgEvents[4]],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [],
                },
                sizeInBytes: 0,
              },
            ],
            startTime: { sec: 0, nsec: 0 },
          },
        });

        await loader.stopLoading();
      },
    });
    expect.assertions(1);
  });

  it("should load the source into blocks when starting partially through the source", async () => {
    const source = new TestSource();

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 1,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent<unknown>[] = [];
    for (let i = 0; i < 5; ++i) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 0,
      });
    }

    source.messageIterator = async function* messageIterator(
      args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (let i = 0; i < msgEvents.length; ++i) {
        const msgEvent = msgEvents[i]!;
        if (args.start && compare(msgEvent.receiveTime, args.start) < 0) {
          continue;
        }
        if (args.end && compare(msgEvent.receiveTime, args.end) > 0) {
          continue;
        }

        yield {
          msgEvent,
          problem: undefined,
          connectionId: undefined,
        };
      }
    };

    loader.setTopics(new Set("a"));
    loader.setActiveTime({ sec: 3, nsec: 10 });
    let count = 0;
    await loader.startLoading({
      progress: async (progress) => {
        if (++count < 3) {
          return;
        }

        expect(progress).toEqual({
          fullyLoadedFractionRanges: [
            {
              start: 0,
              end: 1,
            },
          ],
          messageCache: {
            blocks: [
              {
                messagesByTopic: {
                  a: [msgEvents[0], msgEvents[1]],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [msgEvents[2], msgEvents[3]],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [msgEvents[4]],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [],
                },
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [],
                },
                sizeInBytes: 0,
              },
            ],
            startTime: { sec: 0, nsec: 0 },
          },
        });

        await loader.stopLoading();
      },
    });

    expect.assertions(1);
  });

  it("should reset loading when active time moves to an unloaded region", async () => {
    const source = new TestSource();

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 1,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent<unknown>[] = [];
    for (let i = 0; i < 5; ++i) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 0,
      });
    }

    source.messageIterator = async function* messageIterator(
      args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (let i = 0; i < msgEvents.length; ++i) {
        const msgEvent = msgEvents[i]!;
        if (args.start && compare(msgEvent.receiveTime, args.start) < 0) {
          continue;
        }
        if (args.end && compare(msgEvent.receiveTime, args.end) > 0) {
          continue;
        }

        yield {
          msgEvent,
          problem: undefined,
          connectionId: undefined,
        };
      }
    };

    loader.setTopics(new Set("a"));

    let count = 0;
    await loader.startLoading({
      progress: async (progress) => {
        count += 1;
        if (count >= 1) {
          loader.setActiveTime({ sec: 5, nsec: 0 });
        }

        // when progress matches what we want we've finished loading
        if (progress.messageCache?.blocks.every((item) => item != undefined) === true) {
          // eslint-disable-next-line jest/no-conditional-expect
          expect(progress).toEqual({
            fullyLoadedFractionRanges: [
              {
                start: 0,
                end: 1,
              },
            ],
            messageCache: {
              blocks: [
                {
                  messagesByTopic: {
                    a: [msgEvents[0], msgEvents[1]],
                  },
                  sizeInBytes: 0,
                },
                {
                  messagesByTopic: {
                    a: [msgEvents[2], msgEvents[3]],
                  },
                  sizeInBytes: 0,
                },
                {
                  messagesByTopic: {
                    a: [msgEvents[4]],
                  },
                  sizeInBytes: 0,
                },
                {
                  messagesByTopic: {
                    a: [],
                  },
                  sizeInBytes: 0,
                },
                {
                  messagesByTopic: {
                    a: [],
                  },
                  sizeInBytes: 0,
                },
              ],
              startTime: { sec: 0, nsec: 0 },
            },
          });
          await loader.stopLoading();
        }
      },
    });

    expect.assertions(1);
  });

  // fixme - loading not from start, then going back to start and loading seemed to not realize some area had already been loaded...
  // basically when loading reaches a section that has already loaded, it doesn't seem like it realizes that

  // fixme
  // when changing the active time and all blocks are loaded, we still emit progress several times?
  // strange because we didn't actually change anything...
  // as active time continues to change we continue to emit progress - again nothing changed...
});
