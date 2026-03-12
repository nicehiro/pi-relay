export interface RelayConfig {
  discord: {
    token: string;
  };
  machine: {
    name: string;
  };
  channels: string[];
  auth: {
    users: string[];
  };
  proxy?: string;
}

export interface PendingChat {
  channelId: string;
  username: string;
}
