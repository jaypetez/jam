// What a turn says, as one string. A turn can be text → tool → text → tool → text; the CLI's `result` field holds
// only the LAST text block, so using it as the closing message made every earlier block vanish the moment the turn
// ended (2026-10-08: a full answer streamed in, then was replaced by a one-line "I've added this to the notes").
// Blocks are joined with a blank line so "...done." + "Next..." never fuse into "done.Next...".
export const blockSep = streamed => (streamed && !streamed.endsWith("\n\n") ? (streamed.endsWith("\n") ? "\n" : "\n\n") : "");
// The closing text for `done`: everything the model said at the top level; fall back to `result` only when nothing streamed.
export const closingText = (streamed, result) => (String(streamed || "").trim() ? String(streamed).trim() : String(result || "").trim());
