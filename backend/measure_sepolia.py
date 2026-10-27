"""Sepolia 실측: 게이트 검사 한 건이 확정되기까지 걸리는 시간, 시간 기준 경계, 동시 제출, 가스를 잰다.

서비스 4개(backend 8000, gate 8200, audit 8100)가 켜져 있고, 게이트 기기·감독자 등록이 승인된 상태에서 실행한다.

    cd backend && source .venv/bin/activate
    python measure_sepolia.py all                     # 아래 4개를 순서대로 (권장, 15~20분)
    python measure_sepolia.py run --count 20          # 1) 한 명씩 차례로 검사 20건
    python measure_sepolia.py burst --size 4          # 2) 4명이 동시에 검사 (출근 시간·게이트 여러 대)
    python measure_sepolia.py boundary                # 3) 9분·11분 전에 서명한 기록 재전송 → 정상/지연 분류 확인
    python measure_sepolia.py report                  # 4) 체인에서 읽어 통계·CSV·JSON 정리

결과는 backend/measure_out/ 에 쌓인다 (runs.jsonl, report.json, checkins.csv, report.txt).
게이트 기기 키·감리/발주처 키는 쓰지 않는다. 체인 쓰기는 평소처럼 게이트 → 시공사 릴레이를 거친다.
"""
import argparse
import base64
import json
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config
import chain
from chain import contract, w3

BACKEND = "http://127.0.0.1:8000"
GATE = config.GATE_URL.rstrip("/") if getattr(config, "GATE_URL", "") else "http://127.0.0.1:8200"
OUT = Path(__file__).parent / "measure_out"
RUNS = OUT / "runs.jsonl"
KST = timezone(timedelta(hours=9))
STAGES = ["inspecting", "signing", "auditing", "anchoring"]

# 사진을 안 주면 쓰는 회색 160x120 JPEG. YOLO가 사람을 못 찾아 '불합격'이 나오지만 시간 측정에는 상관없다.
# 실제 YOLO 처리 시간을 보려면 --image 로 사람이 찍힌 사진을 준다.
_GRAY_JPEG = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19i"
    "Z2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj"
    "Y2NjY2NjY2P/wAARCAB4AKADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF"
    "BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW"
    "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi"
    "4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC"
    "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm"
    "Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq"
    "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA"
    "KKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKK"
    "ACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACii"
    "igAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAo"
    "oooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Z"
)

_lock = threading.Lock()


# ----------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------


def _req(method, url, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def _multipart(fields: dict, image: bytes):
    boundary = uuid.uuid4().hex
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
             for k, v in fields.items()]
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="m.jpg"\r\n'
                 f"Content-Type: image/jpeg\r\n\r\n".encode() + image + b"\r\n")
    return b"".join(parts) + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def _today() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")


def _save(rec: dict):
    OUT.mkdir(exist_ok=True)
    with _lock, RUNS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


# ----------------------------------------------------------------------
# 검사 한 건: QR 발급 → 게이트 /check/stream 단계별 도착 시각 기록
# ----------------------------------------------------------------------


def one_check(kind: str, site: str, worker: str, image: bytes, minutes_ago: int = 0, think: float = 0.0) -> dict:
    rec = {"kind": kind, "site": site, "worker": worker, "minutesAgo": minutes_ago, "startedAt": time.time()}
    _req("POST", f"{BACKEND}/consent", {"workerId": worker, "siteId": site, "personal": True, "sensitive": True})
    t0 = time.monotonic()
    s, qr = _req("POST", f"{BACKEND}/qr/issue", {"workerId": worker, "siteId": site})
    rec["qrIssueMs"] = round((time.monotonic() - t0) * 1000)
    if s != 200:
        rec["error"] = f"qr/issue {s}: {qr}"
        _save(rec)
        return rec
    if think:
        time.sleep(think)  # QR을 보여 주고 게이트 앞에 서기까지의 시간
    body, ctype = _multipart(
        {"nonce": qr["nonce"], "alcoholPass": "true", "workerId": worker, "siteId": site,
         "workDate": _today(), "signedMinutesAgo": str(minutes_ago)},
        image + uuid.uuid4().bytes,  # 사진마다 evidenceHash가 달라지게
    )
    r = urllib.request.Request(f"{GATE}/check/stream", data=body, method="POST", headers={"Content-Type": ctype})
    t1 = time.monotonic()
    marks = {}
    final = None
    try:
        with urllib.request.urlopen(r, timeout=600) as res:
            for line in res:
                line = line.strip()
                if not line:
                    continue
                step = json.loads(line)
                marks[step["stage"]] = round((time.monotonic() - t1) * 1000)
                if step["stage"] in ("confirmed", "not_anchored", "error"):
                    final = step
    except Exception as e:  # noqa: BLE001 - 측정 중 실패도 기록으로 남긴다
        rec["error"] = f"gate: {e}"
    rec["marksMs"] = marks
    rec["gateTotalMs"] = round((time.monotonic() - t1) * 1000)
    rec["finishedAt"] = time.time()
    if final:
        rec["stage"] = final["stage"]
        if final["stage"] == "error":
            rec["error"] = final.get("detail")
        res = final.get("result") or {}
        rec.update({k: res.get(k) for k in ("nonce", "txHash", "entryStatus", "deviceSeq", "auditDelivered")})
    _save(rec)
    return rec


