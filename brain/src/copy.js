/** Tool-filled copy. Numbers only from record fields — never estimated here. */

function mono(value) {
  if (value == null || value === "") return "`[#]`";
  return `\`${value}\``;
}

function dayMonth(unix) {
  if (!unix) return "";
  const d = new Date(Number(unix) * 1000);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function daysLeft(expiresAt, now) {
  const secs = Number(expiresAt) - now;
  if (!Number.isFinite(secs) || secs <= 0) return "0";
  return String(Math.ceil(secs / 86400));
}

function impliedLevel(mark, pct, op) {
  const m = Number(mark);
  const p = Number(pct);
  if (!Number.isFinite(m) || !Number.isFinite(p)) return null;
  const signed = op === "lte" ? -p : p;
  return (m * (1 + signed / 100)).toFixed(2);
}

export function setMessage(watch, now = Math.floor(Date.now() / 1000)) {
  const pred = watch.predicate || {};
  const sym = pred.symbol || "";
  const mark = watch.mark_at_set;
  let implied = null;
  if (pred.kind === "pct_move" && mark) {
    implied = impliedLevel(mark, pred.pct, pred.op);
  } else if (pred.kind === "price_level") {
    implied = pred.level;
  }
  const impliedBit = implied ? `, so that's ${mono(implied)}` : "";
  return [
    `Watching ${mono(sym)} for ${pred.resolved || "your trigger"}. Now ${mono(mark)}${impliedBit}.`,
    `This is a heads-up, not a trade. I won't buy or sell anything. Expires in ${mono(daysLeft(watch.expires_at, now))} days.`,
  ].join("\n");
}

export function clarifyMessage(symbol) {
  return `Happy to watch ${mono(symbol)} — but that trigger can mean different things. Want me to fire when it's up 5% in a day, or when it crosses a specific price? I'll store whichever you pick, exactly.`;
}

export function executionFoldedMessage(symbol) {
  return `I can watch ${mono(symbol)} for you, or I can help you set a conditional order — but those are different things. A watch just messages you. An order that fires on a trigger has to be signed on World, because it moves your money. Which do you want?`;
}

export function firedMessage(fire) {
  const pred = fire.predicate || {};
  const date = dayMonth(fire.created_at);
  const spent = fire.spent
    ? "This watch is done — it won't fire again unless you re-arm it."
    : "I'll message you again after this condition goes false, then true.";
  return [
    `${mono(pred.symbol)} just crossed ${pred.resolved || fire.original_phrase} — now ${mono(fire.live)}, the level you asked me to watch for on ${date}.`,
    spent,
  ].join("\n");
}

export function expiredMessage(fire) {
  const pred = fire.predicate || {};
  return `Your ${mono(pred.symbol)} watch (${pred.resolved || fire.original_phrase}, set ${dayMonth(fire.created_at)}) expired without firing. I've stopped watching. Nothing happened to your book.`;
}

export function bundleMessage(fires) {
  const rows = (fires || []).map((fire) => {
    const pred = fire.predicate || {};
    const done = fire.spent ? "done" : "still true";
    return `${pred.symbol || ""} ${pred.resolved || ""} → ${fire.live || ""} ${done}`.trim();
  });
  return [
    `${mono(String(fires.length))} more of your watches fired today. Here's all of them at once so I don't spam you:`,
    ...rows.map((row) => `> ${row}`),
  ].join("\n");
}

export function attachSetCopy(result, now) {
  if (result.execution_folded) {
    return {
      ...result,
      message: executionFoldedMessage(result.symbol || ""),
      controls: ["Just watch it", "Set it up on World ↗"],
    };
  }
  if (result.needs_clarification) {
    return {
      ...result,
      message: clarifyMessage(result.symbol || ""),
      controls: (result.options || []).map((o) => o.label),
    };
  }
  if (result.ok && result.watch) {
    return {
      ...result,
      message: setMessage(result.watch, now),
      controls: ["Change the trigger", "Cancel this watch"],
    };
  }
  return result;
}

export function attachFireCopy(fire) {
  return { ...fire, message: firedMessage(fire) };
}

export function attachExpireCopy(fire) {
  return { ...fire, message: expiredMessage(fire) };
}

export function attachBundleCopy(payload) {
  return { ...payload, message: bundleMessage(payload.fires) };
}
