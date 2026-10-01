/**
 * Browser counterpart of the CLI's attention notifier: a system notification
 * (when the user allowed them) and a marked tab title, but only while the page
 * is hidden or unfocused, since a user looking at it needs neither.
 */

const TITLE_MARK = "● ";

function notificationsAvailable(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Ask once, from a user action (sending a message); browsers ignore requests made without one. */
export function requestAttentionPermission(): void {
  if (!notificationsAvailable() || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

export function userIsAway(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

function clearTitleMark(): void {
  if (document.title.startsWith(TITLE_MARK)) document.title = document.title.slice(TITLE_MARK.length);
}

/** The title itself records the mark, so it is never doubled and survives no other state. */
function markTitle(): void {
  if (document.title.startsWith(TITLE_MARK)) return;
  document.title = `${TITLE_MARK}${document.title}`;
  const onReturn = (): void => {
    if (userIsAway()) return;
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
    clearTitleMark();
  };
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onReturn);
}

/**
 * Tell a user who switched away that something needs them. `tag` collapses
 * repeats: several open tabs, or several pending approvals, show one notification.
 */
export function notifyAttention(body: string, tag: string): boolean {
  if (!userIsAway()) return false;
  markTitle();
  if (!notificationsAvailable() || Notification.permission !== "granted") return true;
  try {
    const notification = new Notification("EASY CODE", { body, tag });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the title mark remains.
  }
  return true;
}
