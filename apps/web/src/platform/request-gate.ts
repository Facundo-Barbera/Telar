
export type RequestGate = {
  begin(identity: string): number | undefined;
  settle(token: number): boolean;
  retarget(identity: string): void;
  inFlight(): boolean;
};

export function createRequestGate(): RequestGate {
  let issued = 0;
  let active: { token: number; identity: string } | undefined;
  return {
    begin(identity) {
      if (active) return undefined;
      issued += 1;
      active = { token: issued, identity };
      return issued;
    },
    settle(token) {
      if (!active || active.token !== token) return false;
      active = undefined;
      return true;
    },
    retarget(identity) {
      if (active && active.identity !== identity) active = undefined;
    },
    inFlight() {
      return active !== undefined;
    },
  };
}
