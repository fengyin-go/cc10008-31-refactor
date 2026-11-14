/**
 * 分片领域种子数据。
 *
 * 不直接手写结果/批次，而是用 policy 里的纯函数生成，保证种子数据本身就满足
 * 「迁移中候选不重判」「快照冻结」等全部不变量。节点负载是确定性的，刷新后结果可复现。
 */
import { buildMigrationSteps, evaluateShards } from './policy'
import type {
  MigrationBatch,
  SegmentRule,
  SegmentState,
  ShardNode,
  ShardResult,
} from './types'

const SEED_TIME = '2026-11-01T08:00:00.000Z'

/** 构造确定性的节点样本：负载按固定周期起伏，便于在部分分片上制造倾斜。 */
function buildNodes(prefix: string, count: number): ShardNode[] {
  return Array.from({ length: count }, (_, index) => ({
    nodeId: `${prefix}-NODE-${String(index + 1).padStart(3, '0')}`,
    ownerShardNo: 0,
    load: 10 + (index % 4) * 12 + (index % 7) * 3,
  }))
}

function rule(
  id: number,
  name: string,
  status: SegmentRule['status'],
  overrides: Partial<SegmentRule> = {},
): SegmentRule {
  return {
    id,
    code: `SEGM-${String(id).padStart(4, '0')}`,
    status,
    name,
    targetDataset: `数据集-${id}`,
    shardField: 'tenant_id',
    algorithm: 'HASH',
    shardCount: 4,
    skewThreshold: 1.3,
    rebalanceTrigger: 'AUTO',
    migrationStrategy: 'COPY_FIRST',
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    ...overrides,
  }
}

export function buildSegmentSeed(): SegmentState {
  const rules: SegmentRule[] = [
    rule(1, '订单租户分片（草稿）', '草稿', {
      targetDataset: '订单明细',
      rebalanceTrigger: 'MANUAL',
      migrationStrategy: 'DIRECT_MOVE',
    }),
    rule(2, '日志租户分片（停用）', '已停用', {
      targetDataset: '访问日志',
      algorithm: 'HASH',
      shardCount: 4,
      skewThreshold: 1.2,
      rebalanceTrigger: 'MANUAL',
      migrationStrategy: 'DUAL_WRITE',
    }),
    rule(3, '画像租户分片（启用）', '已启用', {
      targetDataset: '用户画像',
      algorithm: 'HASH',
      shardCount: 4,
      skewThreshold: 1.3,
      rebalanceTrigger: 'AUTO',
      migrationStrategy: 'COPY_FIRST',
    }),
  ]

  const results: ShardResult[] = []
  const batches: MigrationBatch[] = []
  let resultSeq = 0
  let batchSeq = 0

  // 停用规则 2：保留一份历史结果与一个已完成批次，证明停用后旧任务仍可查。
  const rule2 = rules[1]
  const nodes2 = buildNodes('R2', 14)
  const result2Raw = evaluateShards({ rule: rule2, nodes: nodes2 })
  resultSeq += 1
  const result2: ShardResult = { ...result2Raw, id: resultSeq, evaluatedAt: SEED_TIME }
  results.push(result2)

  if (result2.candidates.length > 0) {
    const steps2 = buildMigrationSteps(result2)
    batchSeq += 1
    batches.push({
      id: batchSeq,
      code: `MIG-${String(batchSeq).padStart(4, '0')}`,
      ruleId: rule2.id,
      ruleName: rule2.name,
      createdAt: SEED_TIME,
      status: 'DONE',
      trigger: rule2.rebalanceTrigger,
      snapshot: { ...result2.config },
      steps: steps2.map((step) => ({
        ...step,
        status: 'DONE',
        finishedAt: SEED_TIME,
      })),
    })
  }

  // 启用规则 3：一次评估 + 一个运行中的批次，其中保留一个 MIGRATING 候选作为「迁移中」样本。
  const rule3 = rules[2]
  const nodes3 = buildNodes('R3', 20)
  const result3Raw = evaluateShards({ rule: rule3, nodes: nodes3 })
  resultSeq += 1
  const result3: ShardResult = { ...result3Raw, id: resultSeq, evaluatedAt: SEED_TIME }
  results.push(result3)

  const steps3 = buildMigrationSteps(result3)
  if (steps3.length > 0) {
    // 第一个步骤保持 PENDING，并把对应候选标记为 MIGRATING，其余步骤已完成。
    const [first, ...rest] = steps3
    const migrating = result3.candidates.find((candidate) => candidate.nodeId === first.nodeId)
    if (migrating) {
      migrating.status = 'MIGRATING'
      migrating.reason = `${migrating.reason}（迁移进行中，禁止重判为已平衡）`
    }
    rest.forEach((step) => {
      const candidate = result3.candidates.find((item) => item.nodeId === step.nodeId)
      step.status = 'DONE'
      step.finishedAt = SEED_TIME
      if (candidate) {
        candidate.status = 'BALANCED'
        candidate.ownerShardNo = step.targetShardNo
      }
    })
    batchSeq += 1
    batches.push({
      id: batchSeq,
      code: `MIG-${String(batchSeq).padStart(4, '0')}`,
      ruleId: rule3.id,
      ruleName: rule3.name,
      createdAt: SEED_TIME,
      status: 'RUNNING',
      trigger: rule3.rebalanceTrigger,
      snapshot: { ...result3.config },
      steps: [first, ...rest],
    })
  }

  return {
    rules,
    results,
    batches,
    seq: { rule: rules.length, result: resultSeq, batch: batchSeq },
  }
}
