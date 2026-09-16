import { MainAssistant } from "@/components/main-assistant";

export const dynamic = "force-dynamic";

/**
 * `/main` — the one conversation this Mac coordinates from (#526).
 *
 * A RESERVED ADDRESS RATHER THAN `/sessions/<id>`, and that is the whole reason
 * it is its own route. There is exactly one Main conversation per machine and
 * it belongs to no project, so there is no `/projects/<id>/sessions/<id>` URL
 * to build for it — and a person who bookmarks this one wants "the Main
 * conversation", not "the session that happened to be Main in March". The id
 * behind it is the engine's business; this address outlives it.
 *
 * THE SERVER RENDERS NO SESSION ID because it does not know one without asking,
 * and asking here would make every load of this page wait on the engine before
 * the first paint. The client reads the designation off the same route the
 * settings pane does and then renders the ordinary cockpit — one cockpit, not
 * a second one that would drift.
 */
export default function MainAssistantPage() {
  return <MainAssistant />;
}
