/**
 * XTERM.JS 6 THROWS APC AWAY, AND KITTY GRAPHICS IS AN APC.
 *
 * A kitty graphics command is `ESC _ G <keys> ; <base64> ESC \`. xterm.js's
 * parser enters its SOS/PM/APC state on `ESC _` and discards everything up to
 * the terminator; its typings say so ("APC, PM or SOS is currently not
 * supported") and there is no `registerApcHandler`. So the command never
 * reaches anything an addon can register.
 *
 * Rewritten here, before the parser sees it, into an OSC with a number no
 * terminal assigns — `ESC ] 71137 ; G <keys> ; <base64> ESC \`. Only the
 * introducer changes: the body and the ST terminator are valid OSC as they
 * stand. The command is still parsed IN ORDER with the text around it, so an
 * image lands where the cursor is at that byte rather than where it is when
 * some side channel catches up. A program that writes OSC 71137 itself is
 * sending kitty graphics by another name, which it could do anyway.
 *
 * Only `ESC _ G` is touched; any other APC goes through and xterm drops it as
 * before.
 */
export const KITTY_GRAPHICS_OSC = 71137;

const APC_KITTY = "\u001b_G";
const AS_OSC = `\u001b]${KITTY_GRAPHICS_OSC};G`;

/** Stateful per terminal: an introducer can straddle two PTY chunks, so a
 *  trailing `ESC` or `ESC _` is held until the next chunk says what it was. */
export function kittyApcRewriter(): (data: string) => string {
  let held = "";
  return (data) => {
    let text = held + data;
    held = "";
    if (text.endsWith("\u001b")) {
      held = "\u001b";
    } else if (text.endsWith("\u001b_")) {
      held = "\u001b_";
    }
    if (held !== "") text = text.slice(0, -held.length);
    return text.includes(APC_KITTY) ? text.replaceAll(APC_KITTY, AS_OSC) : text;
  };
}
