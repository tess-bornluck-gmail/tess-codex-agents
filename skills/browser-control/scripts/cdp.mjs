import { StringDecoder } from 'node:string_decoder';
import { statSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve as resolvePath, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Node 22+ ships a global WebSocket, so this needs no dependency. Deliberately
 * small: enough to enumerate targets, attach to a page, and evaluate — which
 * is all the verification and selector-probing work requires.
 *
 * Usage:
 *   node cdp/cdp.mjs targets
 *   node cdp/cdp.mjs eval <url-substring> "<expression>"
 *   node cdp/cdp.mjs network <url-substring> [--seconds N] [--filter S] [--sse]
 *   node cdp/cdp.mjs storage <url-substring> [--cookies] [--netscape] [--all]
 */

/**
 * Which browser to talk to.
 *
 * Mutable, because callers can run separate isolated browsers. Port 19223 is
 * the default, and a caller has to be able to choose another without setting
 * an environment variable around the command. `CHROME_PORT` still works and
 * still wins as the ambient default; `--port` overrides it per invocation.
 */
let port = Number(process.env.CHROME_PORT ?? 19223);
setPort(port);

export function setPort(next) {
  const parsed = Number(next);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`bad port: ${next}`);
  port = parsed;
}

export function currentPort() {
  return port;
}

const base = () => `http://127.0.0.1:${port}`;

export async function browserSocketUrl() {
  let res;
  try {
    res = await fetch(`${base()}/json/version`, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new Error(`CDP not reachable on ${base()} — is that browser running?`);
  }
  if (!res.ok) throw new Error(`CDP not reachable on ${base()}`);
  return (await res.json()).webSocketDebuggerUrl;
}

/** One request/response session against a CDP endpoint. */
export class CdpSession {
  #ws;
  #id = 0;
  #pending = new Map();
  #handlers = new Map();

  static async connect(url) {
    const session = new CdpSession();
    session.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      session.#ws.addEventListener('open', resolve, { once: true });
      session.#ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    session.#ws.addEventListener('message', (event) => session.#onMessage(event.data));
    return session;
  }

  #onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    // The session it came from as well: with `flatten`, one socket carries the
    // events of every page and frame attached on it, and an answer to an event
    // (a dialog's) has to go back to the session that raised it.
    this.#handlers.get(msg.method)?.forEach((fn) => fn(msg.params, msg.sessionId));
  }

  on(method, fn) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, []);
    this.#handlers.get(method).push(fn);
  }

  /**
   * Stop listening.
   *
   * Handlers used to only ever be added, which is fine for a watcher that runs
   * for the life of a socket and wrong for one scoped to a single call:
   * `frameTargets` subscribes to `Runtime.executionContextCreated` and is called
   * once per tab in a pick, so without this every tab's subscription would still
   * be live for the next tab's contexts.
   */
  off(method, fn) {
    const list = this.#handlers.get(method);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {{ timeoutMs?: number }} [options] a longer wait, for a call that
   *   is waiting on a *person*: an injected overlay that resolves when the user
   *   clicks or drags takes as long as the user takes. Twenty seconds is right
   *   for a call the browser answers on its own and wrong for one it does not,
   *   and the mismatch is invisible until somebody hesitates — the element
   *   picker documented forty-five seconds of patience and had twenty.
   */
  send(method, params = {}, sessionId, { timeoutMs = 20_000 } = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs).unref?.();
    });
  }

  close() {
    this.#ws.close();
  }
}

/**
 * Target.getTargets sees every target type — including extension service
 * workers, which /json/list omits.
 */
export async function allTargets() {
  const session = await CdpSession.connect(await browserSocketUrl());
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    return targetInfos;
  } finally {
    session.close();
  }
}

/**
 * Which page is frontmost, and which has the keyboard.
 *
 * `Target.getTargets` does not say. Its fields are `targetId, type, title,
 * url, attached, canAccessOpener, browserContextId` — and `attached` is about
 * debugger sessions, not about the user's tab; it reads `false` for the tab
 * you are looking at.
 *
 * So it is asked of the page instead. Measured across seven pages: exactly one
 * per browser window reports `visibilityState === "visible"`, and the rest
 * `hidden`. Two things follow, and both matter:
 *
 *   - **Visible means frontmost in its own window, not globally.** Two windows
 *     give two visible pages and both are right, so the result is grouped by
 *     `Browser.getWindowForTarget`.
 *   - **The side panel is a page too**, is visible, has no window id, and was
 *     the thing holding focus while the active tab reported `hasFocus() ===
 *     false`. Focus and frontmost are different questions.
 *
 * This costs one attach and one `Runtime.evaluate` per page — script execution
 * in every open tab merely to ask. Call it when the answer is needed, not on a
 * timer.
 */
const PROBE_MS = 1_500;

export async function pageActivity(session, pages) {
  const activity = new Map();

  for (const target of pages) {
    let state = { visible: false, focused: false, windowId: null };
    let sessionId = null;
    try {
      ({ sessionId } = await session.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      }));
      const { result } = await session.send(
        'Runtime.evaluate',
        {
          expression: '({ visible: document.visibilityState === "visible", focused: document.hasFocus() })',
          returnByValue: true,
        },
        sessionId,
        // A tab held by a dialog never answers; it is not the one in front.
        { timeoutMs: PROBE_MS },
      );
      state = { ...state, ...(result.value ?? {}) };
      try {
        const win = await session.send('Browser.getWindowForTarget', { targetId: target.targetId });
        state.windowId = win.windowId ?? null;
      } catch {
        // A side panel or a devtools page has no browser window. Leaving this
        // null is what keeps it out of the per-window "active tab" answer.
      }
    } catch {
      // A target that cannot be attached or evaluated is reported as neither
      // visible nor focused rather than failing the whole listing.
    } finally {
      if (sessionId) await session.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    activity.set(target.targetId, state);
  }

  return activity;
}

/** Every page, with its activity — one connection, one probe. */
export async function pagesWithActivity() {
  const session = await CdpSession.connect(await browserSocketUrl());
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');
    const activity = await pageActivity(session, pages);
    return pages.map((t) => ({ ...t, ...activity.get(t.targetId) }));
  } finally {
    session.close();
  }
}

/**
 * Which target a substring means.
 *
 * One rule, because two would drift: `eval` and `network` have to agree about
 * what "chatgpt" refers to when four tabs match it. Pages only by default —
 * evaluating in a service worker is a different thing to want, and matching one
 * by accident would run the expression somewhere surprising. `types` opens it
 * up for the caller that genuinely means "whatever this is": watching the
 * extension's own traffic means attaching to its worker.
 */
export async function pickTarget(session, match, { types = ['page'] } = {}) {
  const { targetInfos } = await session.send('Target.getTargets');
  const matches = targetInfos.filter(
    (t) => types.includes(t.type) && (t.url?.includes(match) || t.title?.includes(match)),
  );
  if (matches.length === 0) {
    const what = types.length === 1 ? `${types[0]} target` : 'target';
    throw new Error(`no ${what} matching "${match}" (open one first)`);
  }

  // With one match there is nothing to choose and no reason to pay for a
  // probe. With several, "first in the list" was a coin flip — four ChatGPT
  // tabs matching "chatgpt.com" is the ordinary case — so prefer the one the
  // user is actually looking at. Only pages can be asked; a worker that
  // matched keeps its place in the list.
  if (matches.length === 1) return matches[0];
  const pages = matches.filter((t) => t.type === 'page');
  if (pages.length === 0) return matches[0];
  const activity = await pageActivity(session, pages);
  return pages.find((t) => activity.get(t.targetId)?.focused)
    ?? pages.find((t) => activity.get(t.targetId)?.visible)
    ?? matches[0];
}

/**
 * Attach to a target, with the native file dialog switched off for the life of
 * the connection.
 *
 * **A file dialog is an OS window, and CDP cannot close one.** Clicking an
 * `<input type="file">` — directly, or by clicking the styled button in front
 * of one — makes Chrome open a Windows dialog that no protocol command can
 * dismiss. The script that clicked is then finished and gone, and what is left
 * on screen is a modal dialog waiting for a person who did not ask for it.
 * `cdp.mjs eval "…#attach').click()"` is enough to cause it.
 *
 * `Page.setInterceptFileChooserDialog` is the way out, and it is prevention
 * rather than a cure: with it on, Chrome fires `Page.fileChooserOpened` and
 * **shows nothing**. So every attach turns it on, not only `upload` — the
 * command that hits this is usually the one that did not know it would.
 *
 * It is **per connection**, which is what makes this safe to do everywhere:
 * when the command exits its socket closes and Chrome goes back to showing
 * dialogs, so a person using that browser by hand still gets one. Nothing has
 * to remember to put it back, and a crash cannot leave it off.
 *
 * Failure is swallowed on purpose. A target that has no `Page` domain — a
 * service worker, which `watchNetwork` attaches to — cannot have a file dialog
 * either, and refusing to attach to it over a dialog it cannot open would break
 * network watching to fix nothing.
 */