def _image(path: str | None) -> bytes:
    return Path(path).read_bytes() if path else base64.b64decode(_GRAY_JPEG)


def _line(rec: dict) -> str:
    m = rec.get("marksMs", {})
    if rec.get("error"):
        return f"실패 ({rec['error'][:120]})"
    a = m.get("anchoring", 0)
    end = m.get("confirmed", m.get("not_anchored", rec.get("gateTotalMs", 0)))
    return (f"{rec.get('entryStatus')!s:<16} 판정·서명 {m.get('anchoring', 0) / 1000:5.1f}초"
            f"  체인 확정 {(end - a) / 1000:5.1f}초  게이트 전체 {rec['gateTotalMs'] / 1000:5.1f}초")


# ----------------------------------------------------------------------
# 준비: 당일 위험성평가(감독자 서명)를 체인에 올려 둔다 → 합격 기록이 '허가'로 분류되게
# ----------------------------------------------------------------------


def ensure_site_record(site: str):
    s, admins = _req("GET", f"{BACKEND}/admins")
    if s != 200 or not admins:
        print("감독자 목록을 못 가져왔다. 백엔드가 켜져 있는지 확인")
        sys.exit(1)
    t0 = time.monotonic()
    s, r = _req("POST", f"{BACKEND}/site/record", {
        "siteId": site, "processSummary": "실측용 작업", "workDate": _today(), "adminName": admins[0]["name"],
        "hazardsControlled": True,
        "hazards": [{"hazard": "추락", "riskBasis": "개구부", "controlMeasure": "안전난간", "completed": True}],
    }, timeout=600)
    ms = round((time.monotonic() - t0) * 1000)
    rec = {"kind": "site_record", "site": site, "startedAt": time.time(), "totalMs": ms,
           "txHash": r.get("txHash"), "status": s}
    if s != 200:
        rec["error"] = str(r.get("detail", r))
    _save(rec)
    print(f"위험성평가 기록: {'성공' if s == 200 else '실패 ' + str(r.get('detail'))}  {ms / 1000:.1f}초")


# ----------------------------------------------------------------------
# 시나리오
# ----------------------------------------------------------------------


def cmd_run(a):
    img = _image(a.image)
    ensure_site_record(a.site)
    print(f"\n[1] 한 명씩 차례로 {a.count}건 (간격 {a.gap}초)")
    for i in range(a.count):
        rec = one_check("sequential", a.site, f"M{i + 1:03d}", img, think=a.think)
        print(f"  {i + 1:>2}. {_line(rec)}")
        time.sleep(a.gap)


