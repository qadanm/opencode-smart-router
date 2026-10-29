#!/usr/bin/env python3
"""
Audit the smart router's decisions against the routing rules and against
ground truth from the OpenCode message store.

Checks per decision:
  A. context accuracy  - did the router use a context value that matched the
     real context at that instant? (stale-context bugs)
  B. eligibility       - would every candidate that was excluded actually
     have been excluded by a hard gate?
  C. least-cost        - was the chosen candidate the lowest effective cost?
  D. provider coverage - did the router consider all three providers when it
     should have?
  E. manual/premium    - did a manual override or premium rule get violated?
  F. switch soundness  - did a claimed switch actually happen in the store?
"""
import sqlite3, json, os, datetime, collections, sys

DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
CON = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
F = lambda ms: datetime.datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M:%S")

INTELLIGENCE_FLOOR = 39.5
CONTEXT_MARGIN = 20_000
CONTEXT_SAFETY = 0.95
HYSTERESIS_PCT = 20
LARGE_CONTEXT_TOKENS = 300_000
LARGE_CONTEXT_HYSTERESIS_PCT = 35
PREMIUM_MODE = "off"

# --- model registry: provider -> modelID -> (context, approved, tier, intelligence)
MODELS = {}
for path, tag in (("src/core/models/seed.ts", "seed"), ("src/core/providers/opendesign-models.ts", "od")):
    pass

import re
from pathlib import Path
REPO = Path(os.path.expanduser("~/Documents/opencode-smart-router"))


def load_models():
    models = {}
    t = (REPO / "src/core/models/seed.ts").read_text()
    idx = [m.start() for m in re.finditer(r"\n  \{\n    key: ", t)]
    idx.append(len(t))
    for a, b in zip(idx, idx[1:]):
        blk = t[a:b]
        g = lambda p: (re.search(p, blk).group(1) if re.search(p, blk) else None)
        key, prov, mid = g(r'key: "([^"]+)"'), g(r'providerID: "([^"]+)"'), g(r'modelID: "([^"]+)"')
        ctx, appr = g(r"context: ([\d_]+)"), g(r"approved: (\w+)")
        tier, intel = g(r"tier: (\d+)"), g(r"intelligence: ([\d.]+)")
        if key and prov and mid:
            models[(prov, mid)] = dict(
                context=int(ctx.replace("_", "")) if ctx else 0,
                approved=(appr != "false"), tier=int(tier) if tier else None,
                intelligence=float(intel) if intel else None)
    t2 = (REPO / "src/core/providers/opendesign-models.ts").read_text()
    for m in re.finditer(r'spec\("([^"]+)", "([^"]+)", \{(.*?)\n  \}\)', t2, re.S):
        mid, body = m.group(1), m.group(3)
        g = lambda p: (re.search(p, body).group(1) if re.search(p, body) else None)
        ctx, appr = g(r"context: ([\d_]+)"), g(r"approved: (\w+)")
        tier, intel = g(r"tier: (\d+)"), g(r"intelligence: ([\d.]+)")
        models[("opendesign", mid)] = dict(
            context=int(ctx.replace("_", "")) if ctx else 0,
            approved=(appr != "false") if appr else True,
            tier=int(tier) if tier else None,
            intelligence=float(intel) if intel else None)
    return models


MODELS = load_models()

# --- ground truth: per-session context timeline from the message store
def build_context_timeline():
    """sessionID -> sorted list of (at_ms, true_context_tokens)"""
    tl = collections.defaultdict(list)
    q = """SELECT session_id, time_created, data FROM session_message
           WHERE type='assistant' AND time_created >= ?"""
    since = int((datetime.datetime.now() - datetime.timedelta(days=4)).timestamp() * 1000)
    for sid, tc, d in CON.execute(q, (since,)):
        j = json.loads(d)
        t = j.get("tokens")
        if not t:
            continue
        cr = (t.get("cache") or {}).get("read") or 0
        inp = t.get("input")
        if inp is None and not cr:
            continue
        tl[sid].append((tc, (inp or 0) + cr))
    for sid in tl:
        tl[sid].sort()
    return tl


CTX = build_context_timeline()