export async function attachToPage(session, targetId, { dialogs = dialogPolicy, activate = true } = {}) {
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
  // Forward before anything else is asked: a frozen page answers nothing, and
  // the dialog check below would then blame a dialog that is not there.
  if (activate) await bringToFront(session, targetId, sessionId);
  // Dialogs first: a page held by one answers nothing, the interception
  // included, and this is the call that says so in three seconds, not twenty.
  if (dialogs) await answerDialogs(session, sessionId, dialogs);
  await session.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId, { timeoutMs: DIALOG_ENABLE_MS }).catch(() => {});
  return sessionId;
}

/**
 * Bring a page to the front before anything is asked of it.
 *
 * **A page in the background is a page that may not answer.** Chrome throttles
 * a hidden tab and freezes one left hidden long enough; a site can stop its
 * own work the moment its tab is hidden (D63); and a window covered by another
 * app counts as hidden too. An evaluate sent to such a page sits there until
 * somebody happens to look at that tab, which reads as a command that hangs
 * for no reason and finishes the instant you click on Chrome. So the tab comes
 * forward first, on every command that acts on one, and a run does not depend
 * on what was in front when it started.
 *
 * **Only when it is not already showing.** A page that says `visible` within a
 * second is running and is left where it is, so a poll every few seconds does
 * not drag Chrome over whatever you are working in each time. Anything else —
 * `hidden`, or no answer at all, which is what a frozen page gives — is raised.
 * `Target.activateTarget` is a browser command, answered by the browser and
 * not by the page, so it works on the very page that would answer nothing
 * else; it selects the tab and raises its window. Its failure is swallowed: a
 * target with no tab to bring forward is not a reason to refuse it.
 *
 * Not for the probe that asks which tab is in front, nor for the dialog guard:
 * both look at pages without anyone acting on them, and raising each would
 * change the very answer the probe is there to give.
 *
 * Returns whether it had to raise the page.
 */
export const VISIBLE_MS = 1_000;
export const ACTIVATE_MS = 3_000;

export async function bringToFront(session, targetId, sessionId) {
  const seen = await session.send(
    'Runtime.evaluate',
    { expression: 'document.visibilityState', returnByValue: true },
    sessionId,
    { timeoutMs: VISIBLE_MS },
  ).catch(() => null);
  if (seen?.result?.value === 'visible') return false;
  await session.send('Target.activateTarget', { targetId }, undefined, { timeoutMs: ACTIVATE_MS }).catch(() => {});
  return true;
}

/* ---------- JavaScript dialogs ---------- */

/**
 * An `alert`, `confirm`, `prompt` or "Leave site?" opened by a client command
 * is answered at once by that client.
 *
 * Before, a click evaluated in a page could open one, and then two things went
 * wrong together: the evaluation hung behind it until its twenty seconds ran
 * out, and the dialog stayed in the person's browser, in front of the page,
 * until they closed it themselves.
 *
 * **What was measured, on Chrome 155:**
 *
 *   - A session with `Page` enabled *before* the dialog opens gets
 *     `Page.javascriptDialogOpening`, and `Page.handleJavaScriptDialog` closes
 *     it. The evaluation that opened it then returns as normal.
 *   - **A dialog that opened before the session attached cannot be closed over
 *     CDP.** `Page.enable` never answers (the page's thread is waiting on the
 *     dialog), the event is not sent again, and `handleJavaScriptDialog` says
 *     "No dialog is showing". So the answer has to be in place *before*: on
 *     every attach, and for a while after a command that acted on a page — see
 *     `guardDialogs`.
 *   - **A frame's dialog is raised on the page's session**, not the frame's,
 *     whose `Page` domain has no `handleJavaScriptDialog` at all. So the answer
 *     goes back on whichever session raised it.
 *   - `prompt` accepted with no text answers `""`, not the box's default. A
 *     prompt is answered with its default, as pressing OK without typing does.
 *
 * **Which button.** OK for an alert, which has no other. For the rest, the
 * button that lets the requested action go ahead: OK for a confirm and a
 * prompt, Leave for "Leave site?". The click was the model's choice, and the
 * dialog is the page asking whether it meant it. `--dialog dismiss` presses
 * Cancel (Stay) instead, and `--prompt-text` types an answer into a prompt.
 * Every answer is printed on stderr, so the model reads what the page said.
 *
 * Only while the client is attached. A dialog the person meets in their own browsing
 * is theirs to answer, as the file chooser is (`attachToPage`).
 */
export const DIALOG_ANSWERS = ['accept', 'dismiss'];
/** How long a page has to accept `Page.enable` before it is reported as blocked. */
export const DIALOG_ENABLE_MS = 3_000;
const BUTTONS = {
  alert: ['OK', 'OK'],
  confirm: ['OK', 'Cancel'],
  prompt: ['OK', 'Cancel'],
  beforeunload: ['Leave', 'Stay'],
};

/** How this process answers, set from the command line. Null switches answering off. */
let dialogPolicy = { answer: 'accept', promptText: null };

export function setDialogPolicy({ answer = 'accept', promptText = null } = {}) {
  if (!DIALOG_ANSWERS.includes(answer)) throw new Error(`--dialog takes ${DIALOG_ANSWERS.join(' or ')}, not "${answer}"`);
  dialogPolicy = { answer, promptText: promptText ?? null };
  return dialogPolicy;
}

export function currentDialogPolicy() {
  return dialogPolicy;
}

/** What `Page.handleJavaScriptDialog` is sent for this dialog. */
export function dialogReply(dialog, { answer = 'accept', promptText = null } = {}) {
  const accept = dialog?.type === 'alert' || answer !== 'dismiss';
  const reply = { accept };
  if (dialog?.type === 'prompt' && accept) reply.promptText = promptText ?? dialog.defaultPrompt ?? '';
  return reply;
}

/** `confirm "Delete this?" — pressed OK`, for a person and a model to read. */
export function dialogLine(dialog, reply) {
  const [yes, no] = BUTTONS[dialog?.type] ?? ['OK', 'Cancel'];
  const text = String(dialog?.message ?? '').replace(/\s+/g, ' ').trim();
  const said = text ? ` "${text.length > 200 ? `${text.slice(0, 199)}…` : text}"` : '';
  const typed = reply.promptText !== undefined ? `, answering "${reply.promptText}"` : '';
  return `${dialog?.type ?? 'dialog'}${said} — pressed ${reply.accept ? yes : no}${typed}`;
}

const isTimeout = (err) => /timed out/.test(err?.message ?? '');

/**
 * Answer every dialog the page on `sessionId` opens while this socket is
 * attached to it. Returns a function that stops answering.
 *
 * A page that does not take `Page.enable` within `enableMs` is reported as
 * blocked rather than waited on for twenty seconds: by far the likeliest
 * reason is a dialog already on screen, which nothing here can close. A target
 * with no `Page` domain (a worker) fails fast and is attached without.
 */
export async function answerDialogs(session, sessionId, policy = dialogPolicy, {
  enableMs = DIALOG_ENABLE_MS,
  onAnswer = (line) => console.error(`[cdp] dialog: ${line}`),
} = {}) {
  const onDialog = (dialog, from) => {
    if (from && from !== sessionId) return;
    const reply = dialogReply(dialog, policy);
    session.send('Page.handleJavaScriptDialog', reply, sessionId)
      .then(() => onAnswer(dialogLine(dialog, reply), dialog, reply))
      // Already answered by another client session on the same page.
      .catch(() => {});
  };
  session.on('Page.javascriptDialogOpening', onDialog);
  const stop = () => session.off?.('Page.javascriptDialogOpening', onDialog);
  try {
    await session.send('Page.enable', {}, sessionId, { timeoutMs: enableMs });
  } catch (err) {
    stop();
    if (!isTimeout(err)) return () => {};
    throw Object.assign(new Error(
      'the page is not answering — most likely a dialog (an alert, a confirm, "Leave site?") '
      + 'opened while the client was not attached. CDP can only answer a dialog it saw open, so this '
      + 'one needs a person: ask the user to close it, then try again.',
    ), { code: 'page_blocked' });
  }
  return stop;
}

/* ---------- the dialog guard ---------- */

/**
 * Keep answering a page's dialogs for a while after a command has ended.
 *
 * A click's own dialog opens while the command is still attached and is
 * answered there. The one that comes later — "Saved!" after a request, a
 * confirm behind a timer — would open with nobody attached, and then nothing
 * can close it (see above). So `eval` and `upload` leave a guard behind: a
 * small detached process attached to that one page, answering as the command
 * would have, until `GUARD_MS` after the last command that touched it.
 *
 * **One guard per page.** A lease file names its pid and the time it runs to;
 * a later command on the same page moves the time on instead of starting a
 * second guard. The command that starts one waits until it is attached
 * (`ready`), still answering itself meanwhile, so no dialog falls between the
 * two. What a guard answered is written beside the lease, and the next command
 * on that page prints it.
 */
export const GUARD_MS = 15_000;
/** How long a command waits for a new guard to say it is attached. */
const GUARD_READY_MS = 3_000;
const GUARD_POLL_MS = 250;

export function guardDir() {
  return join(tmpdir(), 'browser-control-cdp-guard');
}