def cmd_burst(a):
    img = _image(a.image)
    for round_no in range(a.rounds):
        print(f"\n[2] 동시 검사 {a.size}건 (라운드 {round_no + 1}/{a.rounds})")
        results = [None] * a.size
        start = threading.Barrier(a.size)

        def worker(i):
            start.wait()
            results[i] = one_check("burst", a.site, f"B{round_no + 1}{i + 1:02d}", img)

        ts = [threading.Thread(target=worker, args=(i,)) for i in range(a.size)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for i, rec in enumerate(results):
            print(f"  {i + 1:>2}. {_line(rec)}")
        time.sleep(15)


def cmd_boundary(a):
    img = _image(a.image)
    on_time = int(contract.functions.CHECKIN_ON_TIME().call()) // 60
    cases = [(0, "정상"), (on_time - 1, "정상"), (on_time + 1, "지연"), (on_time * 3, "지연")]
    print(f"\n[3] 시간 경계: 정상 판정 기준 {on_time}분")
    for minutes, expect in cases:
        rec = one_check("boundary", a.site, f"T{minutes:03d}", img, minutes_ago=minutes)
        rec_status = rec.get("entryStatus")
        got = "지연" if rec_status == "LateAuditOnly" else ("의심" if rec_status == "SuspectTimestamp" else "정상")
        ok = "OK" if got == expect else "다름"
        print(f"  {minutes:>3}분 전 서명 → {rec_status!s:<16} 예상 {expect} / 결과 {got}  [{ok}]")
        with _lock, (OUT / "boundary.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"minutesAgo": minutes, "expect": expect, "got": got, "status": rec_status,
                                "nonce": rec.get("nonce")}, ensure_ascii=False) + "\n")
        time.sleep(3)


# ----------------------------------------------------------------------
# 리포트: runs.jsonl + 체인 데이터
# ----------------------------------------------------------------------


def _pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, round(p / 100 * (len(xs) - 1))))]


