import {
  deriveFullObjective,
  deriveTaskSessionLabel,
  parseTaskStatusOutput,
} from '../../utils';
import { isRecord } from '../../utils/guards';
import type { TaskStatusOutput } from '../../utils/task';
import { subagentArgsToV1 } from '../../v2/delegation';
import { isMessageWithParts } from '../types';

export interface HistoricalTask {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective: string;
  background: boolean;
  startedAt: number;
  status?: TaskStatusOutput;
}

/** Read the host's durable tool records without rewriting prompt history. */
export function historicalTasks(
  messages: unknown[],
  parentSessionID?: string,
): HistoricalTask[] {
  const latest = new Map<string, HistoricalTask>();
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    const parent = parentSessionID ?? message.info.sessionID;
    if (!parent || message.info.role !== 'assistant') continue;

    for (const part of message.parts) {
      const tool = part.tool ?? part.name;
      if (part.type !== 'tool' || (tool !== 'task' && tool !== 'subagent')) {
        continue;
      }
      if (!isRecord(part.state) || !isRecord(part.state.input)) continue;
      const state = part.state;
      const input = subagentArgsToV1(state.input);
      const output =
        typeof state.output === 'string'
          ? state.output
          : Array.isArray(state.content)
            ? state.content
                .filter((value) => isRecord(value) && value.type === 'text')
                .map((value) => value.text)
                .join('\n')
            : '';
      const status = parseTaskStatusOutput(output);
      const metadata = isRecord(state.metadata) ? state.metadata : undefined;
      // A rejected tool invocation alone does not establish a new child run.
      const taskID =
        status?.taskID ??
        metadata?.sessionID ??
        (state.status !== 'error' ? input.task_id : undefined);
      if (typeof taskID !== 'string' || !taskID.trim()) continue;
      const prior = latest.get(taskID);
      const agent =
        typeof input.subagent_type === 'string' && input.subagent_type.trim()
          ? input.subagent_type.trim()
          : (prior?.agent ?? 'unknown');
      const description =
        typeof input.description === 'string' ? input.description : undefined;
      const prompt =
        typeof input.prompt === 'string' ? input.prompt : undefined;
      const label = deriveTaskSessionLabel({
        description,
        prompt,
        agentType: agent,
      });
      const time = isRecord(state.time) ? state.time : undefined;
      const partTime = isRecord(part.time) ? part.time : undefined;
      const startedAt = time?.start ?? partTime?.created;

      // A later resume replaces the earlier completion, including when the
      // new call is still pending and has no output yet.
      latest.set(taskID, {
        taskID,
        parentSessionID: parent,
        agent,
        description: label,
        objective: deriveFullObjective({ description, prompt }) ?? label,
        background: input.background === true || metadata?.background === true,
        startedAt:
          typeof startedAt === 'number' && Number.isFinite(startedAt)
            ? startedAt
            : 0,
        status,
      });
    }
  }
  return [...latest.values()];
}
