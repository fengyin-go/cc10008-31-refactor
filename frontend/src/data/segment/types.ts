/**
 * 数据分片领域的类型定义。
 *
 * 设计要点：
 * - 规则（SegmentRule）、分片结果（ShardResult）、迁移批次（MigrationBatch）是三类独立实体，
 *   各自有独立的生命周期，不再共用同一条通用动作链。
 * - 分片结果与迁移批次只通过 ruleId（数字编号）引用规则，绝不内嵌可变的规则本体，
 *   因此改草稿、改名称都不会污染已经生成的结果与计划。
 * - 迁移批次自带「生成时配置快照」，历史批次里的分片数量、迁移策略、触发条件永远是生成时的原值。
 */

/** 规则生命周期状态：与 modules.ts 中 segment 的状态集合保持一致。 */
export type SegmentStatus = '草稿' | '待校验' | '已启用' | '已停用'

/** 分片算法：算法只影响下一次分片计算，已经生成的候选归属不随算法切换而改变。 */
export type SegmentAlgorithm = 'HASH' | 'RANGE' | 'ROUND_ROBIN'

/** 再平衡触发条件：变化只写入规则本体，下一次生成计划时才被读取。 */
export type RebalanceTrigger = 'AUTO' | 'MANUAL'

/** 倾斜候选的判定状态。 */
export type SkewStatus = 'SKEWED' | 'BALANCED' | 'MIGRATING'

/** 迁移步骤状态：失败后节点回到原分片并保留迁移原因作为失败证据。 */
export type MigrationStepStatus = 'PENDING' | 'DONE' | 'FAILED'

/** 领域操作的统一返回，和通用 ActionResult 形状一致，页面可以直接渲染 message。 */
export type SegmentActionResult = {
  ok: boolean
  message: string
}

/** 规则可编辑的配置部分；草稿态改的是这部分，启用态只读。 */
export type SegmentRuleDraft = {
  name: string
  targetDataset: string
  shardField: string
  algorithm: SegmentAlgorithm
  shardCount: number
  skewThreshold: number
  rebalanceTrigger: RebalanceTrigger
  migrationStrategy: string
}

/** 分片规则实体。id 是全生命周期稳定身份，历史结果只按它引用。 */
export type SegmentRule = SegmentRuleDraft & {
  id: number
  code: string
  status: SegmentStatus
  createdAt: string
  updatedAt: string
}

/**
 * 生成迁移计划时冻结的配置快照。
 * 历史批次永远展示快照里的分片数量与迁移策略，规则之后怎么改都不影响它。
 */
export type SegmentConfigSnapshot = {
  algorithm: SegmentAlgorithm
  shardCount: number
  skewThreshold: number
  rebalanceTrigger: RebalanceTrigger
  migrationStrategy: string
}

/** 单个分片的统计。 */
export type ShardStat = {
  shardNo: number
  nodeCount: number
  load: number
  averageLoad: number
  skewRatio: number
  skewed: boolean
}

/** 分片上的节点（倾斜候选的载体）。 */
export type ShardNode = {
  nodeId: string
  ownerShardNo: number
  load: number
}

/** 倾斜候选：归属（ownerShardNo）在生成时确定，算法切换不会回改它。 */
export type SkewCandidate = {
  candidateKey: string
  nodeId: string
  ownerShardNo: number
  targetShardNo: number
  load: number
  status: SkewStatus
  /** 判定/迁移原因，作为失败回退后仍需保留的证据。 */
  reason: string
  failureReason?: string
}

/**
 * 一次分片/倾斜评估的不可变结果。
 * config 内嵌本次评估读取到的配置，旧分片数量在历史结果里保持原值。
 */
export type ShardResult = {
  id: number
  ruleId: number
  evaluatedAt: string
  config: SegmentConfigSnapshot
  stats: ShardStat[]
  candidates: SkewCandidate[]
  /** 评估时正在迁移、被强制原样携带的候选数，证明「迁移中不能重判已平衡」。 */
  carriedMigrating: number
}

/** 批次内的单个迁移步骤；失败时节点回到原分片，原因保留在步骤上。 */
export type MigrationStep = {
  stepNo: number
  nodeId: string
  sourceShardNo: number
  targetShardNo: number
  status: MigrationStepStatus
  reason: string
  failureReason?: string
  finishedAt?: string
}

/** 再平衡迁移批次（历史迁移批次）。停用规则后批次仍可查，但不能再新建。 */
export type MigrationBatch = {
  id: number
  code: string
  ruleId: number
  /** 仅用于列表展示的冗余名称；引用身份仍是 ruleId，规则改名不影响批次归属。 */
  ruleName: string
  createdAt: string
  status: 'PLANNED' | 'RUNNING' | 'DONE' | 'FAILED'
  trigger: RebalanceTrigger
  /** 生成时冻结的策略与分片数量，历史批次保持原值。 */
  snapshot: SegmentConfigSnapshot
  steps: MigrationStep[]
}

/** 分片领域的完整持久化状态。 */
export type SegmentState = {
  rules: SegmentRule[]
  results: ShardResult[]
  batches: MigrationBatch[]
  seq: { rule: number; result: number; batch: number }
}
