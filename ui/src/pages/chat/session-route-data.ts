import type { RouteLocation } from "@openclaw/uirouter";
import type { BoardFace } from "../../lib/board/settings.ts";

export type SessionRouteCandidate = {
  agentId: string;
  displayName: string;
  href: string;
  idPrefix: string;
};

export type ChatRouteData =
  | {
      kind: "session";
      sessionKey: string;
      agentId?: string;
      draft?: string;
      focusComposer?: boolean;
      face: BoardFace;
      shortId?: string;
      canonicalLocation?: RouteLocation;
      canonicalLocationReady?: Promise<RouteLocation | null>;
      canonicalLocationSource?: RouteLocation;
    }
  | {
      kind: "ambiguous";
      shortId: string;
      candidates: SessionRouteCandidate[];
      truncated: boolean;
      face: BoardFace;
    }
  | { kind: "route-error"; message: string; face: "chat" };

export type SessionChatRouteData = Omit<
  Extract<ChatRouteData, { kind: "session" }>,
  "face" | "kind"
> & {
  face?: BoardFace;
  kind?: "session";
};
