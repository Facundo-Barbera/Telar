import { FrontDoor } from "./front-door";

/**
 * THE FRONT DOOR IS A COMPOSER, AND NOW IT IS ONLY THAT.
 *
 * It used to be this app's projects table — a panel of registered roots beside a
 * list of sessions labelled with their raw ids. Everything in it was true and
 * none of it was what anybody opened Telar to do. Starting a conversation meant
 * finding a project, finding a button inside it, and only then arriving
 * somewhere you could type; the screen a person wanted was three clicks past the
 * screen they got.
 *
 * The table moved to `/projects` and has now been RETIRED, along with that
 * route. It was the destination of four different actions — a delete, a
 * breadcrumb, a menu item, a dropdown glyph — none of which meant to send
 * anybody to a management screen, and being a real URL it survived reloads. So
 * the app kept resuming on a page nobody had chosen. Every one of those actions
 * now goes somewhere it meant.
 *
 * WHICH PROJECT: the one owning the most recently touched session, else the
 * most recently registered. That is a guess, and it is the same guess the
 * sidebar's new-conversation button already makes, so the two cannot disagree.
 *
 * THE DECISION MOVED TO THE BROWSER (#407), and this route with it. It was a
 * `force-dynamic` server component that awaited two engine reads before
 * answering with a redirect — and it is the FIRST thing the desktop window
 * loads, so that wait was the launch. Nothing here needs a server: the decision
 * is a pure fold (`lib/composer-project.ts`), the reads are ordinary client
 * fetches that can at least run in parallel, and the last visit usually left a
 * note that answers without them. See `front-door.tsx`.
 *
 * THE ONE SCREEN THAT IS NOT A COMPOSER is the case where a composer is
 * impossible: no project to open one against, or an engine that cannot say. See
 * `components/first-run.tsx`.
 */
export default function HomePage() {
  return <FrontDoor />;
}
