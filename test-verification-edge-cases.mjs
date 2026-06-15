#!/usr/bin/env node
// Test edge cases and potential issues in verification tier logic

const now = Date.now();
const REPRESENTATIVE_EVIDENCE_TTL_MS = 30 * 60 * 1000;

function representativeEvidenceFresh(item, at = now) {
  const expiresAt = Date.parse(item?.expires_at || '');
  return Number.isFinite(expiresAt) && expiresAt > at;
}

function representativeAvailability(upstream, { model = '', protocol = 'responses', at = now } = {}) {
  const normalizedModel = String(model || '').trim();
  const evidence = [];

  for (const key of upstream?.keys || []) {
    const byModel = key?.representativeEvidence?.[protocol] || {};

    if (normalizedModel) {
      const item = byModel[normalizedModel];
      if (!item) continue;
      const checkedAtMs = Date.parse(item.checked_at || '');
      evidence.push({
        keyLabel: key.label || '',
        source: String(item.source || ''),
        checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
        fresh: representativeEvidenceFresh(item, at)
      });
    } else {
      for (const [modelName, item] of Object.entries(byModel)) {
        if (!item) continue;
        const checkedAtMs = Date.parse(item.checked_at || '');
        evidence.push({
          keyLabel: key.label || '',
          modelName: modelName,
          source: String(item.source || ''),
          checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
          fresh: representativeEvidenceFresh(item, at)
        });
      }
    }
  }

  const freshEvidence = evidence.filter((item) => item.fresh);
  const latest = evidence.slice().sort((a, b) => b.checkedAtMs - a.checkedAtMs)[0];
  const state = freshEvidence.length > 0 ? 'fresh' : evidence.length > 0 ? 'stale' : 'missing';

  return {
    protocol,
    model: normalizedModel,
    aggregated: !normalizedModel,
    state,
    verified: freshEvidence.length > 0,
    fresh_evidence_count: freshEvidence.length,
    evidence_count: evidence.length,
    sources: [...new Set(freshEvidence.map((item) => item.source).filter(Boolean))].sort(),
    latest_checked_at: latest?.checkedAtMs ? new Date(latest.checkedAtMs).toISOString() : '',
    multiplier: state === 'fresh' ? 1.15 : 1
  };
}

function verificationTier(upstream) {
  if (upstream.available && upstream.representative_availability?.verified === true) return 'real_verified';
  if (upstream.available && upstream.health?.state === 'ok') return 'probe_only';
  if (upstream.available) return 'real_pending';
  return 'unavailable';
}

const TIER_LABELS = {
  real_verified: '真实请求验证',
  probe_only: '一层检测通过',
  real_pending: '可选待真实验证',
  unavailable: '不可用'
};

console.log('='.repeat(80));
console.log('Edge Case Analysis: Verification Tier Logic');
console.log('='.repeat(80));

// Issue 1: 语义不一致问题
console.log('\n🔍 Issue 1: "一层检测通过" 的语义问题');
console.log('-'.repeat(80));
console.log(`
当前逻辑:
  if (upstream.available && upstream.representative_availability?.verified === true)
    → return 'real_verified' (真实请求验证)
  if (upstream.available && upstream.health?.state === 'ok')
    → return 'probe_only' (一层检测通过)

问题：
  "一层检测通过" 字面意思是"只通过了一层检测"，暗示验证层级较低。
  但实际上 health?.state === 'ok' 表示 Health Probe 成功，这是一个有效的验证。

  更困惑的是：如果 upstream 同时满足：
    - health.state === 'ok' (Health Probe 成功)
    - representative_availability.verified === true (有新鲜的真实请求证据)

  它会被归类为 'real_verified' 而不是 'probe_only'，
  但标签 "一层检测通过" 暗示这个状态比 real_verified 低级。

场景示例：
  1. Upstream A: health.state='ok', 无真实请求证据
     → 显示 "一层检测通过"

  2. Upstream B: health.state='ok', 有新鲜真实请求证据
     → 显示 "真实请求验证"

  用户疑惑：为什么 A 是"一层检测"，但 B 明明也通过了健康检查却不显示？
`);

// Issue 2: real_pending 的命名问题
console.log('\n🔍 Issue 2: "可选待真实验证" 的语义模糊');
console.log('-'.repeat(80));
console.log(`
当前逻辑:
  if (upstream.available)
    → return 'real_pending' (可选待真实验证)

触发条件：
  - upstream.available === true
  - representative_availability.verified === false (没有新鲜证据)
  - health.state !== 'ok' (Health Probe 失败或未执行)

问题：
  "可选待真实验证" 这个标签暗示：
    - "可选" = 可以选择用不用
    - "待真实验证" = 等待真实请求验证

  但实际情况可能是：
    - Health Probe 失败了 (rate_limited, server_error, timeout)
    - 真实请求证据过期了
    - Missing key

  这些情况下，upstream 可能不是"可选"的，而是"有问题"的。

场景示例：
  Upstream C:
    - available = true
    - health.state = 'rate_limited'
    - 无真实请求证据

  显示 "可选待真实验证"

  用户理解：这个 upstream 可以用，只是还没有真实验证过
  实际情况：这个 upstream 被 rate limited 了，不应该用
`);

