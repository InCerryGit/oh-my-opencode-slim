import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard, BackgroundTaskConcurrency } from '../../utils';
import { historicalTasks } from './history-recovery';

mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

import { createTaskSessionManagerHook } from './index';

const parent = 'ses_parent';
const child = 'ses_child';
const startedAt = Date.now() - 2_000;
const completedAt = startedAt + 1_000;

function durableCall(
  options: { background?: boolean; running?: boolean } = {},
) {
  const state = options.running ? 'running' : 'completed';
  return {
    info: { role: 'assistant' },
    parts: [
      {
        type: 'tool',
        name: 'subagent',
        id: 'call_previous',
        time: { created: startedAt },
        state: {
          status: 'completed',
          input: {
            agent: 'fixer',
            prompt: 'Inspect the scheduler',
            description: 'scheduler investigation',
            background: options.background,
          },
          content: [
            {
              type: 'text',
              text: `<subagent sessionID="${child}" state="${state}">\nFound the cause\n</subagent>`,
            },
          ],
        },
      },
    ],
  };
}

function modelHistory() {
  return {
    messages: [
      {
        info: { role: 'assistant', sessionID: parent },
        parts: [{ type: 'tool-call', id: 'call_previous', name: 'subagent' }],
      },
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: parent },
        parts: [{ type: 'text', text: 'Continue the investigation' }],
      },
    ],
  };
}