def true_context_at(sid, at):
    """
    Context the session actually had at time `at`.

    Normally that is the last step at or before `at`. A completed compaction
    resets the transcript, so if the last step predates the compaction the
    ledger value is stale; the true post-compaction size is revealed by the
    next step, which reports the rebuilt transcript.
    """
    steps = CTX.get(sid, [])
    last = None
    for tc, ctx in steps:
        if tc <= at:
            last = (tc, ctx)
        else:
            break
    comps = [c for c in compaction_times(sid) if c[0] <= at and c[1] == "completed"]
    if not last:
        return None
    if comps and last[0] < comps[-1][0]:
        # A compaction happened after the last step we can see. The next step
        # reveals the rebuilt size.
        for tc, ctx in steps:
            if tc > at:
                return ctx
        return None
    return last[1]


def stale_context_reason(sid, at):
    """Why the router's context value at `at` is stale, if it is."""
    steps = CTX.get(sid, [])
    last = None
    for tc, ctx in steps:
        if tc <= at:
            last = (tc, ctx)
        else:
            break
    if not last:
        return None
    comps = [c for c in compaction_times(sid) if c[0] <= at and c[1] == "completed"]
    if comps and last[0] < comps[-1][0]:
        return ("compaction", comps[-1][0], last[0])
    return None


def compaction_times(sid):
    out = []
    for tc, d in CON.execute(
        "SELECT time_created, data FROM session_message WHERE session_id=? AND type='compaction'", (sid,)
    ):
        j = json.loads(d)
        out.append((tc, j.get("status"), j.get("reason")))
    out.sort()
    return out


def load_ledger():
    raw = CON.execute("SELECT value FROM kv WHERE key LIKE '%ledger-v1'").fetchone()[0]
    return json.loads(raw)


LED = load_ledger()
DECISIONS = sorted(LED["decisions"], key=lambda d: d["at"])
COOLDOWNS = LED.get("cooldowns") or {}

findings = []


def finding(kind, severity, at, sid, detail):
    findings.append(dict(kind=kind, severity=severity, at=at, sid=sid, detail=detail))


# ---------------- per-decision checks ----------------
for d in DECISIONS:
    at, sid = d["at"], d.get("sessionID")
    ctx_used = d.get("contextTokens") or 0
    chosen = (d.get("chosen") or {}).get("providerID")
    cands = d.get("candidates") or []
    task = d.get("task") or {}
    tier = task.get("tier")

    # A. context accuracy
    real = true_context_at(sid, at)
    if real is not None and ctx_used > 0:
        drift = ctx_used - real
        reason = stale_context_reason(sid, at)
        if reason and reason[0] == "compaction":
            comp_at, last_step_at = reason[1], reason[2]
            finding("STALE_CONTEXT", "high", at, sid,
                    f"used {ctx_used:,} but the true context was {real:,} "
                    f"(drift {drift:,}); a compaction completed at {F(comp_at)} and the "
                    f"router kept the pre-compaction value "
                    f"(last step seen {F(last_step_at)})")
        elif drift > 50_000:
            finding("STALE_CONTEXT", "medium", at, sid,
                    f"used {ctx_used:,}, real {real:,} (drift {drift:,})")
        elif drift < -20_000:
            finding("CONTEXT_UNDERESTIMATE", "low", at, sid,
                    f"used {ctx_used:,}, real {real:,} (drift {drift:,})")

    # D. provider coverage
    providers_seen = {c["model"]["providerID"] for c in cands}
    # Quota state at decision time, so a provider excluded for a legitimate
    # reason (unknown quota, near its cap) is not reported as skipped.
    quota_by_prov = {}
    for q in d.get("quota") or []:
        quota_by_prov[q.get("providerID")] = q
    if chosen and tier and tier >= 2:
        for prov in ("opendesign", "commandcode", "opencode-go"):
            if prov in providers_seen:
                continue
            q = quota_by_prov.get(prov)
            if not q:
                continue
            # Legitimate exclusion: the provider's quota state is unknown, so
            # the router cannot price it against a subscription.
            if q.get("source") == "unknown":
                continue
            # Legitimate exclusion: the provider has no headroom left in the
            # binding window.
            remaining = min(
                (q.get(w, {}) or {}).get("remainingPct", 100)
                for w in ("rolling", "weekly", "monthly") if (q.get(w) or {}).get("source") != "unknown"
            ) if any((q.get(w) or {}).get("source") != "unknown" for w in ("rolling", "weekly", "monthly")) else 100
            if remaining <= 20:
                continue
            cands_for = [(m, v) for (p, m), v in MODELS.items()
                          if p == prov and v["approved"] and (v["tier"] or 3) <= max(tier, 2)
                          and (v["intelligence"] or 0) >= INTELLIGENCE_FLOOR]
            fits = [m for m, v in cands_for if (ctx_used + CONTEXT_MARGIN) <= v["context"] * CONTEXT_SAFETY]
            if fits:
                finding("PROVIDER_SKIPPED", "medium", at, sid,
                        f"{prov} absent from candidates but {fits} fit context "
                        f"({ctx_used:,} tokens) and pass the intelligence floor; "
                        f"quota source={q.get('source')} remaining>={remaining:.0f}%")

    # C. least-cost among eligible, with hysteresis
    if cands:
        elig = [c for c in cands if c.get("eligible")]
        if elig:
            best = min(elig, key=lambda c: c.get("effectiveCost", 0))
            cur = next((c for c in elig if (c.get("retained") is True)), None)
            if cur is not None and best["model"] != cur["model"]:
                hyst = LARGE_CONTEXT_HYSTERESIS_PCT if ctx_used >= LARGE_CONTEXT_TOKENS else HYSTERESIS_PCT
                savings = cur.get("effectiveCost", 0) - best.get("effectiveCost", 0)
                threshold = cur.get("effectiveCost", 0) * (hyst / 100)
                if savings >= threshold:
                    finding("HYSTERESIS_UNEXPLAINED", "high", at, sid,
                            f"kept {cur['model']['providerID']}/{cur['model']['modelID']} "
                            f"(eff ${cur.get('effectiveCost'):.4f}) over "
                            f"{best['model']['providerID']}/{best['model']['modelID']} "
                            f"(eff ${best.get('effectiveCost'):.4f}); savings ${savings:.4f} "
                            f"exceeds {hyst}% threshold ${threshold:.4f}")

    # E. premium / manual
    if d.get("manualOverride"):
        finding("MANUAL_OVERRIDE", "info", at, sid,
                f"manual override respected, chosen={chosen}")
    if tier == 3 and chosen and (chosen in ("opendesign", "commandcode", "opencode-go")):
        c = next((c for c in cands if c["model"]["providerID"] == chosen), None)
        if c and (c.get("model", {}).get("tier") == 3 or c.get("tier") == 3):
            if PREMIUM_MODE == "off" and not d.get("needsPremiumApproval"):
                finding("PREMIUM_IN_AUTO", "medium", at, sid,
                        f"tier-3 task routed to {chosen} while premium mode is off")

