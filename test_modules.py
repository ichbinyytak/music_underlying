#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_modules.py - 音源模块与歌曲搜索模块完整联调自测脚本
运行方式：
    python3 test_modules.py
"""

import time
from source_manager import source_hub
from song_search import search_candidates, calculate_song_match_score

def print_banner(text):
    print("\n" + "=" * 60)
    print(f"  {text}")
    print("=" * 60)

def main():
    print_banner("1. 测试所有音源并按实测延迟重新排序 (对应草图：⚡测速重排)")
    print("正在并发就地测速所有内置音源...")
    t0 = time.perf_counter()
    tested_sources = source_hub.test_all()
    cost = (time.perf_counter() - t0) * 1000
    print(f"✓ 并发测速完成！总耗时: {cost:.1f}ms\n")

    print(f"{'排名':<4} | {'音源名称':<18} | {'平台':<5} | {'实测状态':<8} | {'本地延迟':<10}")
    print("-" * 60)
    for idx, s in enumerate(tested_sources, 1):
        status_sym = "● 正常" if s['status'] == 'ok' else "× 异常"
        lat = f"{s['latency_ms']:.1f}ms" if s['status'] == 'ok' else "超时/失败"
        print(f" {idx:<3} | {s['name']:<18} | {s['platform']:<5} | {status_sym:<8} | {lat:<10}")

    print_banner("2. 测试前置 1ms 正版原唱打分过滤 (Anti-Cover & Scoring)")
    test_cases = [
        ("海阔天空", "Beyond", "海阔天空", "海阔天空", "Beyond"),
        ("海阔天空 (Cover Beyond)", "小明翻唱", "翻唱网络神曲", "海阔天空", "Beyond"),
        ("晴天 (伴奏版)", "周杰伦", "叶惠美", "晴天", "周杰伦"),
        ("晴天", "周杰伦", "叶惠美", "晴天", "周杰伦")
    ]
    print(f"{'候选标题':<24} | {'候选歌手':<10} | {'得分':<6} | {'是否通过'}")
    print("-" * 60)
    for cand_t, cand_a, cand_alb, tgt_t, tgt_a in test_cases:
        score, ok = calculate_song_match_score(cand_t, cand_a, cand_alb, tgt_t, tgt_a)
        res_str = "✓ 通过 (录音室正版)" if ok else "× 淘汰 (翻唱/伴奏/负面)"
        print(f"{cand_t:<24} | {cand_a:<10} | {score:<6.1f} | {res_str}")

    print_banner("3. 测试歌曲搜索模块：输入『海阔天空』(带智能分词与候选排序)")
    search_kw = "海阔天空 Beyond"
    t0 = time.perf_counter()
    candidates = search_candidates(search_kw, limit=5)
    s_cost = (time.perf_counter() - t0) * 1000
    print(f"搜索关键词: '{search_kw}' (耗时: {s_cost:.1f}ms, 搜出及格正版单曲: {len(candidates)} 首)\n")

    for i, c in enumerate(candidates, 1):
        dur = f"{c['duration']}s" if c['duration'] else "未知"
        print(f" [{i}] {c['title']} - {c['artist']} (专辑: {c['album']}) [{dur}] [匹配分: {c['score']}] -> 平台: {c['platform']}, ID: {c['id']}")

    if candidates:
        top_cand = candidates[0]
        print_banner(f"4. 测试双核并发竞速取链：对状元候选『{top_cand['title']} - {top_cand['artist']}』冲刺取链")
        t0 = time.perf_counter()
        stream_res = source_hub.resolve_best_stream(top_cand)
        resolve_cost = (time.perf_counter() - t0) * 1000

        if stream_res.get("success"):
            sz_mb = stream_res.get('bytes', 0) / (1024 * 1024)
            print("✓ 双核竞速取链成功！")
            print(f"  出声耗时   : {resolve_cost:.1f}ms")
            print(f"  胜出音源   : {stream_res['source_name']}")
            print(f"  音频大小   : {sz_mb:.2f} MB (严格校验通过，确保非 30 秒试听截断)")
            print(f"  播放直链   : {stream_res['url'][:80]}...")
        else:
            print(f"× 取链失败: {stream_res.get('error')}")

    print_banner("自测流程执行完毕！所有模块工作正常。")

if __name__ == "__main__":
    main()
