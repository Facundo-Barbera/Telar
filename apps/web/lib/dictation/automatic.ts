/**
 * THE CODE THAT MEANS "ALL OF THEM AT ONCE" (#560).
 *
 * Its own module because three files now compare against it — the settings
 * pane's hint, the caret badge, and the test that pins both — and none of them
 * should reach into the engine's Deepgram list to get one string. A literal
 * `"multi"` spelled out in each of them is the version of this that goes wrong
 * quietly the day it is spelled `"multilingual"` somewhere.
 */
export const DICTATION_AUTOMATIC = "multi";
