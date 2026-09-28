export type DirectoryEntry = {
  name: string;
  path: string;
  git: boolean;
  hidden: boolean;
};

export type DirectoryListing = {
  path: string;
  name: string;
  parent: string | null;
  home: string;
  roots: { name: string; path: string }[];
  dirs: DirectoryEntry[];
  truncated: boolean;
  missing?: string;
  gitPartial?: boolean;
};
