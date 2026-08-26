/* global COPY */
/** All user-facing strings. Plain-text-first. No urgency. Status words lowercase. */

const COPY = {
  statuses: [
    "with aomi",
    "watching",
    "needs you",
    "paused",
    "done",
    "expired",
    "blocked",
  ],
  header: {
    title: "World Markets",
    subtitle: "instruction ledger",
    tabLedger: "Ledger",
    tabPortfolio: "Portfolio",
  },
  heartbeat: {
    holdingOk: "aomi is holding {held} instructions · last check {n}s ago",
    holdingNeeds1: "aomi is holding {held} instructions · 1 needs you in the thread",
    holdingNeedsN: "aomi is holding {held} instructions · {n} need you in the thread",
    empty: "aomi is holding nothing — say the word in the thread",
    stale: "checks delayed — data may be stale",
    error:
      "can't reach the ledger — your instructions are safe; this view is stale",
    loading: "aomi is holding … · fetching the ledger",
  },
  zones: {
    needsYou: "NEEDS YOU",
    inMotion: "IN MOTION",
    watching: "WATCHING",
    watchingCount: "{w} · {p} paused",
    doneToday: "DONE TODAY",
    earlier: "EARLIER",
    earlierSub: "expired · kept 90d, then archive",
  },
  sub: {
    withAomi: "sent to thread · awaiting your confirm",
    needsYou: "condition met · confirm waiting in the thread",
    needsYouAt: "condition met at {value} · confirm waiting in the thread",
    watching: "last check {n}s ago · expires {date}",
    watchingSlow: "last check {n}m ago · expires {date}",
    watchingDist: "now {mark} — {pct}% above · ",
    watchingStale: "last check {n}m ago — stale",
    paused: "paused · resumes only on your word",
    executing: "filling · slice {i} of {n} · avg {price}",
    pendingPause: "pause sent to thread · awaiting your signed confirm",
    pendingResume: "resume sent to thread · awaiting your signed confirm",
    expired: "expired {date} · never met — noted in that week's digest",
  },
  emptyTeach:
    "aomi is holding nothing. Anything you say in the thread — \"watch the floor\", \"if it touches X, do Y\" — lands here and stays until it's done or expires.",
  errorRow:
    "can't reach the ledger — your instructions are safe; this view is stale.",
  ledgerFooter:
    "read-only — instructions change only by signed confirms in the thread · progress is a projection of engine records",
  strip: {
    trail: "portfolio ›",
    riskFree: "· risk {risk} · {free} free",
  },
  instruction: {
    actsLabel: "ACTIONS — SENT TO CHAT AS TEXT",
    pause: "Pause this",
    resume: "Resume this",
    ask: "Ask aomi about this",
    askRun: "Ask about this run",
    openThread: "Open the thread ↗",
    tagSlides: "SLIDES",
    tagTap: "ONE TAP",
    tagHalt: "HALT LIVES THERE",
    awaitingLabel: "THE CONFIRM LIVES IN THE THREAD",
    awaitingNote:
      "Signed, TTL'd buttons — the mini app displays the state; it never hosts the confirm.",
    trailLabel: "TRAIL — BECAUSE YOU SAID IT",
    trailAggregate: "+{n} checks — none met the condition.",
    trailNear: "Near miss — {value} low, condition not held.",
    trailHeld: 'Held as: "{sentence}" — expiry {date}, runs under your floor.',
    trailConfirmed: "Confirmed.",
    trailTriggered: "Condition met — {detail}. Confirm sent to thread.",
    trailBlocked: "Blocked — floor {value}",
    sheetFooter:
      "a straight render of the append-only event log · corrections are new events, never edits",
    detentHalf: "drag ↑ for the trail",
    detentFull: "flick ↓ to dismiss",
  },
  position: {
    actsLabel: "ACTIONS — SENT TO CHAT AS TEXT",
    watched: "watched by {n} instruction(s) — see the ledger",
    footer:
      "nothing executes here — aomi + the policy engine process it in the thread",
    gated: "POLICY-GATED",
    watchThis: "Watch this",
  },
  picker: {
    title: "Watch {position}",
    sub: "Drafts from this sheet's own numbers — deterministic templates, no rule builder. aomi re-parses authoritatively in the thread.",
    footer:
      "both kinds slide to send — a watch is not a question; it arms a future obligation",
    tell: "TELL",
    act: "ACT",
  },
  drafts: {
    pause: 'Pause: "{sentence}"',
    resume: 'Resume: "{sentence}"',
    askPrefix: 'About "{sentence}": ',
  },
  compose: {
    label: "CONFIRM — GOES TO THE THREAD AS TEXT",
    disclaimer:
      "aomi restates it with expiry and policy scope · you confirm with the signed buttons in the thread — never here.",
    notePause:
      "A protection stops firing while paused — it takes effect only on your signed confirm in the thread.",
    noteResume: "It starts checking again only after your signed confirm.",
    noteWatchAct:
      "Consequence: arms an order template — it fires only after a fresh policy check and the thread confirm flow.",
    noteWatchTell: "Consequence: arms a future obligation — aomi can only message you.",
    noteImperative: "Consequence: {delta}",
    slideLabel: "slide — {button}",
    slideHint: "release early and it springs back — nothing sent",
    tapHint: "a question — one tap, no ceremony",
    sendPause: "Send — pause it",
    sendResume: "Send — resume it",
    sendWatch: "Send to aomi",
    ask: "Ask aomi",
  },
  sent: {
    label: "SENT",
    headline: "Sent.",
    cardNote:
      "this card is live — it is the ledger record · tap to open its row",
    askNote: "aomi answers in the thread. Questions never become ledger records.",
    openThread: "Open the thread ↗",
  },
  gate: {
    label: "POLICY GATE",
    headline: "Blocked",
    line: "{act} would put your risk score at {n} — below your floor of {floor}.",
    note: "A block is a terminal report, not an error. Floors change only by a signed policy update — in the thread, not here.",
    act: "Ask aomi about this gate",
    footer: "deterministic policy engine · not the model",
  },
  portfolio: {
    search: "Search your portfolio",
    positions: "{n} positions",
    matches: "{n} match(es)",
    noMatch: 'No positions match "{q}"',
    riskLine: "risk {n}/10 {band} · {d} above your floor of {floor}",
    riskFloor: "floor {floor} — signed policy · at a breach the guardian acts first, confirms after",
    riskLiq: "full liquidation: ETH {price} ({pct}% from mark)",
    riskAsk: "Ask aomi about my risk ›",
    jobline: "watched by {n} instruction(s) · {extra}",
    joblineNeg: "nothing watching this · {extra}",
    holdings: "Holdings",
    openPositions: "Open positions",
    lending: "Lending",
    footer:
      "marked at current prices · portfolio value is after debt and margin · ≈ = estimate",
  },
  launch: {
    label: "SINCE YOU LOOKED",
    needs: "{n} needs you — {what} · confirm waiting in the thread",
    motion: "{n} in motion — {what}, {pct}% filled",
    watching: "{n} watching · {p} paused — {list}",
    done: "{n} done today — {receipts}",
    hint: "drag ↑ for the full ledger · portfolio is the second view, one tap",
  },
  bottom: {
    launch: "↩ Back to chat — say the word there",
    inner: "↩ Back to chat",
  },
  toasts: {
    paused: "signed in the thread — paused",
    resumed: "signed in the thread — watching again",
    watching: "signed in the thread — watching · expires {date}",
    executed: "executed in the thread — receipt in DONE TODAY",
    filled: "filled {amount} — receipt in the thread, row in DONE",
    trigger: "{detail} — confirm waiting in the thread",
  },
  unauthorized: "Session expired. Open from the bot again.",
  portfolioEmpty: "No open positions.",
  portfolioEmptySub: "Your portfolio is empty.",
  loadError: "Could not load this view",
  retry: "Retry",
};

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] == null ? "" : String(vars[key]),
  );
}

if (typeof window !== "undefined") {
  window.COPY = COPY;
  window.fillCopy = fill;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { COPY, fill };
}
