/**
 * 分片领域持久化与命令入口。
 *
 * 与通用 local-store 分开存放（独立 localStorage 键），因为分片领域的状态结构
 * （规则/结果/批次三类实体）与通用 EntryRow 不同。
 *
 * 原子提交：任何命令都先在克隆状态上完成全部校验与变更，最后才一次性落盘；
 * 落盘抛错时内存状态整体回滚到提交前，规则与迁移计划不会出现一个改了、一个没改的中间态。
 */
import {
  assertNameUnique,
  assertNoMigratingCandidate,
  assertRuleActive,
  assertRuleDeletable,
  assertRuleExists,
  assertTransition,
  buildMigrationSteps,
  evaluateShards,
  fail,
  findBatch,
  findRule,
  ok,
  validateDraft,
} from './policy'
import { buildSegmentSeed } from './seed'
import type {
  MigrationBatch,
  SegmentActionResult,
  SegmentRule,
  SegmentRuleDraft,
  SegmentState,
  SegmentStatus,
  ShardNode,
  ShardResult,
} from './types'

const STORAGE_KEY = 'interactive-analytics-lab:segment'

/** 导出存储键，便于测试注入历史脏数据。 */
export { STORAGE_KEY as SEGMENT_STORAGE_KEY }

/** 可替换的存储驱动：生产用 localStorage，单测注入内存驱动并可模拟写入失败。 */
export interface SegmentStorageDriver {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const browserDriver: SegmentStorageDriver = {
  getItem: (key) => (typeof window !== 'undefined' && window.localStorage
    ? window.localStorage.getItem(key)
    : null),
  setItem: (key, value) => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value)
    }
  },
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let driver: SegmentStorageDriver = browserDriver
let cache: SegmentState | null = null

/** 仅供测试切换驱动（含模拟写入失败），生产代码不要调用。 */
export function __setSegmentDriver(next: SegmentStorageDriver | null): void {
  driver = next ?? browserDriver
  cache = null
}

export function loadState(): SegmentState {
  if (cache) {
    return cache
  }
  const raw = driver.getItem(STORAGE_KEY)
  if (raw) {
    try {
      cache = JSON.parse(raw) as SegmentState
      return cache
    } catch {
      // 存储损坏时回落到种子数据，和通用数据层的容错策略一致。
    }
  }
  cache = buildSegmentSeed()
  persist(cache)
  return cache
}

function persist(state: SegmentState): void {
  driver.setItem(STORAGE_KEY, JSON.stringify(state))
}

/**
 * 原子提交器：
 * 1. 克隆当前状态交给 mutator 做校验+变更，校验失败直接返回、不触碰旧状态；
 * 2. 校验通过后落盘，落盘抛错则丢弃克隆、保留提交前内存状态——多实体一起回到旧状态。
 */
function commit(mutator: (draft: SegmentState) => SegmentActionResult): SegmentActionResult {
  const previous = loadState()
  const draft = clone(previous)
  const result = mutator(draft)
  if (!result.ok) {
    return result
  }
  try {
    persist(draft)
  } catch (error) {
    cache = previous
    return fail(`保存失败，已整体回滚到修改前状态：${error instanceof Error ? error.message : '未知错误'}`)
  }
  cache = draft
  return result
}

/* ------------------------------------------------------------------ */
/* 查询：停用规则的历史结果与批次照常可查                                */
/* ------------------------------------------------------------------ */

export function listRules(): SegmentRule[] {
  return loadState().rules
}

export function getRule(ruleId: number): SegmentRule | undefined {
  return findRule(loadState().rules, ruleId)
}

export function listResults(ruleId?: number): ShardResult[] {
  const results = loadState().results
  return typeof ruleId === 'number' ? results.filter((result) => result.ruleId === ruleId) : results
}

export function latestResult(ruleId: number): ShardResult | undefined {
  return listResults(ruleId).slice(-1)[0]
}

export function listBatches(ruleId?: number): MigrationBatch[] {
  const batches = loadState().batches
  return typeof ruleId === 'number' ? batches.filter((batch) => batch.ruleId === ruleId) : batches
}

export function getBatch(batchId: number): MigrationBatch | undefined {
  return findBatch(loadState().batches, batchId)
}

/* ------------------------------------------------------------------ */
/* 规则命令链：草稿保存 / 状态流转 / 删除——与迁移计划彻底分开            */
/* ------------------------------------------------------------------ */

