/**
 * WHAT A CONVERSATION LOOKS LIKE BEFORE IT ARRIVES (#407).
 *
 * A `loading.tsx` is not decoration here; it is what lets the router COMMIT the
 * navigation at all. Without a Suspense boundary around a dynamic segment, Next
 * holds the old screen until the new one's server render has come back, so
 * pressing a row in the rail did nothing visible for as long as that took — the
 * exact complaint in the issue. With one, the press paints instantly and the
 * conversation streams into the frame it drew.
 *
 * IT DRAWS THE ROOM, NOT A SPINNER. The masthead bar, a few message blocks and
 * the composer's floor sit where the real ones will, so the arriving transcript
 * lands in a layout that has already settled rather than shoving one aside. The
 * shapes are deliberately vague — a skeleton that guesses at the number of turns
 * is a skeleton that is usually wrong, and the flicker of being corrected costs
 * more than it saves.
 *
 * NO ANIMATION BEYOND A PULSE, and no text. Anything this screen said would be
 * a sentence about our own plumbing, addressed to somebody who pressed a button
 * half a second ago and is still looking at where the answer will be.
 */
function Block({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-muted/60 ${className}`} />;
}

export function SessionSkeleton({ composer = false }: { composer?: boolean }) {
  return (
    // The same island recipe the cockpit's conversation column uses, so the
    // shell frames this exactly as it will frame the real thing.
    <main data-surfaces className="group/surfaces flex min-h-0 flex-1 overflow-hidden md:overflow-visible md:gap-2" aria-busy="true">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:rounded-xl md:bg-sidebar md:shadow-sm md:ring-1 md:ring-sidebar-border">
        {/* The masthead's own bar: a breadcrumb on the left, controls right. */}
        <div className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Block className="h-4 w-32" />
          <Block className="h-4 w-24" />
          <span className="flex-1" />
          <Block className="size-7" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-4 py-6">
          {composer ? (
            // A CANVAS HAS NO TRANSCRIPT, so a skeleton that draws one promises
            // a conversation that is not coming. The composer sits in the middle
            // of the screen here, which is the shape worth holding.
            <div className="m-auto w-full max-w-[50rem] space-y-3">
              <Block className="mx-auto h-6 w-56" />
              <Block className="h-24 w-full" />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[50rem] space-y-6">
              <div className="flex justify-end">
                <Block className="h-10 w-2/5" />
              </div>
              <div className="space-y-2">
                <Block className="h-4 w-11/12" />
                <Block className="h-4 w-4/5" />
                <Block className="h-4 w-2/3" />
              </div>
              <div className="flex justify-end">
                <Block className="h-8 w-1/3" />
              </div>
              <div className="space-y-2">
                <Block className="h-4 w-10/12" />
                <Block className="h-4 w-3/5" />
              </div>
            </div>
          )}
        </div>
        {!composer && (
          <div className="shrink-0 px-4 pb-4">
            <Block className="mx-auto h-20 w-full max-w-[50rem]" />
          </div>
        )}
      </div>
    </main>
  );
}