// Issue 3: 状态判断的优先级问题
console.log('\n🔍 Issue 3: 判断优先级可能导致误导');
console.log('-'.repeat(80));
console.log(`
当前逻辑的优先级：
  1. representative_availability.verified === true
  2. health.state === 'ok'
  3. available === true
  4. 其他 → unavailable

潜在问题场景：

Scenario A: 真实请求证据刚过期
  - 5 分钟前：有真实请求成功 → 显示 "真实请求验证"
  - 现在：证据过期 (30分钟 TTL)，但 health.state='ok'
  - 显示变为 "一层检测通过"

  问题：从用户角度，这个 upstream 从"真实请求验证"降级到"一层检测通过"，
       暗示可靠性下降。但实际上，health probe 一直在通过，只是证据过期了。

Scenario B: Health Probe 间歇性失败
  - Health Probe 每 60 秒执行一次
  - 某次失败 (网络抖动) → health.state = 'timeout'
  - 但有新鲜的真实请求证据 (5分钟前成功)
  - 显示仍然是 "真实请求验证" (因为 verified=true 优先级高)

  问题：Health Probe 失败了，但 UI 没有反映这个问题。
`);

// Issue 4: Protocol 特定性问题
console.log('\n🔍 Issue 4: representative_availability 是 protocol 特定的');
console.log('-'.repeat(80));
console.log(`
representative_availability 的计算逻辑 (server.mjs:11946-11963):

  if (upstream.api === 'anthropic') {
    return representativeAvailability(upstream, {
      model: state.modelOverride,
      protocol: 'anthropic_messages',
      at
    });
  }
  if (upstream.api === 'openai') {
    return representativeAvailability(upstream, {
      model: state.modelOverride,
      protocol: 'responses',
      at
    });
  }
  // For 'both', try both and pick the one with more evidence

问题：
  verification tier 的判断是基于单一 protocol 的 representative_availability。

  但 upstream 可能：
    - responses protocol: 有真实请求证据 (verified=true)
    - anthropic_messages protocol: 只有 probe 证据

  如果当前选择显示 responses 的结果，tier = 'real_verified'
  如果当前选择显示 messages 的结果，tier = 'probe_only'

  对于 api='both' 的 upstream，显示的 tier 取决于内部算法选择了哪个 protocol，
  用户看到的可能不是完整的验证状态。
`);

console.log('\n' + '='.repeat(80));
console.log('📊 建议改进方案');
console.log('='.repeat(80));

console.log(`
方案 1: 重新设计层级名称（推荐）
  ✅ verified_by_traffic: "已验证（真实流量）"
  ✅ verified_by_probe: "已验证（探测）"
  ⏳ pending_verification: "待验证"
  ❌ unavailable: "不可用"

  优点：
    - 语义清晰，层级关系明确
    - 避免"一层"这种容易误解的说法
    - "待验证"比"可选待验证"更准确

方案 2: 增加更多状态（信息量更大）
  ✅ verified_by_traffic: "真实流量验证"
  ✅ verified_by_probe: "探测验证"
  ⚠️  probe_failed: "探测失败"
  ⏳ not_yet_verified: "未验证"
  ❌ unavailable: "不可用"

  优点：
    - 区分"待验证"和"验证失败"
    - 用户可以知道是"还没测试"还是"测试失败了"

方案 3: 修复当前逻辑（最小改动）

  function verificationTier(upstream) {
    // 优先级 1: 有新鲜的真实请求证据
    if (upstream.available && upstream.representative_availability?.verified === true) {
      return 'real_verified';  // 保持 "真实请求验证"
    }

    // 优先级 2: Health Probe 通过
    if (upstream.available && upstream.health?.state === 'ok') {
      return 'probe_verified';  // 改为 "探测验证" 或 "健康检查通过"
    }

    // 优先级 3: Available 但有问题
    if (upstream.available) {
      // 细分状态
      const healthState = upstream.health?.state || '';
      if (['rate_limited', 'server_error', 'timeout', 'network_error'].includes(healthState)) {
        return 'probe_failed';  // "探测失败"
      }
      if (healthState === 'missing_key') {
        return 'missing_key';  // "缺少密钥"
      }
      return 'pending_verification';  // "待验证"
    }

    return 'unavailable';
  }

方案 4: 使用 Protocol Capability 状态（最准确）

  基于现有的 src/verification-tier.mjs 模块：

  export function deriveVerificationTier(upstream) {
    // proven_by_traffic: 至少一个 protocol 有 verified + real_traffic 证据
    // proven_by_probe: 至少一个 protocol 有 verified + probe 证据
    // not_verified: 没有任何 verified protocol
  }

  这个模块已经存在，但 Dashboard 没有使用它！
  应该使用这个模块来确保跨 protocol 的验证状态正确。
`);

console.log('\n' + '='.repeat(80));
console.log('🔬 实际问题诊断');
console.log('='.repeat(80));
console.log(`
让我检查实际的问题根源：

1. ❓ Dashboard 是否使用了正确的 verification tier 计算？
   → 当前使用 representative_availability.verified，这是 protocol 特定的
   → 应该使用 verification-tier.mjs 的 deriveVerificationTier()

2. ❓ representative_availability 的 protocol 选择逻辑是否合理？
   → 对于 api='both'，选择哪个 protocol 可能不一致
   → 应该显示所有 protocol 的综合验证状态

3. ❓ 标签名称是否导致用户困惑？
   → "一层检测通过" 的确容易误解
   → "可选待真实验证" 语义模糊

建议优先解决：
  1. 使用 verification-tier.mjs 模块（已存在但未使用）
  2. 重新命名标签（方案 1）
  3. 增加细分状态（方案 2，可选）
`);

console.log('\n✅ 测试完成');