/** The lease and the log for one page of one browser. A target id is hex; anything else is not trusted into a name. */
export function guardFiles(targetId, { port: p = port, dir = guardDir() } = {}) {
  const safe = String(targetId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('no target to guard');
  return { lease: join(dir, `${p}-${safe}.json`), log: join(dir, `${p}-${safe}.log`) };
}

function readLease(path) {
  try {
    const lease = JSON.parse(readFileSync(path, 'utf8'));
    return lease && Number.isInteger(lease.pid) && Number.isFinite(lease.until) ? lease : null;
  } catch {
    return null;
  }
}

function writeLease(path, lease) {
  // Whole or not at all: the guard reads this file four times a second.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(lease));
  renameSync(temp, path);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

/** What a guard answered since the last command on this page, cleared as it is read. */
export function takeGuardLog(targetId, options) {
  const { log } = guardFiles(targetId, options);
  let text = '';
  try {
    text = readFileSync(log, 'utf8');
    unlinkSync(log);
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line).line;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Make sure a guard is watching `targetId` until `ms` from now: move the
 * running one's time on, or start one and wait for it to attach.
 */
export async function guardDialogs(targetId, {
  ms = GUARD_MS,
  policy = dialogPolicy,
  dir = guardDir(),
  now = Date.now,
  isAlive = alive,
  start = startGuard,
  readyMs = GUARD_READY_MS,
} = {}) {
  if (!policy) return 'off';
  mkdirSync(dir, { recursive: true });
  const { lease: path } = guardFiles(targetId, { dir });
  const until = now() + ms;
  const lease = readLease(path);
  if (lease && lease.until > now() && isAlive(lease.pid)) {
    writeLease(path, { ...lease, until: Math.max(lease.until, until) });
    return 'extended';
  }
  const pid = start(targetId, policy);
  if (!pid) return 'failed';
  writeLease(path, { pid, until, ready: false });
  const deadline = now() + readyMs;
  while (now() < deadline) {
    if (readLease(path)?.ready) return 'started';
    await new Promise((r) => setTimeout(r, 25));
  }
  return 'slow';
}

/** Start a guard process for one page, detached, with nothing tying it to this one. */
function startGuard(targetId, policy) {
  const script = fileURLToPath(import.meta.url);
  const args = [script, 'guard', targetId, '--port', String(port), '--dialog', policy.answer];
  if (policy.promptText !== null && policy.promptText !== undefined) args.push('--prompt-text', policy.promptText);
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/**
 * The guard itself: attach to the page, answer its dialogs, and leave when the
 * lease runs out, names another process, or the page goes away.
 */
export async function runGuard(targetId, {
  connect = null,
  policy = dialogPolicy,
  dir = guardDir(),
  now = Date.now,
  pollMs = GUARD_POLL_MS,
} = {}) {
  const { lease: path, log } = guardFiles(targetId, { dir });
  const mine = () => {
    const lease = readLease(path);
    return lease && lease.pid === process.pid ? lease : null;
  };
  const session = connect ? await connect() : await CdpSession.connect(await browserSocketUrl());
  let gone = false;
  const onGone = (params) => { if (params?.targetId === targetId) gone = true; };
  session.on('Target.targetDestroyed', onGone);
  session.on('Target.detachedFromTarget', onGone);
  try {
    await session.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
    await answerDialogs(session, sessionId, policy, {
      onAnswer: (line) => appendFileSync(log, `${JSON.stringify({ at: now(), line })}\n`),
    });
    const lease = mine();
    if (lease) writeLease(path, { ...lease, ready: true });
    for (;;) {
      const current = mine();
      if (!current || current.until <= now() || gone) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    if (mine()) {
      try {
        unlinkSync(path);
      } catch { /* already gone */ }
    }
    session.close();
  }
}

/**
 * Attach to a page target and evaluate an expression in it.
 *
 * **A page is not one document, and this does not make the caller say so.** The
 * expression runs in the top frame; when the top frame answers `null` or throws
 * — the two shapes "that element is not here" takes — it is run again in each
 * frame of the page, nested ones included, until one answers. The frame that
 * answered is named on stderr, so stdout stays the value and nothing has to
 * parse a note out of it.
 *
 * `frame` pins it to one frame instead, named by index or by a substring of its
 * url, and then there is no fall-through at all. Two reasons to pin:
 *
 *   - **a side effect that must happen once.** The fall-through is safe for a
 *     read and cannot be safe for every write, which is why `undefined` is not
 *     a miss: `el.click()` evaluates to `undefined`, and treating that as "not
 *     here" would click in every frame of the page. An expression that throws
 *     *after* doing something is the case this cannot protect — pin it.
 *   - **cost.** Falling through enumerates the frames, which is an attach and a
 *     `Runtime.enable` per out-of-process frame. A hit in the top frame pays
 *     none of that and costs exactly what it always did.
 *
 * A `frame` that matches nothing is a **named failure listing the frames**,
 * never a quiet fall back to the top one — that would evaluate somewhere the
 * caller did not ask for and report it as though it had.
 */
export async function evaluateIn(match, expression, { frame = null, connect = null, guard = null } = {}) {
  // `connect` allows tests to supply an isolated protocol session.
  const session = connect ? await connect() : await CdpSession.connect(await browserSocketUrl());
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
    // Chrome gates a handful of extension APIs on a user gesture, and
    // `chrome.sidePanel.open()` is one of them. Reloading the extension
    // closes the side panel, and without this there is no way to put it
    // back from a script — the only route is a human clicking the icon,
    // which makes every reload a manual step in the middle of automated
    // verification. `Runtime.evaluate` can supply the gesture; it costs
    // nothing for the ordinary read-only evaluation.
    userGesture: true,
  };

  /**
   * Did this document not have what the expression was looking for?
   *
   * `null` and a thrown error, and deliberately **not** `undefined`. Those two
   * are what a miss looks like — `querySelector` returns `null`, and reading a
   * property off that `null` throws — while `undefined` is what a completed
   * statement looks like. `subtype` rather than the value, because a returned
   * `undefined` and a returned `null` arrive as the same `value` over the wire
   * and only the type tells them apart.
   */
  const missed = (result) => Boolean(result.exceptionDetails) || result.result?.subtype === 'null';
  const threw = (result) => new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');

  let target = null;
  let acted = false;
  try {
    target = await pickTarget(session, match);
    reportGuardLog(target.targetId);

    if (frame !== null && frame !== undefined && frame !== '') {
      const { frames, detach } = await frameTargets(session, target.targetId);
      acted = Boolean(frames[0]?.sessionId);
      try {
        const wanted = findFrame(frames, frame);
        if (!wanted) {
          throw new Error(`no frame matching "${frame}" in ${shortUrl(target.url)}\n${framesReport(frames)}`);
        }
        const result = await evaluateInFrame(session, wanted, params);
        if (result.exceptionDetails) throw threw(result);
        return result.result.value;
      } finally {
        await detach();
      }
    }

    const sessionId = await attachToPage(session, target.targetId);
    acted = true;
    const top = await session.send('Runtime.evaluate', params, sessionId);
    if (!missed(top)) {
      if (top.exceptionDetails) throw threw(top);
      return top.result.value;
    }

    // The top frame did not have it. Try the rest, in enumeration order.
    const { frames, detach } = await frameTargets(session, target.targetId);
    try {
      for (const candidate of frames) {
        if (candidate.index === 0 || !candidate.sessionId) continue;
        let result;
        try {
          result = await evaluateInFrame(session, candidate, params);
        } catch {
          // A frame that went away between the listing and the evaluation is
          // not the answer and is not a failure either.
          continue;
        }
        if (missed(result)) continue;
        // Which document answered, on stderr: a caller redirecting stdout to a
        // file gets the value and nothing else, the same split `storage` uses
        // for its warning.
        console.error(`[cdp] found in frame ${candidate.index} — ${shortUrl(candidate.url)}`);
        return result.result.value;
      }
      const tried = frames.filter((f) => f.index > 0 && f.sessionId).length;
      if (tried > 0) {
        console.error(`[cdp] not found in the top frame or any of its ${tried} frame${tried === 1 ? '' : 's'}`);
      }
    } finally {
      await detach();
    }

    // Nothing anywhere: the top frame's own answer, because that is the document
    // the caller named. A thrown error from a frame would point at a document
    // they never asked about.
    if (top.exceptionDetails) throw threw(top);
    return top.result.value;
  } finally {
    // Still attached and answering while the guard starts, so nothing the
    // expression set off can open in the gap between the two.
    if (guard && acted) await guard(target.targetId).catch(() => {});
    session.close();
  }
}

/** What a guard answered while no command was running, said before this one's own output. */
function reportGuardLog(targetId) {
  for (const line of takeGuardLog(targetId)) console.error(`[cdp] dialog, after the last command: ${line}`);
}

/**
 * Every path, absolute and confirmed to exist, or a named failure.
 *
 * Chrome takes `DOM.setFileInputFiles` paths as given and **does not check
 * them**: a typo attaches a file the page believes in and cannot read, and the
 * failure surfaces as the site's own upload error a step later, where it looks
 * like the site is broken. Resolved against the working directory first,
 * because a relative path is what a person types and an absolute one is the
 * only thing the browser can use.
 */
export function resolveUploads(paths, { stat = statSync } = {}) {
  if (!paths?.length) throw new Error('upload needs at least one file path');
  return paths.map((given) => {
    const path = isAbsolute(given) ? given : resolvePath(given);
    let info;
    try {
      info = stat(path);
    } catch {
      throw new Error(`no file at ${path}`);
    }
    if (info.isDirectory()) throw new Error(`${path} is a folder, and an upload takes files`);
    return path;
  });
}

/**
 * Attach files to a page without a dialog ever opening.
 *
 * **The obvious way does not exist.** `input.value = 'C:\\x.txt'` is forbidden
 * by the HTML spec — a page may not state a path it was not given, which is the
 * same wall [D205] hit from the other side — so no expression passed to `eval`
 * can do this. `DOM.setFileInputFiles` is the way: it hands the browser real
 * paths beneath the page, and the `change` event the site listens for fires as
 * though a person had picked them.
 *
 * Two ways in, because sites are built two ways:
 *
 *   - **`selector`** names the `<input type="file">` itself. Cheapest, and it
 *     works on an input that is hidden, which most of them are.
 *   - **`click`** names whatever the person would press. Interception is
 *     already on from the attach, so the click opens no dialog: Chrome fires
 *     `Page.fileChooserOpened` naming the input's `backendNodeId`, and the
 *     files go to that. This is the only route for an input built on demand by
 *     the click, one inside a closed shadow root, or a site using
 *     `showOpenFilePicker()`, which has no input element at all.
 *
 * The wait is short and named. `fileChooserOpened` not arriving means the click
 * landed on something that does not open a chooser — a selector that matched
 * the wrong element — and saying so beats hanging until the socket times out.
 */
export async function uploadFiles(match, paths, {
  selector = null,
  click = null,
  connect = null,
  chooserWaitMs = 5_000,
  guard = null,
} = {}) {
  if (!selector && !click) throw new Error('upload needs --selector <css> or --click <css>');
  if (selector && click) throw new Error('--selector and --click are two ways in; name one');
  const files = resolveUploads(paths);

  const session = connect ? await connect() : await CdpSession.connect(await browserSocketUrl());
  let target = null;
  let acted = false;
  try {
    target = await pickTarget(session, match);
    reportGuardLog(target.targetId);
    const sessionId = await attachToPage(session, target.targetId);
    acted = true;
    await session.send('DOM.enable', {}, sessionId).catch(() => {});
    await session.send('Page.enable', {}, sessionId).catch(() => {});

    if (selector) {
      const { root } = await session.send('DOM.getDocument', { depth: 0 }, sessionId);
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
      if (!nodeId) throw new Error(`no element matching "${selector}" in ${shortUrl(target.url)}`);
      await session.send('DOM.setFileInputFiles', { files, nodeId }, sessionId);
      return { files, via: 'selector', target: target.url };
    }

    // The event can arrive before `Runtime.evaluate` returns, so the listener
    // goes on first. Waiting for the click to resolve and *then* subscribing
    // is the race that makes this work nine times in ten.
    let resolveChooser;
    const chooser = new Promise((done) => { resolveChooser = done; });
    const onOpened = (params) => resolveChooser(params);
    session.on('Page.fileChooserOpened', onOpened);
    try {
      const clicked = await session.send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(click)});
          if (!el) return 'missing'; el.click(); return 'clicked'; })()`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }, sessionId);
      if (clicked.result?.value === 'missing') {
        throw new Error(`no element matching "${click}" in ${shortUrl(target.url)}`);
      }

      // Deliberately not `unref`ed. An unreferenced timer does not hold the
      // event loop open, so with nothing else pending the process exits before
      // the rejection can fire and the failure becomes a silent success — it
      // only looked right here because a live socket was holding the loop up.
      let timer = null;
      const deadline = new Promise((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`"${click}" was clicked and no file chooser opened — is that the right element?`)),
          chooserWaitMs,
        );
      });
      let opened;
      try {
        opened = await Promise.race([chooser, deadline]);
      } finally {
        clearTimeout(timer);
      }
      const backendNodeId = opened?.backendNodeId;
      if (!backendNodeId) throw new Error('the file chooser named no input to attach to');
      await session.send('DOM.setFileInputFiles', { files, backendNodeId }, sessionId);
      return { files, via: 'click', target: target.url };
    } finally {
      session.off('Page.fileChooserOpened', onOpened);
    }
  } finally {
    if (guard && acted) await guard(target.targetId).catch(() => {});
    session.close();
  }
}

/**
 * Close a native file dialog that is already on screen.
 *
 * The one thing `uploadFiles` cannot do for itself. Interception stops the
 * *next* dialog; a dialog already open belongs to Windows, and every CDP
 * command will go on working around it while it sits there. Delegated to
 * PowerShell because UI Automation is where the ability lives; see the header
 * of `dismiss-dialog.ps1` for why it is not SendKeys.
 */
export async function dismissDialogs({ run = null, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    throw Object.assign(new Error(`no dialog to close on ${platform} — this is a Windows dialog`), {
      code: 'dismiss_unsupported',
    });
  }
  let ownerPid;
  if (!run) {
    const session = await CdpSession.connect(await browserSocketUrl());
    try {
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      ownerPid = processInfo.find((entry) => entry.type === 'browser')?.id;
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error('cannot identify the selected browser process');
    } finally {
      session.close();
    }
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), 'dismiss-dialog.ps1');
  const exec = run ?? ((args) => new Promise((done, fail) => {
    execFile('powershell', args, { windowsHide: true }, (err, stdout) => (err ? fail(err) : done(stdout)));
  }));
  const out = await exec([
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ...(ownerPid ? ['-OwnerPid', String(ownerPid)] : []),
  ]);
  let answer;
  try {
    answer = JSON.parse(String(out).trim());
  } catch {
    throw Object.assign(new Error(`could not read the dismisser's answer: ${String(out).trim().slice(0, 200)}`), {
      code: 'dismiss_unreadable',
    });
  }
  if (!answer.ok) throw Object.assign(new Error(answer.detail ?? answer.error), { code: answer.error });
  return answer;
}