function restartedHook(
  options: {
    history?: unknown[];
    busy?: boolean;
    deleted?: boolean;
    get?: () => Promise<unknown>;
  } = {},
) {
  const board = new BackgroundJobBoard();
  const concurrency = new BackgroundTaskConcurrency({
    defaultConcurrency: 2,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  board.addTerminalStateListener((taskID) => concurrency.releaseTask(taskID));
  const get = mock(async () => {
    if (options.get) return options.get();
    if (options.deleted) {
      throw Object.assign(new Error('missing child'), {
        _tag: 'Session.NotFoundError',
      });
    }
    return {
      data: {
        id: child,
        parentID: parent,
        ...(options.busy
          ? {}
          : { outcome: 'succeeded', time: { idle: completedAt } }),
      },
    };
  });
  const messages = mock(async ({ path }: { path: { id: string } }) => ({
    data:
      path.id === parent
        ? (options.history ?? [durableCall()])
        : [
            {
              info: {
                id: 'answer',
                role: 'assistant',
                finish: 'stop',
                time: { completed: completedAt },
              },
              parts: [{ type: 'text', text: 'Found the cause' }],
            },
          ],
  }));
  const hook = createTaskSessionManagerHook(
    {
      client: { session: { get, messages } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 4,
      backgroundJobBoard: board,
      backgroundTaskConcurrency: concurrency,
      shouldManageSession: (sessionID) => sessionID === parent,
      hostFlavor: 'v2',
      hostOutcomeClock: 'shared-unix-ms',
    },
  );
  return { hook, board, concurrency, messages, get };
}

async function recover(hook: ReturnType<typeof createTaskSessionManagerHook>) {
  await hook['experimental.chat.messages.transform']({}, modelHistory());
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('historical task recovery', () => {
  test('reads v1 completed foreground calls as well as running background calls', () => {
    const tasks = historicalTasks([
      {
        info: { role: 'assistant', sessionID: parent },
        parts: [
          {
            type: 'tool',
            tool: 'task',
            state: {
              input: { subagent_type: 'fixer', description: 'foreground task' },
              time: { start: startedAt },
              output: `task_id: ${child}\nstate: completed\n<task_result>Found the cause</task_result>`,
            },
          },
        ],
      },
    ]);
    expect(tasks).toMatchObject([
      {
        taskID: child,
        parentSessionID: parent,
        background: false,
        startedAt,
        status: { state: 'completed' },
      },
    ]);
  });

  test('the latest resume supersedes the older completed output', () => {
    const tasks = historicalTasks(
      [
        durableCall(),
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              name: 'subagent',
              time: { created: completedAt + 100 },
              state: {
                status: 'running',
                input: {
                  agent: 'fixer',
                  sessionID: child,
                  description: 'implement the fix',
                },
              },
            },
          ],
        },
      ],
      parent,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskID: child,
      description: 'implement the fix',
      startedAt: completedAt + 100,
    });
    expect(tasks[0].status).toBeUndefined();
  });

  test('a fresh board recovers a completed v2 foreground child and resumes the same ID', async () => {
    const { hook, board, concurrency, messages } = restartedHook();
    await recover(hook);
    expect(board.get(child)).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
      background: false,
      parentSessionID: parent,
      agent: 'fixer',
    });
    expect(board.resolveReusable(parent, child, 'fixer')?.taskID).toBe(child);
    expect(concurrency.snapshot()).toEqual({ active: 0, queued: 0 });
    const output = {
      args: {
        task_id: child,
        subagent_type: 'fixer',
        prompt: 'Implement the fix',
        description: 'apply fix',
      },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: parent, callID: 'continue' },
      output,
    );
    expect(output.args.task_id).toBe(child);
    await recover(hook);
    expect(
      messages.mock.calls.filter(([input]) => input.path.id === parent),
    ).toHaveLength(1);
  });

  test('a rejected resume does not replace the last established child run', () => {
    const tasks = historicalTasks(
      [
        durableCall(),
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              name: 'subagent',
              time: { created: completedAt + 100 },
              state: {
                status: 'error',
                input: { agent: 'fixer', sessionID: child },
                error: 'admission rejected',
              },
            },
          ],
        },
      ],
      parent,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskID: child,
      startedAt,
      status: { state: 'completed' },
    });
  });

  test('recovers completed background children without leaking admission slots', async () => {
    const { hook, board, concurrency } = restartedHook({
      history: [durableCall({ background: true })],
    });
    await recover(hook);
    expect(board.resolveReusable(parent, child, 'fixer')?.taskID).toBe(child);
    expect(concurrency.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test('a running native background child retains its admission slot', async () => {
    const { hook, board, concurrency } = restartedHook({
      history: [durableCall({ background: true, running: true })],
      busy: true,
    });
    await recover(hook);
    expect(board.get(child)?.state).toBe('running');
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('an unavailable parent history read does not suppress later recovery', async () => {
    const { hook, board, messages } = restartedHook();
    messages.mockRejectedValueOnce(new Error('temporary history read failure'));
    await recover(hook);
    expect(board.get(child)).toBeUndefined();
    await recover(hook);
    expect(board.resolveReusable(parent, child, 'fixer')?.taskID).toBe(child);
  });

  test('busy host evidence cannot turn an old completion into a reusable task', async () => {
    const { hook, board } = restartedHook({ busy: true });
    await recover(hook);
    expect(board.get(child)?.state).toBe('running');
    expect(board.resolveReusable(parent, child, 'fixer')).toBeUndefined();
  });

  test('a later in-progress resume fences the previous host outcome', async () => {
    const { hook, board } = restartedHook({
      history: [
        durableCall(),
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              name: 'subagent',
              time: { created: completedAt + 100 },
              state: {
                input: { agent: 'fixer', sessionID: child },
                status: 'running',
              },
            },
          ],
        },
      ],
    });
    await recover(hook);
    expect(board.get(child)?.state).toBe('running');
    expect(board.resolveReusable(parent, child, 'fixer')).toBeUndefined();
  });

  test('deleted completed children stay deleted across repeated transforms', async () => {
    const { hook, board, get } = restartedHook({ deleted: true });
    await recover(hook);
    await recover(hook);
    expect(board.get(child)).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('recovery never rewrites native tool history', () => {
    const history = [durableCall()];
    const before = JSON.stringify(history);
    historicalTasks(history, parent);
    expect(JSON.stringify(history)).toBe(before);
  });
});
