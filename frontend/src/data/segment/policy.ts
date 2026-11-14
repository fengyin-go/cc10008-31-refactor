/**
 * 分片领域的纯判定与纯计算，不碰 localStorage、不碰 React。
 *
 * 规则状态链路与迁移分支原先各写了一遍校验，这里抽取成共用判定：
 * - 规则命令链（保存/启用/停用/删除）与迁移命令链（生成计划/执行步骤）都调用同一批 assertX 守卫；
 * - 守卫失败统一返回 { ok:false, message }，调用方原样透传给页面，写法只有一种。
 */
import type {
  MigrationBatch,
  MigrationStep,
  SegmentActionResult,
  SegmentConfigSnapshot,
  SegmentRule,
  SegmentRuleDraft,
  SegmentStatus,
  ShardNode,
  ShardResult,
  ShardStat,
  SkewCandidate,
} from './types'

export const ok = (message: string): SegmentActionResult => ({ ok: true, message })
export const fail = (message: string): SegmentActionResult => ({ ok: false, message })

/* ------------------------------------------------------------------ */
/* 共用判定：规则命令链与迁移命令链都从这里走，不再各写一遍              */
/* ------------------------------------------------------------------ */

export function findRule(rules: SegmentRule[], ruleId: number): SegmentRule | undefined {
  return rules.find((rule) => rule.id === ruleId)
}

export function assertRuleExists(rules: SegmentRule[], ruleId: number): SegmentActionResult {
  return findRule(rules, ruleId) ? ok('规则存在') : fail(`没有找到编号为 ${ruleId} 的分片规则`)
}

/** 启用态判定：生成计划等迁移动作只允许在「已启用」规则上发生。 */
export function isRuleActive(rule: SegmentRule): boolean {
  return rule.status === '已启用'
}

export function assertRuleActive(rule: SegmentRule): SegmentActionResult {
  if (isRuleActive(rule)) {
    return ok('规则处于已启用状态')
  }
  return fail(`规则「${rule.name}」当前为「${rule.status}」，已停用/未启用的规则不能生成新的迁移计划`)
}

/** 只有草稿规则允许删除；已被历史批次引用也不阻止删除草稿本身（批次按 ruleId 独立保留）。 */
export function assertRuleDeletable(rule: SegmentRule): SegmentActionResult {
  if (rule.status === '草稿') {
    return ok('草稿规则可删除')
  }
  return fail(`只有草稿状态的规则可以删除，「${rule.name}」当前为「${rule.status}」`)
}

/** 名称查重：跨全部规则（排除自身）阻止保存，保证规则名称不重复。 */
export function assertNameUnique(
  rules: SegmentRule[],
  name: string,
  selfId: number | null,
): SegmentActionResult {
  const duplicated = rules.some((rule) => rule.id !== selfId && rule.name === name)
  return duplicated ? fail(`规则名称「${name}」已存在，请换一个名称`) : ok('名称可用')
}

/** 草稿字段的完整性校验，保存与恢复启用前都会用到。 */
export function validateDraft(draft: SegmentRuleDraft): SegmentActionResult {
  if (!draft.name.trim()) {
    return fail('规则名称不能为空')
  }
  if (!draft.targetDataset.trim() || !draft.shardField.trim()) {
    return fail('目标数据集与分片字段不能为空')
  }
  if (!Number.isInteger(draft.shardCount) || draft.shardCount <= 0) {
    return fail('分片数量必须是正整数')
  }
  if (!(draft.skewThreshold > 0)) {
    return fail('数据倾斜阈值必须大于 0')
  }
  if (!draft.migrationStrategy.trim()) {
    return fail('迁移策略不能为空')
  }
  return ok('草稿校验通过')
}

/** 状态机：规则启用/停用只允许在相邻合法状态间流转。 */
const RULE_TRANSITIONS: Record<SegmentStatus, SegmentStatus[]> = {
  草稿: ['待校验'],
  待校验: ['已启用', '草稿'],
  已启用: ['已停用'],
  已停用: ['待校验'],
}

export function canTransition(from: SegmentStatus, to: SegmentStatus): boolean {
  return RULE_TRANSITIONS[from].includes(to)
}

export function assertTransition(rule: SegmentRule, target: SegmentStatus): SegmentActionResult {
  return canTransition(rule.status, target)
    ? ok('状态流转合法')
    : fail(`规则「${rule.name}」不能从「${rule.status}」流转到「${target}」`)
}

/* ------------------------------------------------------------------ */
/* 迁移分支共用判定                                                    */
/* ------------------------------------------------------------------ */

export function findBatch(batches: MigrationBatch[], batchId: number): MigrationBatch | undefined {
  return batches.find((batch) => batch.id === batchId)
}

/** 一个候选分片正在迁移时，既不能重新判定为已平衡，也不能再被纳入新计划。 */
export function hasMigratingCandidate(result: ShardResult | undefined): boolean {
  return !!result && result.candidates.some((candidate) => candidate.status === 'MIGRATING')
}

export function assertNoMigratingCandidate(result: ShardResult | undefined): SegmentActionResult {
  if (!result || !hasMigratingCandidate(result)) {
    return ok('没有进行中的迁移')
  }
  return fail('该规则存在正在迁移的候选分片，请等当前迁移结束后再生成新计划')
}

/* ------------------------------------------------------------------ */
/* 纯计算：稳定分片、倾斜判定                                          */
/* ------------------------------------------------------------------ */

