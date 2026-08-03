export type LocalServerSuggestion = {
  name: string;
  port: number;
  url: string;
};

export type LocalServersResponse = {
  servers: LocalServerSuggestion[];
};