/* ---------- frames ---------- */

/**
 * How many frames one page is allowed to cost.
 *
 * Each one is an attach, or an `executionContextCreated` to match up, and the
 * element picker injects into every one of them. An ad-heavy page can carry
 * dozens of frames that no pointer will ever enter, so this is a ceiling on the
 * work rather than a claim about pages — when it is hit, the listing says so
 * instead of quietly stopping at forty.
 */
const MAX_FRAMES = 40;

/**
 * Every frame of a page, flattened, with how to evaluate in each one.
 *
 * A page is not one document: `Runtime.evaluate` on a page target runs in the **top frame's main
 * world and nowhere else**, so an element inside an iframe could not be marked,
 * read or clicked, and `querySelector` for a mark that was in a frame came back
 * `null` — which reads exactly like the element being gone.
 *
 * Chrome exposes frames two different ways, and both are needed. Measured on
 * Chrome 152 against a page holding one same-origin frame, one cross-origin
 * frame on another port, one cross-*site* frame, and a nested frame inside
 * that:
 *
 *   - **Same-process frames** — same origin, and also cross-origin but
 *     same-site, because a site is scheme plus registrable domain and a *port*
 *     is no part of it. They do not get their own target. They appear in
 *     `Page.getFrameTree`, and `Runtime.enable` on the page's session replays
 *     one `Runtime.executionContextCreated` per frame carrying
 *     `auxData.frameId` and `auxData.isDefault` — that context id is the
 *     frame's main world, and `Runtime.evaluate` with it lands in the right
 *     document.
 *   - **Out-of-process frames** — cross-site, so `localhost` and `127.0.0.1`
 *     count as two sites. These are separate targets of type `iframe`, which
 *     `isTab`-style filtering drops. They are **absent from the parent's frame
 *     tree**, so the tree alone cannot find them.
 *
 * `Target.setAutoAttach` is the documented way to reach the second kind and is
 * deliberately **not** used: measured on a browser with nothing attached and no
 * auto-attach anywhere, `Target.getTargets` already lists every out-of-process
 * frame, each carrying `parentFrameId`/`parentId` naming its parent — including
 * a frame nested inside another frame — and attaching to one by id and
 * evaluating in it just works. So one call gives the whole tree with its parent
 * links, where auto-attach would need an event subscription per level, and
 * would have to recover a `sessionId` that only arrives on an event.
 *
 * **Main world, not an isolated one.** `Page.createIsolatedWorld` would be
 * shorter and would work for the picker, because an isolated world shares the
 * DOM — and it would quietly not work for `eval`, where reaching the page's own
 * globals is the point, so evaluation must use its main world.
 *
 * `index` is a deterministic walk — parents before children, same-process
 * children before out-of-process ones — and `0` is always the top frame. It is
 * the handle a person and a model can say out loud, and that is all it is: a
 * `frameId` does not survive a reload, and neither does an `iframe` target id.
 * The **url** is the durable identity, which is why `--frame` takes either.
 *
 * A frame that cannot be attached, or whose context never arrives, is returned
 * with a `why` and no way to evaluate — never dropped. A frame that is silently
 * absent would make an unreadable frame indistinguishable from a missing one.
 *
 * Returns `{ frames, detach }`. Everything it attached, `detach()` releases;
 * `frames[0].sessionId` is the page's own session, so a caller that wanted only
 * that still has it.
 */