/** 无依赖稳定字符串哈希，保证同一节点在同一算法/分片数量下归属确定。 */
export function stableHash(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 节点归属：算法切换后，只要算法与分片数量不变，归属就不变；已生成候选的归属不被回改。 */
export function assignShard(
  node: ShardNode,
  algorithm: SegmentConfigSnapshot['algorithm'],
  shardCount: number,
  roundRobinCursor: number,
): number {
  switch (algorithm) {
    case 'HASH':
      return stableHash(node.nodeId) % shardCount
    case 'RANGE':
      // 按节点编号尾部数字做区间划分，仍是确定性映射。
      return Number(node.nodeId.replace(/\D/g, '') || 0) % shardCount
    case 'ROUND_ROBIN':
      return roundRobinCursor % shardCount
    default:
      return stableHash(node.nodeId) % shardCount
  }
}

export type EvaluationInput = {
  rule: SegmentRule
  nodes: ShardNode[]
  /** 上一次结果：迁移中的候选需要原样携带，不能重新判定。 */
  previous?: ShardResult
}

/**
 * 评估分片与倾斜：
 * - 读取规则当前配置并冻结进结果快照（历史结果保留当次的分片数量/阈值）；
 * - 正在迁移（MIGRATING）的候选直接携带，不参与本次重判；
 * - 倾斜判定使用规则当前阈值——恢复启用后的下一次计算自然按新阈值重判。
 * 纯函数：同样输入必然得到同样输出，不产生半成品（由 store 一次性提交）。
 */
export function evaluateShards(input: EvaluationInput): ShardResult {
  const { rule, nodes, previous } = input
  const snapshot: SegmentConfigSnapshot = {
    algorithm: rule.algorithm,
    shardCount: rule.shardCount,
    skewThreshold: rule.skewThreshold,
    rebalanceTrigger: rule.rebalanceTrigger,
    migrationStrategy: rule.migrationStrategy,
  }

  const owners = nodes.map((node, index) => ({
    node,
    shardNo: assignShard(node, snapshot.algorithm, snapshot.shardCount, index),
  }))

  const totalLoad = nodes.reduce((sum, node) => sum + node.load, 0)
  const averageLoad = nodes.length === 0 ? 0 : totalLoad / snapshot.shardCount

  const stats: ShardStat[] = Array.from({ length: snapshot.shardCount }, (_, shardNo) => {
    const members = owners.filter((entry) => entry.shardNo === shardNo)
    const load = members.reduce((sum, entry) => sum + entry.node.load, 0)
    const skewRatio = averageLoad === 0 ? 0 : load / averageLoad
    return {
      shardNo,
      nodeCount: members.length,
      load,
      averageLoad,
      skewRatio: Number(skewRatio.toFixed(4)),
      skewed: averageLoad > 0 && skewRatio > rule.skewThreshold,
    }
  })

  const migrating = new Map(
    (previous?.candidates ?? [])
      .filter((candidate) => candidate.status === 'MIGRATING')
      .map((candidate) => [candidate.nodeId, candidate]),
  )

  const candidates: SkewCandidate[] = []
  owners.forEach(({ node, shardNo }) => {
    const inFlight = migrating.get(node.nodeId)
    if (inFlight) {
      // 迁移中的候选保持原归属与原状态，绝不因本次重判变成 BALANCED。
      candidates.push({ ...inFlight })
      return
    }
    const stat = stats[shardNo]
    if (stat.skewed) {
      candidates.push({
        candidateKey: `${rule.id}:${node.nodeId}`,
        nodeId: node.nodeId,
        ownerShardNo: shardNo,
        // 目标分片取当前负载最低的分片，仅作为建议；计划生成时再次冻结。
        targetShardNo: pickLeastLoadedShard(stats, shardNo),
        load: node.load,
        status: 'SKEWED',
        reason: `所属分片${shardNo}倾斜比 ${stat.skewRatio} 超过阈值 ${rule.skewThreshold}`,
      })
    }
  })

  return {
    id: 0, // 由 store 分配持久化编号
    ruleId: rule.id,
    evaluatedAt: new Date().toISOString(),
    config: snapshot,
    stats,
    candidates,
    carriedMigrating: candidates.filter((candidate) => candidate.status === 'MIGRATING').length,
  }
}

function pickLeastLoadedShard(stats: ShardStat[], excludeShard: number): number {
  return stats.reduce((best, current) => {
    if (current.shardNo === excludeShard) {
      return best
    }
    return current.load < stats[best].load ? current.shardNo : best
  }, stats.find((stat) => stat.shardNo !== excludeShard)?.shardNo ?? 0)
}

/**
 * 基于一次已完成评估生成迁移计划（纯函数，只做构建与校验，不写状态）：
 * - 读取评估结果里的候选与配置快照，计划与草稿彻底解耦；
 * - 只纳入 SKEWED 候选，MIGRATING/BALANCED 不进入计划；
 * - 调用方（store）在所有校验通过后才一次性提交，杜绝半成品计划暴露。
 */
export function buildMigrationSteps(result: ShardResult): MigrationStep[] {
  return result.candidates
    .filter((candidate) => candidate.status === 'SKEWED')
    .map((candidate, index) => ({
      stepNo: index + 1,
      nodeId: candidate.nodeId,
      sourceShardNo: candidate.ownerShardNo,
      targetShardNo: candidate.targetShardNo,
      status: 'PENDING' as const,
      reason: candidate.reason,
    }))
}
