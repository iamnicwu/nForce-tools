#!/usr/bin/env python3
"""把 snap.sh 抓到的 dump 解析成可读的差分表。

用法: python3 tools/jsforce-diff/report.py /tmp/jsforce-diff-dump.html
退出码: 0 = 全部一致；1 = 有 FAIL（方便接进脚本）
"""
import html
import json
import re
import sys


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/jsforce-diff-dump.html"
    src = open(path, encoding="utf-8", errors="replace").read()

    m = re.search(r'id="__report__"(.*?)</div>', src, re.S)
    if not m:
        print("找不到 #__report__，页面可能没跑起来（先确认 server.cjs 在跑、端口对）")
        return 1
    blk = m.group(1)

    status = re.search(r'data-status="([^"]*)"', blk)
    summary = re.search(r'data-summary="([^"]*)"', blk)
    detail = re.search(r'data-detail="(.*?)"(?:\s|>)', blk, re.S)
    print(f"STATUS : {status.group(1) if status else '?'}")
    print(f"SUMMARY: {summary.group(1) if summary else '?'}")
    print("=" * 78)

    if not detail:
        print("（没有 data-detail，可能还在 running）")
        return 1

    rows = json.loads(html.unescape(detail.group(1)))
    for r in rows:
        flag = "SKIP" if r.get("protoOnly") else ("PASS" if r.get("ok") else "FAIL")
        strict = "(严格异)" if r.get("reqSameStrict") is False and r.get("reqSame") else ""
        req = "—" if r.get("reqSame") is None else ("同" if r["reqSame"] else "异")
        mark = f" ★有意: {r['why']}" if r.get("intentional") and r.get("why") else ""
        print(f"[{flag}] {r['name']:32s} 请求:{req}{strict:8s} "
              f"值:{'同' if r.get('valSame') else '异'}{mark}")
        for key, label in (("valueDiffs", "值不同键"),
                           ("onlyA", "jsforce 独有键"),
                           ("onlyB", "原型独有键")):
            if r.get(key):
                print(f"        {label}: {', '.join(str(x) for x in r[key])}")
        if not r.get("valSame"):
            print(f"        jf   : {str(r.get('jf'))[:240]}")
            print(f"        原型 : {str(r.get('proto'))[:240]}")
        if r.get("reqSame") is False:
            print(f"        jf req  : {r.get('jfReq')}")
            print(f"        原型 req: {r.get('protoReq')}")

    failed = [r["name"] for r in rows if not r.get("ok")]
    if failed:
        print(f"\n失败 {len(failed)} 项: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
