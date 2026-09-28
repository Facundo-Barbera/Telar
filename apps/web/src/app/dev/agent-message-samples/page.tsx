import { TranscriptSample } from "./transcript-sample";
import { notFound } from "next/navigation";
import { AgentMessageBubble } from "@/components/session/conversation-message";
import { Message, MessageContent, MessageResponse } from "@/components/ui/message";
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  const text = "## Implementation checkpoint\n\nBoth documents read from `origin/main`.\n\n" + "- **Verified:** isolated modules pass; app integration remains.\n".repeat(40);
  return <main className="p-6"><TranscriptSample /><Message from="assistant"><MessageContent from="assistant"><MessageResponse>Normal conversation width and typography.</MessageResponse></MessageContent></Message><AgentMessageBubble text={text} sender={{sessionId:"session_worker123456"}} /><div className="mx-auto mt-8 max-w-80"><AgentMessageBubble text={text} sender={{sessionId:"session_worker123456"}} /></div></main>;
}
