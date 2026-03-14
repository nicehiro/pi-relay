export interface RelayConfig {
  discord: {
    token: string;
    applicationId?: string;
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
