export interface SlackConnectionStatus {
  connected: boolean;
  mode: "oauth" | "env" | "none";
  team_name?: string;
  channel_id?: string;
  channel_name?: string;
  channel_is_private?: boolean;
  channel_is_member?: boolean;
  bot_user_id?: string;
  install_url?: string;
  redirect_uri?: string;
  missing_config?: string[];
}

export interface SlackChannelMessage {
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export interface SlackChannelReadResult {
  ok: boolean;
  channel_id?: string;
  channel_name?: string;
  mode: "last" | "issues" | "all";
  scanned_count: number;
  issue_count: number;
  messages: SlackChannelMessage[];
  summary: string;
  error?: string;
}
