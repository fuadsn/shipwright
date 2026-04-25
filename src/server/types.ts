import type { TaskRun } from "../shared/task";

export interface SlackInstall {
  team_id: string;
  team_name: string;
  bot_token: string;
  bot_user_id?: string;
  channel_id?: string;
  channel_name?: string;
  channel_is_private?: boolean;
  channel_is_member?: boolean;
  installed_at: string;
}

export interface ServerState {
  task: TaskRun | null;
  slackThreadTs: string | null;
  slackInstall: SlackInstall | null;
  processedSlackEvents: Set<string>;
}

export interface SlackTaskMessagePayload {
  task: TaskRun;
  message?: string;
}