def _summ(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None

    def r(v):  # 아주 작은 값(가스 가격 등)이 0.0으로 뭉개지지 않게 유효숫자 3자리
        return round(v, 2) if abs(v) >= 1 or v == 0 else float(f"{v:.3g}")

    return {"n": len(xs), "mean": r(statistics.mean(xs)), "p50": r(_pct(xs, 50)),
            "p95": r(_pct(xs, 95)), "max": r(max(xs)), "min": r(min(xs))}


def _rpc_latency_ms(n=10):
    out = []
    for _ in range(n):
        t = time.monotonic()
        w3.eth.block_number
        out.append((time.monotonic() - t) * 1000)
    return _summ(out)


def cmd_report(a):
    if not RUNS.exists():
        print("measure_out/runs.jsonl 이 없다. 먼저 run/burst/boundary 를 실행")
        return
    runs = [json.loads(line) for line in RUNS.read_text(encoding="utf-8").splitlines() if line.strip()]
    head = w3.eth.block_number
    span = min(200, head)
    t_head, t_old = w3.eth.get_block(head).timestamp, w3.eth.get_block(head - span).timestamp
    gaps = []
    prev = None
    for b in range(max(0, head - 30), head + 1):
        ts = w3.eth.get_block(b).timestamp
        if prev is not None:
            gaps.append(ts - prev)
        prev = ts

    rows = []
    blocks = {}
    for r in runs:
        if r.get("kind") == "site_record":
            row = {"kind": "site_record", "ok": not r.get("error"), "gateTotalS": r["totalMs"] / 1000,
                   "error": r.get("error")}
            if r.get("txHash"):
                rc = w3.eth.get_transaction_receipt(r["txHash"])
                row.update(gasUsed=rc.gasUsed, feeEth=rc.gasUsed * rc.effectiveGasPrice / 1e18,
                           gasPriceGwei=rc.effectiveGasPrice / 1e9)
            rows.append(row)
            continue
        m = r.get("marksMs", {})
        end = m.get("confirmed", m.get("not_anchored"))
        row = {
            "kind": r["kind"], "worker": r["worker"], "minutesAgo": r.get("minutesAgo", 0),
            "ok": bool(r.get("txHash")) and not r.get("error"), "error": r.get("error"),
            "status": r.get("entryStatus"), "deviceSeq": r.get("deviceSeq"),
            "qrIssueS": r.get("qrIssueMs", 0) / 1000,
            "inspectS": (m["signing"] - m.get("inspecting", 0)) / 1000 if "signing" in m else None,
            "signS": (m["auditing"] - m["signing"]) / 1000 if "auditing" in m and "signing" in m else None,
            "auditS": (m["anchoring"] - m["auditing"]) / 1000 if "anchoring" in m and "auditing" in m else None,
            "anchorS": (end - m["anchoring"]) / 1000 if end is not None and "anchoring" in m else None,
            "gateTotalS": r.get("gateTotalMs", 0) / 1000,
        }
        if r.get("txHash"):
            rc = w3.eth.get_transaction_receipt(r["txHash"])
            if rc.blockNumber not in blocks:
                blocks[rc.blockNumber] = w3.eth.get_block(rc.blockNumber).timestamp
            st = contract.functions.getCheckIn(chain.from_hex0x(r["nonce"])).call()
            data, anchored = st[0], st[3]
            signed, qr_issued = data[12], data[9]
            row.update(
                block=rc.blockNumber, gasUsed=rc.gasUsed, gasPriceGwei=rc.effectiveGasPrice / 1e9,
                feeEth=rc.gasUsed * rc.effectiveGasPrice / 1e18,
                signToBlockS=anchored - signed - r.get("minutesAgo", 0) * 60,  # 재전송 시연은 당긴 만큼 빼고 본다
                qrToSignS=signed - qr_issued,
                # 블록 시각(슬롯 시작) → 이 컴퓨터가 확정을 받은 시각: 블록 전파 + 영수증 조회 지연
                blockToSeenS=round(r["finishedAt"] - blocks[rc.blockNumber], 1),
            )
        rows.append(row)

    checks = [x for x in rows if x["kind"] in ("sequential", "burst") ]
    ok = [x for x in checks if x["ok"]]
    seq = [x for x in ok if x["kind"] == "sequential"]
    burst = [x for x in checks if x["kind"] == "burst"]
    site = [x for x in rows if x["kind"] == "site_record"]
    boundary = []
    bpath = OUT / "boundary.jsonl"
    if bpath.exists():
        boundary = [json.loads(line) for line in bpath.read_text(encoding="utf-8").splitlines() if line.strip()]

    report = {
        "measuredAt": datetime.now(KST).isoformat(timespec="seconds"),
        "chainId": w3.eth.chain_id,
        "contract": config.CONTRACT_ADDRESS,
        "rpc": config.RPC_URL,
        "constants": {k: int(getattr(contract.functions, k)().call()) for k in (
            "CHECKIN_ON_TIME", "CHECKIN_LATE_LIMIT", "CHECKIN_SUSPECT_FUTURE", "RECORD_WINDOW",
            "MAX_CLOCK_SKEW", "MAX_QR_TTL")},
        "chain": {
            "span": span,
            "blockIntervalAvgS": round((t_head - t_old) / span, 2),
            "blockIntervalLast30": _summ(gaps),
            "headAgeS": round(time.time() - t_head, 1),
            "rpcLatencyMs": _rpc_latency_ms(),
        },
        "sequential": {
            "count": len([x for x in checks if x["kind"] == "sequential"]), "ok": len(seq),
            "qrIssueS": _summ([x["qrIssueS"] for x in seq]),
            "inspectS": _summ([x["inspectS"] for x in seq]),
            "signS": _summ([x["signS"] for x in seq]),
            "auditS": _summ([x["auditS"] for x in seq]),
            "anchorS": _summ([x["anchorS"] for x in seq]),
            "gateTotalS": _summ([x["gateTotalS"] for x in seq]),
            "signToBlockS": _summ([x.get("signToBlockS") for x in seq]),
            "blockToSeenS": _summ([x.get("blockToSeenS") for x in seq]),
        },
        "burst": {
            "count": len(burst), "ok": len([x for x in burst if x["ok"]]),
            "gateTotalS": _summ([x["gateTotalS"] for x in burst if x["ok"]]),
            "signToBlockS": _summ([x.get("signToBlockS") for x in burst if x["ok"]]),
            "errors": [x["error"] for x in burst if not x["ok"]],
        },
        "gas": {
            "checkIn": _summ([x.get("gasUsed") for x in ok]),
            "checkInFeeEth": _summ([x.get("feeEth") for x in ok]),
            "gasPriceGwei": _summ([x.get("gasPriceGwei") for x in ok]),
            "siteRecord": _summ([x.get("gasUsed") for x in site]),
        },
        "siteRecordS": _summ([x["gateTotalS"] for x in site if x["ok"]]),
        "boundary": boundary,
        "statuses": {s: len([x for x in ok if x["status"] == s]) for s in {x["status"] for x in ok}},
    }
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    keys = sorted({k for x in rows for k in x})
    with (OUT / "checkins.csv").open("w", encoding="utf-8-sig") as f:
        f.write(",".join(keys) + "\n")
        for x in rows:
            f.write(",".join("" if x.get(k) is None else str(x.get(k)).replace(",", ";") for k in keys) + "\n")

    text = _render(report)
    (OUT / "report.txt").write_text(text, encoding="utf-8")
    print(text)


def _fmt(s, unit="초"):
    if not s:
        return "데이터 없음"
    return f"평균 {s['mean']}{unit} / 중앙 {s['p50']}{unit} / 95% {s['p95']}{unit} / 최대 {s['max']}{unit} (n={s['n']})"


def _render(r):
    c, sq, b, g = r["chain"], r["sequential"], r["burst"], r["gas"]
    lines = [
        f"측정 {r['measuredAt']}  체인 {r['chainId']}  RPC {r['rpc']}",
        f"블록 간격: 최근 {r['chain']['span']}블록 평균 {c['blockIntervalAvgS']}초 / 최근 30블록 {_fmt(c['blockIntervalLast30'])}",
        f"RPC 왕복: {_fmt(c['rpcLatencyMs'], 'ms')}",
        f"최신 블록 경과(블록 나이 + 시계 차이): {c['headAgeS']}초",
        f"기기 시계 점검: 서명→블록 최솟값 {(sq['signToBlockS'] or {}).get('min')}초 (0 이상이면 기기 시계가 체인보다 빠르지 않음)",
        "",
        f"[차례로 검사] 성공 {sq['ok']}/{sq['count']}",
        f"  QR 발급              {_fmt(sq['qrIssueS'])}",
        f"  QR 확인 + AI 판정     {_fmt(sq['inspectS'])}",
        f"  기기 서명            {_fmt(sq['signS'])}",
        f"  감사 저장소 전송      {_fmt(sq['auditS'])}",
        f"  릴레이 → 체인 확정    {_fmt(sq['anchorS'])}",
        f"  게이트 전체 대기      {_fmt(sq['gateTotalS'])}",
        f"  서명 → 블록 시각      {_fmt(sq['signToBlockS'])}",
        f"  블록 시각 → 확정 수신 {_fmt(sq['blockToSeenS'])}",
        "",
        f"[동시 검사] 성공 {b['ok']}/{b['count']}  게이트 전체 {_fmt(b['gateTotalS'])}",
    ]
    for e in b["errors"]:
        lines.append(f"  실패: {str(e)[:160]}")
    lines += [
        "",
        f"[가스] 출입 기록 1건 {_fmt(g['checkIn'], '')}",
        f"       출입 기록 1건 수수료 {_fmt(g['checkInFeeEth'], ' ETH')}",
        f"       가스 가격 {_fmt(g['gasPriceGwei'], ' gwei')}",
        f"       위험성평가 1건 {_fmt(g['siteRecord'], '')}",
        "",
        "[시간 경계]",
    ]
    for x in r["boundary"]:
        lines.append(f"  {x['minutesAgo']:>3}분 전 서명 → {x['status']} (예상 {x['expect']}, 결과 {x['got']})")
    lines.append("")
    lines.append(f"[분류] {r['statuses']}")
    lines.append(f"[현재 상수] {r['constants']}")
    return "\n".join(lines)


def cmd_all(a):
    cmd_run(a)
    cmd_burst(a)
    cmd_boundary(a)
    cmd_report(a)


def main():
    ap = argparse.ArgumentParser(description="SafetyChain Sepolia 실측")
    ap.add_argument("cmd", choices=["all", "run", "burst", "boundary", "report"])
    ap.add_argument("--site", default="measure-site")
    ap.add_argument("--count", type=int, default=20, help="run: 차례로 검사할 건수")
    ap.add_argument("--gap", type=float, default=3, help="run: 검사 사이 간격(초)")
    ap.add_argument("--think", type=float, default=0, help="run: QR 발급 후 게이트에 서기까지 기다릴 시간(초)")
    ap.add_argument("--size", type=int, default=4, help="burst: 동시에 검사할 인원")
    ap.add_argument("--rounds", type=int, default=2, help="burst: 반복 횟수")
    ap.add_argument("--image", help="검사 사진 경로 (없으면 회색 이미지)")
    a = ap.parse_args()
    if a.cmd != "report":
        s, h = _req("GET", f"{GATE}/health")
        if s != 200:
            print(f"게이트 서비스({GATE})가 응답하지 않는다. 서비스 4개를 먼저 켠다")
            sys.exit(1)
    {"all": cmd_all, "run": cmd_run, "burst": cmd_burst, "boundary": cmd_boundary, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