/** 新建或保存草稿。名称查重与字段校验全部通过才落盘，失败时状态不变。 */
export function saveDraft(ruleId: number | null, draft: SegmentRuleDraft): SegmentActionResult {
  const draftCheck = validateDraft(draft)
  if (!draftCheck.ok) {
    return draftCheck
  }
  return commit((state) => {
    const nameCheck = assertNameUnique(state.rules, draft.name.trim(), ruleId)
    if (!nameCheck.ok) {
      return nameCheck
    }
    const now = new Date().toISOString()
    if (ruleId === null) {
      const id = state.seq.rule + 1
      state.seq.rule = id
      state.rules.push({
        ...draft,
        name: draft.name.trim(),
        id,
        code: `SEGM-${String(id).padStart(4, '0')}`,
        status: '草稿',
        createdAt: now,
        updatedAt: now,
      })
      return ok(`分片规则「${draft.name.trim()}」已保存为草稿`)
    }
    const rule = findRule(state.rules, ruleId)
    const exists = assertRuleExists(state.rules, ruleId)
    if (!exists.ok || !rule) {
      return exists
    }
    if (rule.status !== '草稿') {
      return fail(`只有草稿规则允许编辑，「${rule.name}」当前为「${rule.status}」`)
    }
    Object.assign(rule, { ...draft, name: draft.name.trim(), updatedAt: now })
    return ok(`草稿规则「${rule.name}」已更新，既有分片结果与迁移计划不受影响`)
  })
}

/** 规则状态流转（提交校验/启用/停用/退回）。启用前按当前配置重新校验一遍。 */
export function transitionRule(ruleId: number, target: SegmentStatus): SegmentActionResult {
  return commit((state) => {
    const rule = findRule(state.rules, ruleId)
    const exists = assertRuleExists(state.rules, ruleId)
    if (!exists.ok || !rule) {
      return exists
    }
    const transition = assertTransition(rule, target)
    if (!transition.ok) {
      return transition
    }
    // 恢复启用（待校验→已启用）时按当前倾斜阈值等配置重新校验，配置不合法不允许启用。
    if (target === '已启用') {
      const recheck = validateDraft(rule)
      if (!recheck.ok) {
        return fail(`恢复启用前校验未通过：${recheck.message}`)
      }
    }
    rule.status = target
    rule.updatedAt = new Date().toISOString()
    return ok(`规则「${rule.name}」已流转为「${target}」`)
  })
}

/**
 * 删除草稿规则：只删除规则本体。
 * 已经被引用的历史分片结果、迁移批次按 ruleId 原样保留，绝不级联删除。
 */
export function deleteDraftRule(ruleId: number): SegmentActionResult {
  return commit((state) => {
    const rule = findRule(state.rules, ruleId)
    const exists = assertRuleExists(state.rules, ruleId)
    if (!exists.ok || !rule) {
      return exists
    }
    const deletable = assertRuleDeletable(rule)
    if (!deletable.ok) {
      return deletable
    }
    state.rules = state.rules.filter((item) => item.id !== ruleId)
    return ok(`草稿规则「${rule.name}」已删除，其历史迁移批次与分片结果保留可查`)
  })
}

/* ------------------------------------------------------------------ */
/* 分片/倾斜评估：独立于迁移计划，结果不可变、内嵌配置快照               */
/* ------------------------------------------------------------------ */

export function evaluateRule(ruleId: number, nodes: ShardNode[]): SegmentActionResult {
  const rule = getRule(ruleId)
  if (!rule) {
    return assertRuleExists(listRules(), ruleId)
  }
  const active = assertRuleActive(rule)
  if (!active.ok) {
    return active
  }
  return commit((state) => {
    const current = findRule(state.rules, ruleId)
    if (!current) {
      return fail(`没有找到编号为 ${ruleId} 的分片规则`)
    }
    const previous = state.results.filter((result) => result.ruleId === ruleId).slice(-1)[0]
    const evaluated = evaluateShards({ rule: current, nodes, previous })
    const id = state.seq.result + 1
    state.seq.result = id
    state.results.push({ ...evaluated, id })
    return ok(`已按当前阈值 ${current.skewThreshold} 完成分片评估，倾斜候选 ${evaluated.candidates.length} 个`)
  })
}

/* ------------------------------------------------------------------ */
/* 迁移命令链：计划生成 / 执行 / 失败回退——与规则链共用同一套守卫        */
/* ------------------------------------------------------------------ */

/**
 * 生成迁移计划：
 * - 停用规则直接拒绝（assertRuleActive），但历史批次仍可通过 listBatches 查询；
 * - 有候选正在迁移时拒绝，防止同一候选被重复编排；
 * - 全部校验通过后一次性写入批次，生成到一半的半成品不会出现在状态里。
 */
