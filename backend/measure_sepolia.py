"""Sepolia 실측: 체인에 올라간 출입 기록으로 시간 기준(10분·1시간·QR 10분)과 가스를 잰다.

    cd backend && python measure_sepolia.py            # 배포 이후 전체
    cd backend && python measure_sepolia.py --last 20  # 최근 20건만

키를 쓰지 않고 체인을 읽기만 한다. 결과는 measure_result.csv 에도 저장한다.
"""
import argparse
import csv
import statistics
import time

import config
import chain
from chain import contract, w3

DEPLOY_BLOCK = 12005611  # contracts/broadcast/Deploy.s.sol/11155111/run-latest.json
STEP = 2000  # 공개 RPC의 eth_getLogs 범위 제한 대비
STATUS = ["허가", "불합격", "평가없음 보류", "지연 도착", "위험요인 보류", "의심"]


def fetch_logs(start: int, end: int):
    logs = []
    ev = contract.events.CheckInRecorded()
    b = start
    while b <= end:
        to = min(b + STEP - 1, end)
        logs += ev.get_logs(from_block=b, to_block=to)
        b = to + 1
    return logs


def stats(name: str, xs: list[float], unit: str):
    if not xs:
        return
    xs = sorted(xs)
    p95 = xs[min(len(xs) - 1, int(len(xs) * 0.95))]
    print(f"  {name:<28} 평균 {statistics.mean(xs):8.1f}{unit}  중앙 {statistics.median(xs):8.1f}{unit}"
          f"  95% {p95:8.1f}{unit}  최대 {xs[-1]:8.1f}{unit}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--last", type=int, default=0)
    args = ap.parse_args()

    # 1) 블록 간격 (최근 50블록)
    head = w3.eth.block_number
    t_head = w3.eth.get_block(head).timestamp
    t_old = w3.eth.get_block(head - 50).timestamp
    print(f"체인 {w3.eth.chain_id} / 컨트랙트 {config.CONTRACT_ADDRESS}")
    print(f"최근 50블록 평균 간격: {(t_head - t_old) / 50:.1f}초")
    print(f"블록 시각과 이 컴퓨터 시계 차이: {time.time() - t_head:+.0f}초 (블록 간격만큼은 정상)\n")

    logs = fetch_logs(DEPLOY_BLOCK, head)
    if args.last:
        logs = logs[-args.last:]
    if not logs:
        print("아직 체인에 출입 기록이 없다. 게이트 검사를 몇 번 한 뒤 다시 실행.")
        return

    rows = []
    blocks = {}
    for lg in logs:
        nonce = lg.args.nonce
        s = contract.functions.getCheckIn(nonce).call()
        data, status, anchored = s[0], s[2], s[3]
        qr_issued, qr_exp, seq, signed = data[9], data[10], data[11], data[12]
        r = w3.eth.get_transaction_receipt(lg.transactionHash)
        tx = w3.eth.get_transaction(lg.transactionHash)
        if lg.blockNumber not in blocks:
            blocks[lg.blockNumber] = w3.eth.get_block(lg.blockNumber).timestamp
        rows.append({
            "seq": seq,
            "status": STATUS[status] if status < len(STATUS) else status,
            "qr_to_sign_s": signed - qr_issued,       # QR 발급 → 기기 서명 (사람이 게이트에서 쓰는 시간)
            "sign_to_block_s": anchored - signed,     # 기기 서명 → 블록 포함 (릴레이 + 체인)
            "qr_to_block_s": anchored - qr_issued,    # QR 발급 → 확정 전체
            "qr_ttl_s": qr_exp - qr_issued,
            "gas_used": r.gasUsed,
            "gas_price_gwei": r.effectiveGasPrice / 1e9,
            "fee_eth": r.gasUsed * r.effectiveGasPrice / 1e18,
            "tx": lg.transactionHash.hex(),
            "block": lg.blockNumber,
            "nonce_sent_block": tx.blockNumber,
        })

    print(f"출입 기록 {len(rows)}건")
    stats("QR 발급 → 기기 서명", [r["qr_to_sign_s"] for r in rows], "초")
    stats("기기 서명 → 블록 포함", [r["sign_to_block_s"] for r in rows], "초")
    stats("QR 발급 → 블록 포함", [r["qr_to_block_s"] for r in rows], "초")
    stats("가스 사용량", [r["gas_used"] for r in rows], "")
    stats("가스비(ETH, 테스트넷)", [r["fee_eth"] * 1e6 for r in rows], "µETH")

    worst = max(r["sign_to_block_s"] for r in rows)
    print("\n현재 기준과 비교")
    print(f"  정상 판정 10분(600초): 서명→블록 최대 {worst}초 → {'여유 있음' if worst < 600 else '넘는 건 있음, 기준 재검토'}")
    print(f"  QR 유효 10분: QR 발급→서명 최대 {max(r['qr_to_sign_s'] for r in rows)}초")
    print("  상태별:", {k: sum(1 for r in rows if r['status'] == k) for k in {r['status'] for r in rows}})

    with open("measure_result.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print("\n자세한 값: backend/measure_result.csv")


if __name__ == "__main__":
    main()
