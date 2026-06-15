#!/bin/bash
# Git 提交脚本 - 任务 2 阶段 1+2 和任务 3
# 日期: 2026-06-14

set -e  # 出错时退出

echo "🚀 准备提交任务 2 (阶段 1+2) 和任务 3..."
echo ""

# ============================================================================
# Commit 1: 任务 3 - 合并 Probe Result Applicator
# ============================================================================

echo "📦 Commit 1: 任务 3 - 合并 Probe Result Applicator"

git add src/protocol-capability-manager.mjs
git add test/protocol-capability-manager.test.mjs
git add src/probe-result-applicator.mjs

git commit -m "feat: Merge probe-result-applicator into protocol-capability-manager

Task 3: Eliminate shallow module, create deep module

Changes:
- Add deriveHealthFromProbe() helper function (~50 lines)
  - Maps probe classification states to health states
  - Exported for reuse

- Add ProtocolCapabilityManager.applyProbeResult() method (~70 lines)
  - Single call updates three states:
    * Protocol Capability (via recordProtocolCapabilityProbe)
    * upstream.health
    * key.health
  - Determines cooldown action
  - Interface: applyProbeResult(key, protocol, probeResult, classified, options)
  - Returns: { shouldCooldown, cooldownReason }

- Add 7 new tests (40/40 passing):
  * OK probe updates capability and health
  * auth_error triggers cooldown
  * network_error triggers cooldown
  * server_error triggers cooldown
  * inconclusive does not trigger cooldown
  * Timestamp and model synchronization
  * Key health update and label reference

- Keep probe-result-applicator.mjs as DEPRECATED compatibility layer
  - Delegates to new manager implementation
  - All old tests still pass (7/7)

Architecture improvement:
- Before: probe-result-applicator.mjs (108 lines) - shallow module
- After: protocol-capability-manager.mjs - deep module, unified management
- Responsibility: Protocol capability manager is now the single entry point

Test results:
- protocol-capability-manager.test.mjs: 40/40 ✓
- probe-result-applicator.test.mjs: 7/7 ✓
- smoke-test.mjs: all passed ✓

Time: ~1 hour
Method: TDD (Test-Driven Development)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

echo "✅ Commit 1 完成"
echo ""

# ============================================================================
# Commit 2: 任务 2 阶段 1+2 - Probe Orchestrator 增强
# ============================================================================

echo "📦 Commit 2: 任务 2 阶段 1+2 - Probe Orchestrator 增强"

git add src/protocol-probe-orchestrator.mjs
git add test/protocol-probe-orchestrator.test.mjs

git commit -m "feat: Enhance ProtocolProbeOrchestrator with recheck strategy and health management

Task 2 Phase 1+2: Build intelligent probe orchestration

Phase 1 - Planning Capabilities (~1 hour):
- Integrate recheck strategy (shouldRecheckProtocolCapability)
  * Check protocol capability status
  * Skip unsupported protocols when no recheck needed
  * Include protocols when recheck is due
  * Mark recheck reason as 'recheck'

- Handle resolvedRequestMode optimization
  * Skip responses when resolvedRequestMode=chat_completions
  * Unless recheck is due

- Add classifier injection support
  * Constructor accepts optional classifier parameter
  * executeProbes uses injected classifier
  * Provides default simple classifier as fallback

- Add 4 new tests (14/14 passing):
  * Skip unsupported protocol when no recheck needed
  * Include unsupported protocol when recheck is due
  * Skip responses with resolvedRequestMode=chat_completions
  * Use custom classifier correctly

Phase 2 - Health Management (~1 hour):
- Add determineHealthStatus() method (~105 lines)
  * Implement health priority decision logic
  * OpenAI dual-protocol decision (responses ok > chat ok)
  * Anthropic single-protocol handling
  * Failure scenario error reporting
  * Determine resolvedMode

- Add probeUpstream() end-to-end orchestration (~30 lines)
  * Combines planning, execution, and health determination
  * Returns { health, probeResults, plan }
  * Single call for complete upstream probe

- Add 6 new tests (20/20 passing):
  * Chat ok chosen over responses failure
  * Responses ok is preferred
  * Anthropic ok is used correctly
  * Both failed reports authoritative error
  * Full orchestration flow with responses success
  * Full orchestration flow with fallback to chat

