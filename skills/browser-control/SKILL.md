---
name: browser-control
description: Control Chrome through a local DevTools Protocol endpoint to inspect tabs, read or change pages, attach files, inspect network traffic, and export site storage. Use when the user asks to operate a browser with CDP enabled.
---

# Browser control

Use the bundled `scripts/cdp.mjs` with Node.js 22 or later. No npm packages, browser extension, or companion service are required. Resolve the script relative to this skill's directory and use its absolute path in commands; do not assume the shell starts in this repository.

Port **19223** is the default. `--port N` overrides it for a command; `CHROME_PORT` overrides the ambient default. Keep using the browser port the user selected and report the port and command alongside the result.

## Launch Chrome

On Windows, run the launcher at `../../chrome-profile/start-chrome.ps1` relative to this skill, or its `.bat` wrapper:

```powershell
.\chrome-profile\start-chrome.ps1
.\chrome-profile\start-chrome.bat -Port 19224 -Url https://teams.microsoft.com
```

These examples assume the repository root as the working directory. The launcher creates a persistent user-data directory at `chrome-profile/isolated-<port>`, independent of the shell's working directory. It reuses that profile on later runs and does not copy a personal Chrome profile. Sign in through the visible browser when necessary. `-ChromePath` selects a nonstandard Chrome executable; `-Headless` is optional, and `-WhatIf` previews the launch.

The CDP listener is local to this machine. If it is unreachable, report the selected port rather than silently switching browsers. The launcher reports port conflicts rather than taking over another process.

## Choose a target

```powershell
node "<skill-directory>/scripts/cdp.mjs" targets
node "<skill-directory>/scripts/cdp.mjs" active --port 19223
node "<skill-directory>/scripts/cdp.mjs" targets --active
```

`targets` lists pages, workers, and browser UI without evaluating scripts in tabs. Run it first when the intended target is uncertain. `active` and `targets --active` probe open pages to identify the frontmost tab in each window; use them when the user refers to the current tab, not in a polling loop. Only `page` targets support `eval`. Network watching also supports workers.

Use a distinctive URL or title fragment to select a target. When multiple targets match, the active one wins, otherwise the first listed wins. Inspect only pages relevant to the user's request.

## Read and change pages

```powershell
node "<skill-directory>/scripts/cdp.mjs" eval "example.com" "document.body.innerText.slice(0, 3000)"
node "<skill-directory>/scripts/cdp.mjs" frames "example.com"
node "<skill-directory>/scripts/cdp.mjs" eval "example.com" --frame 0 "(() => { const el = document.querySelector('#search'); if (!el) throw new Error('search not found'); el.value = 'hello'; el.dispatchEvent(new Event('input', { bubbles: true })); return 'filled'; })()"
```

Keep JavaScript in one shell argument, return a useful value, and bound long reads. Promises are awaited; evaluation has a 20-second limit. A timeout does not cancel code already running in the page.

For reads, `null` or a thrown exception causes evaluation to retry in child frames, including nested frames. `undefined` counts as completed. The responding frame is reported on stderr. For writes, inspect the element first and pin the intended frame with `--frame 0` for the top document, or a frame index/URL fragment from `frames`. A write that changes something and then throws could otherwise run again in another frame.

Dialogs opened by `eval` or `upload` are automatically accepted, including confirms and leave-page prompts, while attached and for 15 seconds afterward. Read the reported dialog answers. Use `--dialog dismiss` to cancel or stay, and `--prompt-text TEXT` for prompt input. If an existing JavaScript dialog blocks the page, ask the user to close it before retrying.

When the user supplies an exact element selector, use it as given. If a rerender removes it, search using the supplied path, stable attributes, or text fingerprint in the same frame, and restore the mark only after identifying the same element. Report which clue matched; ask for a new selection if none do.

## Attach files

```powershell
node "<skill-directory>/scripts/cdp.mjs" upload "example.com" --selector "input[type=file]" "C:/reports/report.pdf"
node "<skill-directory>/scripts/cdp.mjs" upload "example.com" --click "button.attach" "C:/reports/report.pdf"
node "<skill-directory>/scripts/cdp.mjs" dismiss
```

Use `--selector` for an existing file input, including hidden inputs. Use `--click` for a button that creates the input or opens a file picker. Do not assign an input's value through JavaScript or click a file picker through `eval`: the native chooser cannot be operated through page JavaScript. The files must exist; relative paths resolve against the shell's working directory. Verify the attachment in the page afterward. Attaching does not send or submit it.

`dismiss` uses Windows UI Automation to cancel existing native file dialogs belonging to the selected browser; it is not for JavaScript alerts.

## Watch network traffic

```powershell
node "<skill-directory>/scripts/cdp.mjs" network "example.com" --seconds 15 --filter /api/ --json
node "<skill-directory>/scripts/cdp.mjs" network "example.com" --seconds 15 --filter /stream --sse
```

Each command starts a fresh watch; start it before the action of interest. Use a bounded positive duration. Pair `--sse` with `--filter` to avoid overwhelming output. It includes server-sent events and WebSocket frames. An `open` request may be a healthy stream; navigation cancellations do not count as failures. Actual failures produce a nonzero exit status.

## Export site storage

```powershell
node "<skill-directory>/scripts/cdp.mjs" storage "example.com" --netscape > cookies.txt
node "<skill-directory>/scripts/cdp.mjs" storage "example.com" > site-storage.json
```

Storage includes cookies (even httpOnly), localStorage, and sessionStorage. `--cookies` omits page storage and needs no open page; `--domain D` selects cookies by host rules; `--netscape` produces a cookie jar; `--all` exports cookies for every site and should be used only when that scope was requested.

These exports contain live credentials. Save requested exports to files rather than displaying secrets in the conversation. Preserve downloaded and exported files and report their locations. Page access does not imply permission to send messages, submit forms, make purchases, or change account settings; follow the scope the user authorized.
