// Small DOM helpers shared by the game page (main.ts) and the replay panel.

/** Sets a label only when it changes. Writing `textContent` replaces the
 *  element's text node even with the same text, and WebKit drops a click
 *  whose mousedown landed on a text node replaced before the mouseup: the
 *  controls redrawn on every worker status or replay progress message
 *  (Pause, ~20 a second) would ignore a press that straddles one. */
export function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