Architecture improvement:
- planProbes() now integrates:
  * Protocol capability status checking
  * Recheck strategy logic
  * resolvedRequestMode optimization
  * Smart protocol skipping

- determineHealthStatus() implements:
  * Health priority rules (OK > auth_error > other)
  * Protocol preference (responses > chat for OpenAI)
  * resolvedMode determination

- probeUpstream() provides:
  * End-to-end orchestration
  * Clean integration interface
  * Ready for server.mjs integration (Phase 3)

Test results:
- protocol-probe-orchestrator.test.mjs: 20/20 ✓
- smoke-test.mjs: all passed ✓

Preparation for Phase 3:
- Orchestrator is fully functional and tested
- Ready to replace lines 8380-8511 in server.mjs (~130 lines)
- Integration guide created: docs/TASK2-PHASE3-INTEGRATION-GUIDE.md

Time: ~2 hours total (Phase 1: 1h, Phase 2: 1h)
Method: TDD (Test-Driven Development)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

echo "✅ Commit 2 完成"
echo ""

# ============================================================================
# Commit 3: 文档更新
# ============================================================================

echo "📦 Commit 3: 文档更新"

git add TODO.md
git add docs/TASK3-COMPLETION-REPORT.md
git add docs/TASK2-PHASE1-COMPLETION.md
git add docs/TASK2-PHASE2-COMPLETION.md
git add docs/TASK2-PHASE3-INTEGRATION-GUIDE.md
git add SESSION-TASK3-SUMMARY.md
git add SESSION-2026-06-14-FINAL-SUMMARY.md

git commit -m "docs: Update progress and add completion reports for Task 2+3

Documentation updates:
- TODO.md: Update to 50% progress (7h completed / 11-13h estimated)
  * Task 2: Phase 2/3 complete (阶段 1+2 完成)
  * Task 3: 100% complete
  * Overall progress: 50%

- Task 3 documentation:
  * docs/TASK3-COMPLETION-REPORT.md - Detailed completion report
  * SESSION-TASK3-SUMMARY.md - Session summary

- Task 2 Phase 1 documentation:
  * docs/TASK2-PHASE1-COMPLETION.md - Phase 1 detailed report
  * Recheck strategy integration
  * 4 new tests

- Task 2 Phase 2 documentation:
  * docs/TASK2-PHASE2-COMPLETION.md - Phase 2 detailed report
  * Health status management
  * 6 new tests

- Task 2 Phase 3 preparation:
  * docs/TASK2-PHASE3-INTEGRATION-GUIDE.md - Integration guide for next session
  * Step-by-step integration plan
  * Expected results and potential issues

- Session summary:
  * SESSION-2026-06-14-FINAL-SUMMARY.md - Complete session summary
  * 3 hours total work time
  * 1.5 tasks completed (Task 3 + 67% of Task 2)
  * 17 new tests, 67/67 passing
  * 50% total progress

Progress summary:
✅ Task 0: 100% - Smoke Test fixes
✅ Task 1: 100% - Request Routing Rules extraction
🔄 Task 2: 67% - Probe Orchestrator (Phase 2/3 complete)
✅ Task 3: 100% - Probe Result Applicator merge
⏸️ Final Integration: 0%

Next steps:
- Task 2 Phase 3: Integrate orchestrator into server.mjs (2-3h)
- Or: Final integration of completed tasks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

echo "✅ Commit 3 完成"
echo ""

# ============================================================================
# 完成
# ============================================================================

echo "🎉 所有提交完成！"
echo ""
echo "提交摘要:"
echo "  Commit 1: 任务 3 - 合并 Probe Result Applicator"
echo "  Commit 2: 任务 2 阶段 1+2 - Probe Orchestrator 增强"
echo "  Commit 3: 文档更新"
echo ""
echo "下一步:"
echo "  git log --oneline -3  # 查看提交"
echo "  git push              # 推送到远程（如果需要）"
echo ""
echo "下次会话可以:"
echo "  1. 完成任务 2 阶段 3（集成到 server.mjs）"
echo "  2. 进入最终集成阶段"
echo ""