export function generateMigrationPlan(ruleId: number): SegmentActionResult {
  const rule = getRule(ruleId)
  if (!rule) {
    return assertRuleExists(listRules(), ruleId)
  }
  const active = assertRuleActive(rule)
  if (!active.ok) {
    return active
  }
  const blocked = assertNoMigratingCandidate(latestResult(ruleId))
  if (!blocked.ok) {
    return blocked
  }
  const result = latestResult(ruleId)
  if (!result) {
    return fail('还没有分片评估结果，请先执行分片评估再生成迁移计划')
  }
  const steps = buildMigrationSteps(result)
  if (steps.length === 0) {
    return fail('当前没有 SKEWED 倾斜候选，无需生成迁移计划')
  }
  return commit((state) => {
    const current = findRule(state.rules, ruleId)
    if (!current) {
      return fail(`没有找到编号为 ${ruleId} 的分片规则`)
    }
    // 提交阶段再次确认规则仍处于启用态，避免评估与生成之间被停用。
    const stillActive = assertRuleActive(current)
    if (!stillActive.ok) {
      return stillActive
    }
    const id = state.seq.batch + 1
    state.seq.batch = id
    const batch: MigrationBatch = {
      id,
      code: `MIG-${String(id).padStart(4, '0')}`,
      ruleId,
      ruleName: current.name,
      createdAt: new Date().toISOString(),
      status: 'PLANNED',
      // 快照冻结：历史批次里的分片数量、迁移策略、触发条件保持生成时原值。
      trigger: result.config.rebalanceTrigger,
      snapshot: clone(result.config),
      steps: clone(steps),
    }
    state.batches.push(batch)
    return ok(`迁移计划 ${batch.code} 已生成，共 ${steps.length} 个步骤，配置已冻结为生成时快照`)
  })
}

type StepOutcome = { ok: boolean; failureReason?: string }

/**
 * 执行迁移批次的下一步：
 * - 成功：步骤 DONE，对应候选判定为 BALANCED（归属切到目标分片）；
 * - 失败：步骤 FAILED 并保留原因，候选回到原分片、状态退回 SKEWED，迁移原因与失败原因都留证。
 */
export function advanceMigration(batchId: number, outcome: StepOutcome = { ok: true }): SegmentActionResult {
  return commit((state) => {
    const batch = findBatch(state.batches, batchId)
    if (!batch) {
      return fail(`没有找到编号为 ${batchId} 的迁移批次`)
    }
    if (batch.status === 'DONE' || batch.status === 'FAILED') {
      return fail(`迁移批次 ${batch.code} 已结束（${batch.status}），不能继续执行`)
    }
    const step = batch.steps.find((item) => item.status === 'PENDING')
    if (!step) {
      return fail(`批次 ${batch.code} 没有待执行步骤`)
    }
    const now = new Date().toISOString()
    batch.status = 'RUNNING'
    step.finishedAt = now

    const result = state.results
      .filter((item) => item.ruleId === batch.ruleId)
      .slice(-1)[0]
    const candidate = result?.candidates.find((item) => item.nodeId === step.nodeId)

    if (!outcome.ok) {
      step.status = 'FAILED'
      step.failureReason = outcome.failureReason ?? '节点迁移失败'
      if (candidate) {
        // 失败节点回到原分片，保留迁移原因，状态退回倾斜，等待下次再平衡。
        candidate.ownerShardNo = step.sourceShardNo
        candidate.status = 'SKEWED'
        candidate.failureReason = step.failureReason
      }
      batch.status = 'FAILED'
      return ok(`步骤 ${step.stepNo} 失败：节点 ${step.nodeId} 已回到原分片 ${step.sourceShardNo}，迁移原因已保留`)
    }

    step.status = 'DONE'
    if (candidate) {
      candidate.ownerShardNo = step.targetShardNo
      candidate.status = 'BALANCED'
      candidate.failureReason = undefined
    }
    if (batch.steps.every((item) => item.status === 'DONE')) {
      batch.status = 'DONE'
    }
    return ok(`步骤 ${step.stepNo} 完成：节点 ${step.nodeId} 已迁移到分片 ${step.targetShardNo}`)
  })
}

/** 测试/重置辅助：恢复种子状态。 */
export function resetSegmentState(): SegmentState {
  const seeded = buildSegmentSeed()
  cache = seeded
  persist(seeded)
  return seeded
}