export async function frameTargets(session, targetId, { contextWaitMs = 500 } = {}) {
  const opened = [];
  const frames = [];
  let truncated = false;

  const detach = async () => {
    // Children first: detaching a parent drops its children anyway, and doing
    // it in this order means a failure to release one does not skip the rest.
    for (const sessionId of [...opened].reverse()) {
      await session.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    opened.length = 0;
  };

  // Out-of-process frames, grouped by the frame they hang under.
  const { targetInfos } = await session.send('Target.getTargets');
  const childFramesOf = new Map();
  for (const info of targetInfos) {
    if (info.type !== 'iframe') continue;
    const parent = info.parentFrameId ?? info.parentId;
    if (!parent) continue;
    if (!childFramesOf.has(parent)) childFramesOf.set(parent, []);
    childFramesOf.get(parent).push(info);
  }

  /**
   * Walk one target: its own frame tree, then the out-of-process frames under
   * each of its frames — which are walked the same way, because an
   * out-of-process frame is a target with a frame tree of its own.
   */
  const walkTarget = async (id, { name = '', kind = 'top' } = {}) => {
    if (frames.length >= MAX_FRAMES) { truncated = true; return; }

    let sessionId = null;
    try {
      // The page comes forward; a frame inside it has no tab of its own.
      sessionId = await attachToPage(session, id, { activate: kind === 'top' });
      opened.push(sessionId);
    } catch (err) {
      frames.push({
        index: frames.length, frameId: id, url: '', name, kind,
        sessionId: null, contextId: null, why: err?.message ?? 'could not attach',
      });
      return;
    }

    // `Runtime.enable` is what makes the per-frame contexts knowable at all:
    // the events it replays are the only place `frameId` is tied to a context
    // id. Turned off again on the way out, so the page is left as it was found.
    const contexts = new Map();
    const onContext = (params) => {
      const aux = params?.context?.auxData;
      if (aux?.isDefault && aux.frameId) contexts.set(aux.frameId, params.context.id);
    };
    session.on('Runtime.executionContextCreated', onContext);
    let tree = null;
    try {
      await session.send('Runtime.enable', {}, sessionId);
      await session.send('Page.enable', {}, sessionId);
      ({ frameTree: tree } = await session.send('Page.getFrameTree', {}, sessionId));
    } catch (err) {
      session.off('Runtime.executionContextCreated', onContext);
      frames.push({
        index: frames.length, frameId: id, url: '', name, kind,
        sessionId, contextId: null, why: err?.message ?? 'the target would not answer',
      });
      return;
    }

    /**
     * The contexts arrive as notifications, not as the reply to `enable`.
     *
     * In practice they land before it resolves, and "in practice" is not a
     * guarantee worth a frame that silently cannot be evaluated in. So any
     * frame still missing one is waited for, briefly, and then reported as
     * missing rather than assumed.
     */
    const wanted = [];
    const collect = (node) => {
      wanted.push(node.frame);
      for (const child of node.childFrames ?? []) collect(child);
    };
    collect(tree);
    const deadline = Date.now() + contextWaitMs;
    while (wanted.some((f) => !contexts.has(f.id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    session.off('Runtime.executionContextCreated', onContext);

    const emit = async (node, depth) => {
      if (frames.length >= MAX_FRAMES) { truncated = true; return; }
      const frame = node.frame;
      const contextId = contexts.get(frame.id) ?? null;
      frames.push({
        index: frames.length,
        frameId: frame.id,
        url: frame.url ?? '',
        name: frame.name ?? (depth === 0 ? name : ''),
        // The target's own main frame keeps the kind it was walked as; anything
        // below it in this tree is same-process by definition.
        kind: depth === 0 ? kind : 'same-process',
        sessionId,
        contextId,
        // The session's default context *is* the target's main frame, so that
        // one is evaluable with no context id at all. A subframe is not.
        ...(contextId || depth === 0 ? {} : { why: 'no execution context' }),
      });
      for (const child of node.childFrames ?? []) await emit(child, depth + 1);
      for (const oopif of childFramesOf.get(frame.id) ?? []) {
        await walkTarget(oopif.targetId, { name: oopif.title ?? '', kind: 'oopif' });
      }
    };
    await emit(tree, 0);

    await session.send('Runtime.disable', {}, sessionId).catch(() => {});
  };

  try {
    await walkTarget(targetId, { kind: 'top' });
  } catch (err) {
    await detach();
    throw err;
  }
  if (truncated) frames.truncated = true;
  return { frames, detach };
}

/**
 * Evaluate in one frame, whichever of the two kinds it is.
 *
 * The only place that knows the pairing: an out-of-process frame is reached
 * through its own session with no context id, and a same-process subframe
 * through the page's session *with* one. Every call site went through here so
 * that none of them has to remember which.
 */
export function evaluateInFrame(session, frame, params, options) {
  if (!frame?.sessionId) {
    throw new Error(`frame ${frame?.index ?? '?'} cannot be evaluated in (${frame?.why ?? 'no session'})`);
  }
  return session.send(
    'Runtime.evaluate',
    { ...params, ...(frame.contextId ? { contextId: frame.contextId } : {}) },
    frame.sessionId,
    options,
  );
}

/**
 * Which frame a `--frame` means: an index, or a substring of its url or name.
 *
 * Nothing is `null` rather than the top frame. Defaulting to the top frame on a
 * miss is the one behaviour that must not happen here: the evaluation would
 * succeed, `querySelector` would return `null`, and that reads as "the element
 * is gone" — which sends the caller off hunting for an element that is sitting
 * exactly where it was left, one document over.
 */
export function findFrame(frames, wanted) {
  if (wanted === null || wanted === undefined || wanted === '') return frames[0] ?? null;
  const asText = String(wanted).trim();
  // An index first, then the same string as a fragment — because a url fragment
  // is often all digits. `--frame 8904` means the frame served from that port,
  // and reading it as an index that does not exist would have refused a request
  // that names exactly one frame.
  if (/^[0-9]+$/.test(asText)) {
    const byIndex = frames.find((f) => f.index === Number(asText));
    if (byIndex) return byIndex;
  }
  const needle = asText.toLowerCase();
  return frames.find((f) => (f.url ?? '').toLowerCase().includes(needle))
    ?? frames.find((f) => (f.name ?? '').toLowerCase() === needle)
    ?? null;
}

/** The frame listing, one line each — printed by `frames`, and by a failed `--frame`. */
export function framesReport(frames) {
  const lines = frames.map((f) => [
    String(f.index).padStart(3),
    (f.kind ?? '').padEnd(13),
    f.name ? `"${f.name.slice(0, 18)}"`.padEnd(20) : ''.padEnd(20),
    shortUrl(f.url || '(no url)', 70),
    f.why ? `  — unreachable: ${f.why}` : '',
  ].join(' '));
  if (frames.truncated) lines.push(`  (stopped at ${MAX_FRAMES} frames)`);
  return lines.join('\n');
}

/** Every frame of the page a substring names. */
export async function listFrames(match) {
  const session = await CdpSession.connect(await browserSocketUrl());
  try {
    const target = await pickTarget(session, match);
    const { frames, detach } = await frameTargets(session, target.targetId);
    try {
      return { target: { id: target.targetId, url: target.url, title: target.title }, frames };
    } finally {
      await detach();
    }
  } finally {
    session.close();
  }
}

/* ---------- network observation ---------- */

/**
 * Watching what a page actually sends.
 *
 * The DOM says what a site looks like; this says what it *did*. The two hardest
 * measurements this repository has needed were network questions asked through
 * a keyhole: whether ChatGPT had accepted a 200 KB message or was still holding
 * it ([D139], answered by pressing send and counting seconds), and whether an
 * SSE stream was alive or the worker had gone ([D146], answered by adding a
 * keepalive and watching the symptom stop). Both were answerable directly.
 *
 * Deliberately a reducer over events rather than a printer: the same fold runs
 * against synthetic events in a test and against Chrome at a keyboard, so the
 * accounting is checked without a browser and only the formatting is left to be
 * looked at.
 */

/** Bytes, in the coarsest unit that is still true. */
export function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** How long something took, same rule. */
export function took(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/**
 * A URL short enough for a terminal and still identifiable.
 *
 * The head and the tail, never the head alone: a chat backend's URLs differ in
 * their last segment and agree for the first sixty characters, so truncating
 * from the right renders every one of them the same line.
 */
export function shortUrl(url, max = 64) {
  const text = String(url ?? '');
  if (text.length <= max) return text;
  const keepEnd = Math.max(12, Math.floor(max / 2) - 2);
  return `${text.slice(0, max - keepEnd - 1)}…${text.slice(-keepEnd)}`;
}

/**
 * Fold CDP network events into records, and say what is worth printing.
 *
 * `apply` returns the entries a caller should show — an array, because one
 * event can be worth two lines and most are worth none. Nothing is printed from
 * in here: a reducer that writes to a console cannot be tested.
 */
/**
 * Bodies worth reading as they arrive.
 *
 * A stream is the only response whose *content* is interesting before it ends —
 * everything else can be read afterwards, in devtools, at leisure.
 */
const STREAM_TYPES = ['text/event-stream', 'application/x-ndjson', 'application/stream+json'];

/**
 * @param {object} [options]
 * @param {(requestId: string) => void} [options.onStreamable] told when a
 *   response is a stream the watcher should ask Chrome to forward the body of.
 *   A callback rather than a returned entry, because it is an instruction to
 *   the caller and not a thing to print — and because the fold stays testable
 *   with a spy where a CDP call inside it would not.
 */
export function createNetworkLog({
  filter = null,
  sse = false,
  now = () => Date.now(),
  onStreamable = null,
} = {}) {
  const started = now();
  const records = new Map();
  const order = [];
  let hidden = 0;

  const wanted = (record) => !filter || (record?.url ?? '').includes(filter);
  const since = () => now() - started;
  const find = (requestId) => records.get(requestId) ?? null;

  const open = (requestId, fields) => {
    const existing = records.get(requestId);
    if (existing) return Object.assign(existing, fields);
    const created = {
      requestId,
      url: '',
      method: '',
      type: '',
      status: null,
      mime: '',
      size: 0,
      messages: 0,
      error: null,
      startedAt: since(),
      endedAt: null,
      ...fields,
    };
    records.set(requestId, created);
    order.push(created);
    return created;
  };

  /** One decoder per response, for the same reason the shell runner has one per stream. */
  const decoderFor = (r) => {
    r.decoder ??= new StringDecoder('utf8');
    return r.decoder;
  };

  /**
   * Complete SSE frames out of a running body, leaving the tail buffered.
   *
   * A frame is `event:`/`data:` lines up to a blank line. Anything that is not
   * SSE — ndjson, a stream of bare lines — falls back to one frame per line,
   * which is the honest reading of a format this has no business parsing.
   */
  const frames = (r, text) => {
    r.buffer = (r.buffer ?? '') + text;
    const out = [];
    if (r.mime === 'text/event-stream') {
      const blocks = r.buffer.split(/\r?\n\r?\n/);
      r.buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        let event = 'message';
        const data = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          // A `: keepalive` comment is a line with no field, and it is exactly
          // what D146 added — worth seeing, since its absence is the bug.
          else if (line.startsWith(':')) out.push({ event: 'comment', data: line.slice(1).trim() });
        }
        if (data.length) out.push({ event, data: data.join('\n') });
      }
      return out;
    }
    const lines = r.buffer.split(/\r?\n/);
    r.buffer = lines.pop() ?? '';
    return lines.filter((l) => l.trim()).map((l) => ({ event: 'line', data: l }));
  };

  const entry = (phase, r, extra = {}) => ({
    at: since(),
    phase,
    url: r?.url ?? '',
    method: r?.method ?? '',
    type: r?.type ?? '',
    status: r?.status ?? null,
    mime: r?.mime ?? '',
    size: r?.size ?? 0,
    ms: (r?.endedAt ?? since()) - (r?.startedAt ?? 0),
    ...extra,
  });

  return {
    /** @returns {Array<object>} the entries worth showing, in order */
    apply(method, params = {}) {
      switch (method) {
        case 'Network.requestWillBeSent': {
          // A redirect reuses the request id, so the hop before it is closed
          // here — or it stays open forever and the summary reports a hang that
          // is really a 301.
          const out = [];
          const previous = find(params.requestId);
          if (previous && params.redirectResponse) {
            previous.status = params.redirectResponse.status ?? previous.status;
            previous.endedAt = since();
            if (wanted(previous)) out.push(entry('redirect', previous));
            records.delete(params.requestId);
          }
          const r = open(params.requestId, {
            url: params.request?.url ?? '',
            method: params.request?.method ?? '',
            type: params.type ?? '',
            startedAt: since(),
          });
          if (!wanted(r)) {
            hidden += 1;
            return out;
          }
          out.push(entry('start', r));
          return out;
        }

        case 'Network.responseReceived': {
          const r = find(params.requestId);
          if (!r) return [];
          r.status = params.response?.status ?? null;
          r.mime = params.response?.mimeType ?? '';
          r.type = params.type ?? r.type;
          // Chrome reports `eventSourceMessageReceived` only for a real
          // `EventSource`. Some applications read streams with `fetch` and a reader,
          // which is the case this tool most needs to show — so the body is
          // asked for explicitly. Only for a stream, only when the payloads
          // were asked for, and only if it passes the filter: forwarding
          // response bodies is not free.
          if (sse && wanted(r) && STREAM_TYPES.includes(r.mime)) {
            r.streaming = true;
            onStreamable?.(params.requestId);
          }
          // Nothing printed. A response is the *beginning* of the answer, and
          // for a stream it is followed by minutes of body; one line when it
          // ends says more than two lines wrapped around the whole thing.
          return [];
        }

        case 'Network.dataReceived': {
          const r = find(params.requestId);
          if (!r) return [];
          r.size += params.encodedDataLength || params.dataLength || 0;
          // `data` is here only once `streamResourceContent` has been asked
          // for, and it is base64 of *bytes*: a chunk boundary can fall inside
          // a character as easily as inside a JSON object, so both are
          // buffered. The same split that needed a `StringDecoder` in the shell
          // runner needs one here.
          if (!params.data) return [];
          const text = decoderFor(r).write(Buffer.from(params.data, 'base64'));
          if (!text) return [];
          const seen = frames(r, text);
          r.messages += seen.length;
          return seen.map((f) => entry('sse', r, f));
        }

        case 'Network.loadingFinished': {
          const r = find(params.requestId);
          if (!r) return [];
          if (params.encodedDataLength) r.size = Math.max(r.size, params.encodedDataLength);
          r.endedAt = since();
          return wanted(r) ? [entry('end', r)] : [];
        }

        case 'Network.loadingFailed': {
          const r = find(params.requestId);
          if (!r) return [];
          r.endedAt = since();
          // Cancelled is not failed. A page navigating away, or a stream the
          // user stopped, reports the same event as a DNS failure — calling
          // both "failed" makes the summary cry wolf on every reload.
          r.error = params.canceled ? 'canceled' : (params.errorText || 'failed');
          if (!wanted(r)) return [];
          return [entry(params.canceled ? 'canceled' : 'fail', r, { error: r.error })];
        }

        // The event this exists for: a server-sent stream, message by message,
        // while it is still running.
        case 'Network.eventSourceMessageReceived': {
          const r = find(params.requestId);
          if (!r) return [];
          r.messages += 1;
          if (!sse || !wanted(r)) return [];
          return [entry('sse', r, { event: params.eventName || 'message', data: params.data ?? '' })];
        }

        case 'Network.webSocketCreated': {
          const r = open(params.requestId, {
            url: params.url ?? '',
            method: 'WS',
            type: 'WebSocket',
            startedAt: since(),
          });
          return wanted(r) ? [entry('ws-open', r)] : [];
        }

        case 'Network.webSocketFrameSent':
        case 'Network.webSocketFrameReceived': {
          const r = find(params.requestId);
          if (!r) return [];
          r.messages += 1;
          if (!sse || !wanted(r)) return [];
          const data = params.response?.payloadData ?? '';
          return [entry(method.endsWith('Sent') ? 'ws-out' : 'ws-in', r, { data })];
        }

        case 'Network.webSocketClosed': {
          const r = find(params.requestId);
          if (!r) return [];
          r.endedAt = since();
          return wanted(r) ? [entry('ws-close', r)] : [];
        }

        default:
          return [];
      }
    },

    /** Everything seen, in the order it started. */
    records() {
      return order.slice();
    },

    /**
     * What happened, once.
     *
     * A request with no end is **open**, not missing: a stream held for four
     * minutes is the ordinary case here and the thing most worth naming.
     */
    summary() {
      const shown = order.filter(wanted);
      const failed = shown.filter((r) => r.error && r.error !== 'canceled');
      return {
        ms: since(),
        requests: shown.length,
        hidden,
        ok: shown.filter((r) => r.endedAt !== null && !r.error).length,
        failed,
        canceled: shown.filter((r) => r.error === 'canceled').length,
        open: shown.filter((r) => r.endedAt === null),
        bytes: shown.reduce((sum, r) => sum + r.size, 0),
        messages: shown.reduce((sum, r) => sum + r.messages, 0),
      };
    },
  };
}

/** A payload on one line, short enough to read beside the others. */
function oneLine(data, max = 120) {
  const text = String(data ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One entry as a line of terminal output. */
export function formatEntry(e) {
  const at = `${(e.at / 1000).toFixed(2)}s`.padStart(8);
  const short = shortUrl(e.url);
  switch (e.phase) {
    case 'start':
      return `${at}  ->  ${(e.method || '').padEnd(6)} ${short}`;
    case 'end':
      return `${at}  <-  ${String(e.status ?? '').padEnd(4)} ${took(e.ms).padStart(6)}  ${bytes(e.size).padStart(8)}  ${(e.mime || e.type || '').padEnd(24)} ${short}`;
    case 'redirect':
      return `${at}  =>  ${String(e.status ?? '').padEnd(4)} ${took(e.ms).padStart(6)}  redirected             ${short}`;
    case 'fail':
      return `${at}  XX  ${e.error} after ${took(e.ms)}  ${short}`;
    case 'canceled':
      return `${at}  --  canceled after ${took(e.ms)}  ${short}`;
    case 'sse':
      return `${at}   .  ${e.event}  ${oneLine(e.data)}`;
    case 'ws-open':
      return `${at}  ws  open  ${short}`;
    case 'ws-out':
      return `${at}  w>  ${oneLine(e.data)}`;
    case 'ws-in':
      return `${at}  w<  ${oneLine(e.data)}`;
    case 'ws-close':
      return `${at}  ws  closed after ${took(e.ms)}  ${short}`;
    default:
      return `${at}   ?  ${e.phase}`;
  }
}

/** How many still-open requests the summary names before it starts counting. */
const OPEN_LISTED = 8;

/** The summary, as the lines to print under a watch. */
export function formatSummary(s) {
  const lines = [
    '',
    `${s.requests} requests in ${took(s.ms)} · ${s.ok} finished · ${s.failed.length} failed`
    + `${s.canceled ? ` · ${s.canceled} canceled` : ''}`
    + `${s.open.length ? ` · ${s.open.length} still open` : ''}`
    + ` · ${bytes(s.bytes)}${s.messages ? ` · ${s.messages} stream messages` : ''}`
    + `${s.hidden ? ` · ${s.hidden} hidden by the filter` : ''}`,
  ];
  for (const r of s.failed) lines.push(`  XX ${r.error}  ${shortUrl(r.url)}`);
  // Longest held first, and only the first few. A real page keeps a dozen
  // keepalive fetches open at all times — measured, on chatgpt.com/library —
  // and a summary that lists every one of them buries the stream you were
  // watching for under beacons nobody asked about.
  const held = s.open.slice().sort((a, b) => a.startedAt - b.startedAt);
  for (const r of held.slice(0, OPEN_LISTED)) {
    const stream = r.messages ? `, ${r.messages} messages` : '';
    lines.push(`  .. open ${took(s.ms - r.startedAt)}  ${r.mime || r.type || 'pending'}${stream}  ${shortUrl(r.url)}`);
  }
  if (held.length > OPEN_LISTED) lines.push(`  .. and ${held.length - OPEN_LISTED} more still open`);
  return lines;
}

/**
 * Attach to a target and report its traffic until the time is up.
 *
 * Any target type, not only a page: the extension's own service worker is
 * where an extension's background requests live, and watching that is half the
 * reason to have this at all.
 */
export async function watchNetwork(match, {
  seconds = 30,
  filter = null,
  sse = false,
  json = false,
  out = console.log,
} = {}) {
  const session = await CdpSession.connect(await browserSocketUrl());
  const target = await pickTarget(session, match, { types: ['page', 'service_worker', 'worker', 'other'] });
  const sessionId = await attachToPage(session, target.targetId, { activate: target.type === 'page' });

  const log = createNetworkLog({
    filter,
    sse,
    // Fire and forget. A body Chrome will not forward — one already finished,
    // one from a request it has dropped — is a stream we do not get to read,
    // not a reason to stop watching everything else.
    onStreamable: (requestId) => {
      session.send('Network.streamResourceContent', { requestId }, sessionId).catch(() => {});
    },
  });
  const show = (entries) => {
    for (const e of entries) out(json ? JSON.stringify(e) : formatEntry(e));
  };
  for (const method of [
    'Network.requestWillBeSent',
    'Network.responseReceived',
    'Network.dataReceived',
    'Network.loadingFinished',
    'Network.loadingFailed',
    'Network.eventSourceMessageReceived',
    'Network.webSocketCreated',
    'Network.webSocketFrameSent',
    'Network.webSocketFrameReceived',
    'Network.webSocketClosed',
  ]) {
    session.on(method, (params) => show(log.apply(method, params)));
  }

  // `maxTotalBufferSize` is Chrome's own, for bodies we never ask for. Left at
  // its default deliberately: raising it would make the browser hold megabytes
  // of response body per tab for the sake of a watcher that prints sizes.
  await session.send('Network.enable', {}, sessionId);

  if (!json) {
    const where = target.title ? `${target.title} — ${target.url}` : target.url;
    out(`watching ${target.type} ${shortUrl(where, 90)}`);
    out(`${seconds ? `${seconds}s` : 'until Ctrl-C'}${filter ? `, urls containing "${filter}"` : ''}${sse ? ', stream messages shown' : ''}\n`);
  }

  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const onSignal = () => stop('interrupted');
  process.once('SIGINT', onSignal);
  const timer = seconds > 0 ? setTimeout(() => stop('elapsed'), seconds * 1000) : null;
  const why = await stopped;
  if (timer) clearTimeout(timer);
  process.off('SIGINT', onSignal);

  try {
    await session.send('Network.disable', {}, sessionId);
    await session.send('Target.detachFromTarget', { sessionId });
  } catch {
    // The page can go away underneath a watch — that is an ordinary end to
    // one, and the summary below is still worth printing.
  }
  session.close();

  const summary = log.summary();
  if (json) out(JSON.stringify({ summary: { ...summary, failed: summary.failed.length, open: summary.open.length }, why }));
  else for (const line of formatSummary(summary)) out(line);
  return summary;
}

/* ---------- cookies and storage ---------- */

/**
 * Reading a signed-in session out of the browser.
 *
 * Unlike page inspection, this exports credentials, including httpOnly cookies.
 * Save requested exports to a protected file rather than a transcript or log.
 *
 * CDP sees it because CDP is inside the browser, past TLS termination — HTTPS
 * protects the wire, and the debugger is on the far side of it. Anything that
 * can reach the debug port can already do all of this; this only makes it
 * legible.
 */

/**
 * Cookies whose domain matches, by the rule a browser uses: an exact host, or
 * a parent domain a leading dot makes apply to subdomains. Substring matching
 * would pull `evil-chatgpt.com` in with `chatgpt.com`, which for a credential
 * export is the wrong direction to be loose in.
 */
export function cookiesForDomain(cookies, domain) {
  if (!domain) return cookies.slice();
  const needle = String(domain).replace(/^\./, '').toLowerCase();
  return cookies.filter((c) => {
    const d = (c.domain || '').replace(/^\./, '').toLowerCase();
    return d === needle || d.endsWith(`.${needle}`) || needle.endsWith(`.${d}`);
  });
}

/**
 * Cookies as a Netscape `cookies.txt` — what `curl -b`, `wget`, `yt-dlp` and
 * most session-import tools read.
 *
 * The `#HttpOnly_` domain prefix and the leading-dot "include subdomains" flag
 * are the two conventions those tools rely on; a session cookie is httpOnly and
 * dropping the prefix makes curl ignore exactly the cookie that matters.
 */
export function cookiesToNetscape(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Exported by browser-control cdp.mjs — this is a live session. Treat it as a password.',
    '',
  ];
  for (const c of cookies) {
    const domain = c.domain || '';
    const expiry = !c.expires || c.expires < 0 ? '0' : String(Math.floor(c.expires));
    lines.push([
      (c.httpOnly ? '#HttpOnly_' : '') + domain,
      domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      expiry,
      c.name ?? '',
      c.value ?? '',
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The signed-in state of one site: its cookies, and its local and session
 * storage. Cookies come browser-wide and need no page; the two storages are
 * per-origin and are read without running any script in the page.
 */
export async function readStorage(match, { domain = null, all = false, cookiesOnly = false } = {}) {
  const session = await CdpSession.connect(await browserSocketUrl());
  try {
    const { cookies } = await session.send('Storage.getCookies');

    if (cookiesOnly) {
      // No page attached: `--domain`, or the match read as a domain.
      const picked = all ? cookies : cookiesForDomain(cookies, domain ?? match);
      return { cookies: picked };
    }

    const target = await pickTarget(session, match);
    const sessionId = await attachToPage(session, target.targetId);
    const origin = new URL(target.url).origin;
    const host = new URL(target.url).hostname;
    const picked = all ? cookies : cookiesForDomain(cookies, domain ?? host);

    await session.send('DOMStorage.enable', {}, sessionId).catch(() => {});
    const read = async (isLocalStorage) => {
      try {
        const { entries } = await session.send(
          'DOMStorage.getDOMStorageItems',
          { storageId: { securityOrigin: origin, isLocalStorage } },
          sessionId,
        );
        return Object.fromEntries(entries);
      } catch {
        // A page with an opaque origin (about:blank, a sandboxed frame) has no
        // storage to read; an empty object is the honest answer, not a throw.
        return {};
      }
    };
    const bundle = {
      url: target.url,
      origin,
      cookies: picked,
      localStorage: await read(true),
      sessionStorage: await read(false),
    };
    await session.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    return bundle;
  } finally {
    session.close();
  }
}

/** A one-line count for stderr, so piped stdout stays clean and the warning is still seen. */
export function storageWarning(bundle) {
  const cookies = bundle.cookies ?? [];
  const httpOnly = cookies.filter((c) => c.httpOnly).length;
  const parts = [`${cookies.length} cookies (${httpOnly} httpOnly)`];
  if (bundle.localStorage) parts.push(`${Object.keys(bundle.localStorage).length} localStorage keys`);
  if (bundle.sessionStorage) parts.push(`${Object.keys(bundle.sessionStorage).length} sessionStorage keys`);
  return `exported ${parts.join(', ')} — this is a live session, treat it as a password`;
}

/* ---------- CLI ---------- */

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cdp.mjs')) {
  const argv = process.argv.slice(2);
  // Pulled out wherever it appears, so `--port` can follow the expression
  // without being mistaken for part of it.
  const at = argv.findIndex((a) => a === '--port');
  if (at !== -1) {
    setPort(argv[at + 1]);
    argv.splice(at, 2);
  }
  // How a page's dialogs are answered, pulled out the same way.
  const pluck = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${name} needs a value`);
    argv.splice(i, 2);
    return value;
  };
  const answer = pluck('--dialog');
  const promptText = pluck('--prompt-text');
  if (answer !== undefined || promptText !== undefined) setDialogPolicy({ answer: answer ?? 'accept', promptText });
  const [command, ...rest] = argv;
  const guard = (targetId) => guardDialogs(targetId);

  if (command === 'targets') {
    const targets = await allTargets();
    // Only pages can be probed, and only when asked: `targets --active` keeps
    // the plain listing free of script execution in every open tab.
    const wanted = rest.includes('--active');
    const activity = wanted ? await pagesWithActivity() : [];
    const byId = new Map(activity.map((p) => [p.targetId, p]));

    console.log(`${targets.length} targets${wanted ? '   (* frontmost in its window, > has focus)' : ''}\n`);
    for (const t of targets) {
      const state = byId.get(t.targetId);
      const mark = wanted
        ? `${state?.visible ? '*' : ' '}${state?.focused ? '>' : ' '} `
        : '';
      console.log(`  ${mark}${t.type.padEnd(16)} ${(t.title || '').slice(0, 34).padEnd(36)} ${(t.url || '').slice(0, 70)}`);
    }
  } else if (command === 'active') {
    // One line per browser window. A page with no window id — the side panel,
    // devtools — is not a tab and is left out, however visible it is.
    const pages = await pagesWithActivity();
    const front = pages.filter((p) => p.visible && p.windowId !== null);
    if (front.length === 0) {
      console.log('no active tab found (is a browser window open?)');
    }
    for (const p of front) {
      console.log(`window ${p.windowId}${p.focused ? ' (focused)' : ''}\n  ${p.title}\n  ${p.url}\n`);
    }
  } else if (command === 'eval') {
    // Plucked the way `network` and `storage` pluck theirs, and it has to happen
    // before the join below: anything left in `rest` becomes part of the
    // expression, so an unplucked `--frame 2` would be pasted into the
    // JavaScript and come back as a syntax error from inside the page.
    const at = rest.indexOf('--frame');
    let frame = null;
    if (at !== -1) {
      frame = rest[at + 1];
      rest.splice(at, 2);
      if (frame === undefined) throw new Error('--frame needs an index or a url fragment');
    }
    console.log(JSON.stringify(await evaluateIn(rest[0], rest.slice(1).join(' '), { frame, guard }), null, 2));
  } else if (command === 'upload') {
    // Same flag-plucking as `network` and `storage`, so the flags can sit
    // anywhere; what is left over is the match and then the paths.
    const flag = (name) => {
      const i = rest.indexOf(name);
      if (i === -1) return null;
      const value = rest[i + 1];
      rest.splice(i, 2);
      return value;
    };
    const selector = flag('--selector');
    const click = flag('--click');
    const [match, ...paths] = rest;
    if (!match) throw new Error('upload needs a url or title substring');
    const done = await uploadFiles(match, paths, { selector, click, guard });
    console.log(`attached ${done.files.length} file${done.files.length === 1 ? '' : 's'} to ${shortUrl(done.target)}`);
    for (const f of done.files) console.log(`  ${f}`);
  } else if (command === 'guard') {
    // Started by eval and upload, not by a person: see `guardDialogs`.
    await runGuard(rest[0]);
  } else if (command === 'dismiss') {
    const answer = await dismissDialogs();
    if (answer.closed === 0) console.log(answer.detail ?? 'no file dialog is open');
    else console.log(`closed ${answer.closed} dialog${answer.closed === 1 ? '' : 's'}: ${answer.titles.join(', ')}`);
  } else if (command === 'frames') {
    const [match] = rest;
    if (!match) throw new Error('frames needs a url or title substring');
    const { target, frames } = await listFrames(match);
    console.log(`${frames.length} frame${frames.length === 1 ? '' : 's'} in ${target.title || target.url}\n`);
    console.log(framesReport(frames));
  } else if (command === 'network') {
    // Flags pulled out the same way `--port` is, so they can follow the match
    // in any order. `--seconds 0` means until Ctrl-C, which is the right
    // default for watching a person do something rather than a script.
    const flag = (name) => {
      const i = rest.indexOf(name);
      if (i === -1) return null;
      const value = rest[i + 1];
      rest.splice(i, 2);
      return value;
    };
    const has = (name) => {
      const i = rest.indexOf(name);
      if (i === -1) return false;
      rest.splice(i, 1);
      return true;
    };
    const sse = has('--sse');
    const json = has('--json');
    const filter = flag('--filter');
    const secondsFlag = flag('--seconds');
    const seconds = secondsFlag === null ? 30 : Number(secondsFlag);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`bad --seconds: ${secondsFlag}`);
    const [match] = rest;
    if (!match) throw new Error('network needs a url or title substring to watch');
    const summary = await watchNetwork(match, { seconds, filter, sse, json });
    // A failure in the page is a failure of the watch: a script that greps this
    // output should not have to parse it to find out nothing loaded.
    process.exitCode = summary.failed.length ? 1 : 0;
  } else if (command === 'storage') {
    // Same flag-plucking as `network`. This command exports a live session, so
    // the values it prints are credentials — the warning goes to stderr, which
    // keeps a redirect of stdout to a `.txt`/`.json` clean while still being
    // seen at a terminal.
    const flag = (name) => {
      const i = rest.indexOf(name);
      if (i === -1) return null;
      const value = rest[i + 1];
      rest.splice(i, 2);
      return value;
    };
    const has = (name) => {
      const i = rest.indexOf(name);
      if (i === -1) return false;
      rest.splice(i, 1);
      return true;
    };
    const netscape = has('--netscape');
    const all = has('--all');
    const cookiesOnly = has('--cookies') || netscape;
    const domain = flag('--domain');
    const [match] = rest;
    if (!match && !domain) throw new Error('storage needs a url/title substring, or --domain');

    const bundle = await readStorage(match ?? domain, { domain, all, cookiesOnly });
    console.error(storageWarning(bundle));
    if (netscape) process.stdout.write(cookiesToNetscape(bundle.cookies));
    else console.log(JSON.stringify(bundle, null, 2));
  } else {
    console.log([
      'usage:',
      '  cdp.mjs targets [--active]           list targets, optionally marking the frontmost',
      '  cdp.mjs active                       the active tab of each browser window',
      '  cdp.mjs eval <url-substring> "<js>"  evaluate in a page (prefers the active match)',
      '                    a null or a throw falls through to the frames, nested included',
      '      --frame F     pin it to one frame instead: its index from `frames`, or a url fragment',
      '  cdp.mjs upload <url-substring> <path...>  attach files WITHOUT opening a dialog',
      '      --selector S  the <input type="file"> itself, hidden or not',
      '      --click S     what a person would press; the chooser is intercepted, never shown',
      '  cdp.mjs dismiss                      close a file dialog already on screen',
      '',
      'an alert, confirm, prompt or "Leave site?" that eval or upload opens is answered at once,',
      'and for 15 seconds after; each answer is printed on stderr as "[cdp] dialog: ..."',
      '      --dialog accept    OK, or Leave (the default; an alert only has OK)',
      '      --dialog dismiss   Cancel, or Stay',
      '      --prompt-text T    what to type into a prompt (default: its own default text)',
      '  cdp.mjs frames <url-substring>       list a page\'s frames, with the index --frame takes',
      '  cdp.mjs network <url-substring>      watch a target\'s requests, streams and failures',
      '      --seconds N   how long to watch; 0 waits for Ctrl-C (default 30)',
      '      --filter S    only urls containing S',
      '      --sse         print each server-sent event and websocket frame',
      '      --json        one json object per line, then a summary object',
      '  cdp.mjs storage <url-substring>      EXPORT a site\'s cookies + storage (a live session)',
      '      --domain D    cookies for domain D, matched by host not substring',
      '      --cookies     cookies only, no page needed',
      '      --netscape    cookies as a cookies.txt for curl -b / yt-dlp (implies --cookies)',
      '      --all         every cookie in the browser, not just this site\'s',
      '                    ⚠ prints session cookies in full — the output is a password',
      '',
      'every command takes --port <n> to choose the browser (default 19223; CHROME_PORT overrides)',
    ].join('\n'));
    if (command && command !== 'help' && command !== '--help' && command !== '-h') process.exitCode = 1;
  }
}