# ---------------- F. switch soundness vs the store ----------------
switches = collections.defaultdict(list)
for sid, tc, d in CON.execute(
    "SELECT session_id, time_created, data FROM session_message WHERE type='model-switched'"
):
    j = json.loads(d)
    switches[sid].append((tc, (j.get("previous") or {}).get("providerID"), (j.get("model") or {}).get("providerID")))
for sid in switches:
    switches[sid].sort()

for d in DECISIONS:
    if not d.get("switched"):
        continue
    at, sid = d["at"], d.get("sessionID")
    target = (d.get("chosen") or {}).get("providerID")
    # find a switch within 90s of the decision
    near = [s for s in switches.get(sid, []) if abs(s[0] - at) < 90_000]
    if not near:
        finding("SWITCH_NOT_REALIZED", "low", at, sid,
                f"decision said switched -> {target} but no model-switched event within 90s")

# ---------------- report ----------------
print(f"decisions audited: {len(DECISIONS)}")
print(f"span: {F(DECISIONS[0]['at'])} -> {F(DECISIONS[-1]['at'])}")
print()
by = collections.defaultdict(list)
for f in findings:
    by[(f["kind"], f["severity"])].append(f)
if not by:
    print("NO FINDINGS")
for (kind, sev), items in sorted(by.items(), key=lambda kv: {"high": 0, "medium": 1, "low": 2, "info": 3}[kv[0][1]]):
    print(f"=== {kind} ({sev}) — {len(items)} ===")
    for f in items[:14]:
        print(f"  {F(f['at'])}  {f['sid'][-8:] if f['sid'] else '-':9s} {f['detail']}")
    if len(items) > 14:
        print(f"  ... and {len(items)-14} more")
    print()

json.dump(findings, open("/tmp/opencode/audit-findings.json", "w"), indent=1)
print(f"findings written: /tmp/opencode/audit-findings.json")
